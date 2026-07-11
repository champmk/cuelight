//! The run engine: executes a stage live. Sessions spawn through the harness
//! adapters, every event is emitted to the canvas and journaled, kill gates
//! run at node boundaries, human gates park the branch until the operator
//! decides in the Review view.
//!
//! v1 semantics (deliberate):
//! - One run at a time.
//! - A chain of agent nodes shares one worktree so reviewers see the diff.
//! - Pause stops NEW sessions from scheduling; running sessions finish.
//! - Return edges terminate the pass (loops re-arm on the next run).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::{oneshot, Mutex};

use crate::adapters::{claude::ClaudeAdapter, grok::GrokAdapter, HarnessAdapter, SessionSpec};
use crate::conductor::journal::Journal;
use crate::conductor::scheduler::{evaluate_kill_gate, Worktrees};
use crate::conductor::stage::{GateMode, Node, NodeType, Stage};
use crate::conductor::{compose_prompt, min_permissions};
use crate::events::{RunEvent, SessionEvent};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardInfo {
    pub prompt: String,
    pub permissions: String,
    pub harness: String,
    pub model: Option<String>,
    pub effort: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineEvent {
    NodeState {
        run_id: String,
        node_id: String,
        cue: String,
        detail: String,
        worktree: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        diagnosis: Option<String>,
    },
    /// A node failed and escalation opened: inject a check node + human gate.
    EscalationOpened {
        run_id: String,
        failed_node: String,
        check_node: String,
        gate_node: String,
        reason: String,
        diagnosis: String,
    },
    /// Escalation resolved (retry or give up): collapse the temp nodes away.
    EscalationClosed {
        run_id: String,
        failed_node: String,
        check_node: String,
        gate_node: String,
        retried: bool,
    },
    Session {
        run_id: String,
        node_id: String,
        event: SessionEvent,
    },
    GatePending {
        run_id: String,
        node_id: String,
        worktree: Option<String>,
        case_text: String,
        checklist: Vec<String>,
        outward: bool,
    },
    RunFinished {
        run_id: String,
        status: String,
    },
}

#[derive(Debug, Deserialize)]
pub struct GateDecision {
    pub approve: bool,
    pub memo: Option<String>,
}

#[derive(Default)]
pub struct Engine {
    pub gates: Mutex<HashMap<String, oneshot::Sender<GateDecision>>>,
    pub cancels: Mutex<HashMap<String, oneshot::Sender<()>>>,
    pub paused: AtomicBool,
    pub running: AtomicBool,
    pub stopped: AtomicBool,
    /// (session id, worktree) per run:node, for follow-up nudges.
    pub sessions: Mutex<HashMap<String, (String, String)>>,
    /// App handle + current run id, so nudges can stream into the canvas.
    pub app: Mutex<Option<tauri::AppHandle>>,
    pub run_id: Mutex<Option<String>>,
}

impl Engine {
    /// Hard-stop the active run: cancel every live session, reject every
    /// pending gate, and let the scheduled tasks unwind at their boundaries.
    pub async fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.paused.store(false, Ordering::SeqCst); // unblock paused waiters so they can exit
        for (_, tx) in self.cancels.lock().await.drain() {
            let _ = tx.send(());
        }
        for (_, tx) in self.gates.lock().await.drain() {
            let _ = tx.send(GateDecision { approve: false, memo: Some("run stopped".into()) });
        }
    }
}

struct RunCtx {
    app: tauri::AppHandle,
    engine: Arc<Engine>,
    stage: Stage,
    cards: HashMap<String, CardInfo>,
    run_id: String,
    repo: PathBuf,
    goal: String,
    journal: Option<Mutex<Journal>>,
    seq: AtomicU64,
    active: AtomicUsize,
}

impl RunCtx {
    fn emit(&self, ev: EngineEvent) {
        let _ = self.app.emit("engine-event", &ev);
    }

    fn journal_session(&self, node_id: &str, session_id: &str, ev: &SessionEvent) {
        if let Some(j) = &self.journal {
            let re = RunEvent {
                run_id: self.run_id.clone(),
                node_id: node_id.to_string(),
                session_id: session_id.to_string(),
                seq: self.seq.fetch_add(1, Ordering::Relaxed),
                at: chrono::Utc::now(),
                event: ev.clone(),
            };
            if let Ok(j) = j.try_lock() {
                let _ = j.append(&re);
            }
        }
    }

    fn node(&self, id: &str) -> Option<Node> {
        self.stage.nodes.iter().find(|n| n.id == id).cloned()
    }

    fn next_flow(&self, from: &str) -> Vec<String> {
        self.stage
            .edges
            .iter()
            .filter(|e| e.from == from && e.kind == "flow")
            .map(|e| e.to.clone())
            .collect()
    }
}

pub fn start(
    app: tauri::AppHandle,
    engine: Arc<Engine>,
    stage: Stage,
    cards: HashMap<String, CardInfo>,
    repo: PathBuf,
    goal: String,
) -> Result<String, String> {
    if engine.running.swap(true, Ordering::SeqCst) {
        return Err("a run is already active — finish or stop it first".into());
    }
    engine.stopped.store(false, Ordering::SeqCst);
    engine.paused.store(false, Ordering::SeqCst);
    stage.validate().map_err(|e| {
        engine.running.store(false, Ordering::SeqCst);
        e.to_string()
    })?;

    let run_id = uuid::Uuid::new_v4().to_string();
    let journal = {
        let dir = repo.join(".cuelight");
        std::fs::create_dir_all(&dir).ok();
        Journal::open(&dir.join("journal.sqlite")).ok().map(Mutex::new)
    };
    if let Some(j) = &journal {
        if let Ok(j) = j.try_lock() {
            let _ = j.start_run(&run_id, &stage.name, &serde_json::to_string(&stage).unwrap_or_default());
        }
    }

    let ctx = Arc::new(RunCtx {
        app,
        engine: engine.clone(),
        stage,
        cards,
        run_id: run_id.clone(),
        repo,
        goal,
        journal,
        seq: AtomicU64::new(0),
        active: AtomicUsize::new(0),
    });

    // Entry nodes: no incoming flow edge.
    let entries: Vec<String> = ctx
        .stage
        .nodes
        .iter()
        .filter(|n| !ctx.stage.edges.iter().any(|e| e.to == n.id && e.kind == "flow"))
        .map(|n| n.id.clone())
        .collect();

    // Expose the handle + run id so nudges can stream into this run.
    if let Ok(mut a) = engine.app.try_lock() {
        *a = Some(ctx.app.clone());
    }
    if let Ok(mut r) = engine.run_id.try_lock() {
        *r = Some(run_id.clone());
    }
    engine.sessions.try_lock().map(|mut s| s.clear()).ok();

    for id in entries {
        schedule(ctx.clone(), id, ctx.goal.clone(), None);
    }
    Ok(run_id)
}

/// Nudge a node's agent: resume its harness session with a follow-up message,
/// streaming the reply into that node's chat. Requires the node to have
/// completed at least one turn (so a resumable session id exists).
pub async fn nudge(engine: Arc<Engine>, node_id: String, text: String) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let run_id = engine.run_id.lock().await.clone().ok_or("no active run")?;
    let app = engine.app.lock().await.clone().ok_or("app unavailable")?;
    let key = format!("{run_id}:{node_id}");
    let (sid, wt) = engine
        .sessions
        .lock()
        .await
        .get(&key)
        .cloned()
        .ok_or("this agent hasn't finished a turn yet — nudge once it has")?;

    let emit = |ev: SessionEvent| {
        let _ = app.emit(
            "engine-event",
            &EngineEvent::Session { run_id: run_id.clone(), node_id: node_id.clone(), event: ev },
        );
    };
    emit(SessionEvent::Text { text: format!("[you] {text}") });
    emit(SessionEvent::ToolCall { tool: "nudge".into(), target: String::new() });

    let bin = crate::adapters::resolve_bin("grok");
    let mut child = tokio::process::Command::new(bin)
        .args(["-r", &sid, "-p", &text, "--output-format", "streaming-json", "--always-approve"])
        .current_dir(&wt)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(pid) = child.id() {
        crate::procjob::contain(pid);
    }
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut lines = BufReader::new(stdout).lines();
    let mut buf = String::new();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                let t = v.get("data").and_then(|d| d.as_str()).unwrap_or("");
                buf.push_str(t);
                if buf.len() > 90 || t.contains('\n') {
                    let chunk = std::mem::take(&mut buf).trim().to_string();
                    if !chunk.is_empty() {
                        emit(SessionEvent::Text { text: chunk });
                    }
                }
            }
            Some("end") => {
                if !buf.trim().is_empty() {
                    emit(SessionEvent::Text { text: buf.trim().to_string() });
                }
                if let Some(rid) = v.get("sessionId").and_then(|s| s.as_str()) {
                    engine.sessions.lock().await.insert(key.clone(), (rid.to_string(), wt.clone()));
                }
                break;
            }
            _ => {}
        }
    }
    Ok(())
}

fn schedule(ctx: Arc<RunCtx>, node_id: String, payload: String, worktree: Option<PathBuf>) {
    ctx.active.fetch_add(1, Ordering::SeqCst);
    // Tauri's runtime handle — works whether the caller is a sync or async
    // command. A bare tokio::spawn panics when start_run runs on the main
    // (non-runtime) thread.
    tauri::async_runtime::spawn(async move {
        // Honor pause at the boundary — never mid-session.
        while ctx.engine.paused.load(Ordering::SeqCst) && !ctx.engine.stopped.load(Ordering::SeqCst) {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        }
        // A stop between scheduling and running skips this node entirely.
        if !ctx.engine.stopped.load(Ordering::SeqCst) {
            run_node(ctx.clone(), &node_id, payload, worktree).await;
        }
        if ctx.active.fetch_sub(1, Ordering::SeqCst) == 1 {
            ctx.engine.running.store(false, Ordering::SeqCst);
            let stopped = ctx.engine.stopped.load(Ordering::SeqCst);
            let status = if stopped { "stopped" } else { "finished" };
            if let Some(j) = &ctx.journal {
                if let Ok(j) = j.try_lock() {
                    let _ = j.finish_run(&ctx.run_id, status);
                }
            }
            ctx.emit(EngineEvent::RunFinished { run_id: ctx.run_id.clone(), status: status.into() });
        }
    });
}

async fn run_node(ctx: Arc<RunCtx>, node_id: &str, payload: String, worktree: Option<PathBuf>) {
    let Some(node) = ctx.node(node_id) else { return };
    match node.node_type {
        NodeType::Gate => run_gate(ctx, &node, payload, worktree).await,
        NodeType::Agent => run_agent(ctx, &node, payload, worktree).await,
    }
}

async fn run_gate(ctx: Arc<RunCtx>, node: &Node, payload: String, worktree: Option<PathBuf>) {
    let cfg = node.gate.clone().unwrap_or(crate::conductor::stage::GateConfig {
        mode: GateMode::Human,
        outward: false,
        batch_limit_per_day: None,
        checklist: vec![],
    });

    if cfg.mode == GateMode::Auto {
        for next in ctx.next_flow(&node.id) {
            schedule(ctx.clone(), next, payload.clone(), worktree.clone());
        }
        return;
    }

    ctx.emit(EngineEvent::NodeState {
        run_id: ctx.run_id.clone(),
        node_id: node.id.clone(),
        cue: "standby".into(),
        detail: "awaiting your review".into(),
        worktree: worktree.as_ref().map(|w| w.to_string_lossy().to_string()),
                diagnosis: None,
    });
    ctx.emit(EngineEvent::GatePending {
        run_id: ctx.run_id.clone(),
        node_id: node.id.clone(),
        worktree: worktree.as_ref().map(|w| w.to_string_lossy().to_string()),
        case_text: payload.clone(),
        checklist: cfg.checklist.clone(),
        outward: cfg.outward,
    });

    let (tx, rx) = oneshot::channel::<GateDecision>();
    ctx.engine
        .gates
        .lock()
        .await
        .insert(format!("{}:{}", ctx.run_id, node.id), tx);

    let decision = rx.await.unwrap_or(GateDecision { approve: false, memo: Some("gate channel dropped".into()) });
    // A stop unblocks the gate with a reject — don't re-run upstream, just exit.
    if ctx.engine.stopped.load(Ordering::SeqCst) {
        ctx.emit(EngineEvent::NodeState {
            run_id: ctx.run_id.clone(),
            node_id: node.id.clone(),
            cue: "idle".into(),
            detail: "run stopped".into(),
            worktree: None,
                diagnosis: None,
        });
        return;
    }
    if let Some(j) = &ctx.journal {
        if let Ok(j) = j.try_lock() {
            let _ = j.record_gate(
                &ctx.run_id,
                &node.id,
                if decision.approve { "approved" } else { "changes_requested" },
                decision.memo.as_deref(),
            );
        }
    }

    if decision.approve {
        ctx.emit(EngineEvent::NodeState {
            run_id: ctx.run_id.clone(),
            node_id: node.id.clone(),
            cue: "idle".into(),
            detail: "approved".into(),
            worktree: None,
                diagnosis: None,
        });
        for next in ctx.next_flow(&node.id) {
            schedule(ctx.clone(), next, payload.clone(), worktree.clone());
        }
    } else {
        // Changes requested: the memo becomes a steering instruction for the
        // upstream agent, which re-runs in the same worktree.
        let memo = decision.memo.unwrap_or_default();
        ctx.emit(EngineEvent::NodeState {
            run_id: ctx.run_id.clone(),
            node_id: node.id.clone(),
            cue: "idle".into(),
            detail: "changes requested".into(),
            worktree: None,
                diagnosis: None,
        });
        let upstream: Option<String> = ctx
            .stage
            .edges
            .iter()
            .find(|e| e.to == node.id && e.kind == "flow")
            .map(|e| e.from.clone());
        if let (Some(up), false) = (upstream, memo.is_empty()) {
            let steer_payload = format!(
                "{payload}\n\n## Operator requested changes\n{memo}\nApply these changes in the current worktree, re-run the checks, and summarize what changed."
            );
            schedule(ctx.clone(), up, steer_payload, worktree.clone());
        }
    }
}

async fn run_agent(ctx: Arc<RunCtx>, node: &Node, payload: String, worktree: Option<PathBuf>) {
    let Some(card_name) = node.card.clone() else { return };
    let Some(card) = ctx.cards.get(&card_name).cloned() else {
        ctx.emit(EngineEvent::NodeState {
            run_id: ctx.run_id.clone(),
            node_id: node.id.clone(),
            cue: "failed".into(),
            detail: format!("unknown card {card_name}"),
            worktree: None,
            diagnosis: None,
        });
        return;
    };

    // Worktree: reuse the chain's, or create one for this branch.
    let wt = match worktree {
        Some(w) => w,
        None => {
            let wts = Worktrees::new(ctx.repo.clone());
            match wts.create(&ctx.run_id, &node.id) {
                Ok(p) => p,
                Err(e) => {
                    ctx.emit(EngineEvent::NodeState {
                        run_id: ctx.run_id.clone(),
                        node_id: node.id.clone(),
                        cue: "failed".into(),
                        detail: format!("worktree failed: {e}"),
                        worktree: None,
                        diagnosis: None,
                    });
                    return;
                }
            }
        }
    };

    let harness = node
        .harness
        .clone()
        .or(Some(card.harness.clone()))
        .filter(|h| h != "any")
        .or_else(|| ctx.stage.defaults.harness.clone())
        .unwrap_or_else(|| "grok".into());
    let permissions = min_permissions(&card.permissions, node.permissions.as_deref()).to_string();
    let max_attempts = 1 + node
        .kill_gates
        .iter()
        .filter(|g| g.on_fail == "retry")
        .map(|g| g.max_retries.unwrap_or(1))
        .max()
        .unwrap_or(0);

    let mut attempt = 0;
    loop {
        attempt += 1;
        let prompt = compose_prompt(&card.prompt, node.prompt_context.as_deref(), &payload);
        let spec = SessionSpec {
            prompt,
            workdir: wt.clone(),
            model: node.model.clone().or(card.model.clone()).or(ctx.stage.defaults.model.clone()),
            effort: node.effort.clone().or(card.effort.clone()).or(ctx.stage.defaults.effort.clone()),
            permissions: permissions.clone(),
        };

        ctx.emit(EngineEvent::NodeState {
            run_id: ctx.run_id.clone(),
            node_id: node.id.clone(),
            cue: "working".into(),
            detail: if attempt == 1 { format!("session starting ({harness})") } else { format!("retry {attempt}") },
            worktree: Some(wt.to_string_lossy().to_string()),
            diagnosis: None,
        });

        let adapter: Box<dyn HarnessAdapter> = if harness == "claude" { Box::new(ClaudeAdapter) } else { Box::new(GrokAdapter) };
        let handle = match adapter.spawn(spec).await {
            Ok(h) => h,
            Err(e) => {
                ctx.emit(EngineEvent::NodeState {
                    run_id: ctx.run_id.clone(),
                    node_id: node.id.clone(),
                    cue: "failed".into(),
                    detail: e.to_string(),
                    worktree: None,
                diagnosis: None,
                });
                return;
            }
        };

        let session_id = format!("{}-{}-a{attempt}", node.id, &ctx.run_id[..8]);
        ctx.engine
            .cancels
            .lock()
            .await
            .insert(format!("{}:{}", ctx.run_id, node.id), handle.cancel);

        let mut events = handle.events;
        let mut final_text = String::new();
        let mut structured: Option<serde_json::Value> = None;
        let mut failed = false;
        while let Some(ev) = events.recv().await {
            ctx.journal_session(&node.id, &session_id, &ev);
            match &ev {
                SessionEvent::Done { ok, result_text, structured: s, resume_id } => {
                    final_text = result_text.clone();
                    structured = s.clone();
                    failed = !ok;
                    if let Some(rid) = resume_id {
                        ctx.engine
                            .sessions
                            .lock()
                            .await
                            .insert(format!("{}:{}", ctx.run_id, node.id), (rid.clone(), wt.to_string_lossy().to_string()));
                    }
                }
                SessionEvent::Failed { .. } => failed = true,
                _ => {}
            }
            ctx.emit(EngineEvent::Session { run_id: ctx.run_id.clone(), node_id: node.id.clone(), event: ev });
        }
        ctx.engine.cancels.lock().await.remove(&format!("{}:{}", ctx.run_id, node.id));

        // Kill gates at the boundary.
        let mut gate_fail: Option<String> = None;
        if !failed {
            for g in &node.kill_gates {
                if !evaluate_kill_gate(g, &wt, structured.as_ref()) {
                    gate_fail = Some(format!("{} {}", g.check, g.arg.clone().unwrap_or_default()));
                    break;
                }
            }
        }

        if failed || gate_fail.is_some() {
            if attempt < max_attempts as usize {
                continue;
            }
            let reason = gate_fail.clone().unwrap_or_else(|| "session ended with failure".into());
            // Escalate to a human: diagnose with a fast model, inject a check
            // node + resolution gate, and wait. Approve → retry the stage.
            if escalate(&ctx, node, &reason, &wt, &final_text).await {
                attempt = 0;
                continue;
            }
            return;
        }

        ctx.emit(EngineEvent::NodeState {
            run_id: ctx.run_id.clone(),
            node_id: node.id.clone(),
            cue: "idle".into(),
            detail: "done".into(),
            worktree: Some(wt.to_string_lossy().to_string()),
                diagnosis: None,
        });
        for next in ctx.next_flow(&node.id) {
            schedule(ctx.clone(), next, final_text.clone(), Some(wt.clone()));
        }
        return;
    }
}

/// When a node fails, escalate to a human: run a fast-model check agent that
/// diagnoses the failure, inject a check node + resolution gate into the live
/// graph, and park until the operator decides. Returns true to retry the node.
async fn escalate(ctx: &Arc<RunCtx>, node: &Node, reason: &str, wt: &PathBuf, last_output: &str) -> bool {
    let check_node = format!("{}__check", node.id);
    let gate_node = format!("{}__resolve", node.id);
    let wt_s = wt.to_string_lossy().to_string();

    let state = |id: &str, cue: &str, detail: String, wt: Option<String>, diag: Option<String>| {
        ctx.emit(EngineEvent::NodeState {
            run_id: ctx.run_id.clone(),
            node_id: id.to_string(),
            cue: cue.to_string(),
            detail,
            worktree: wt,
            diagnosis: diag,
        });
    };

    // Mark the failed node, then inject the two temporary nodes.
    state(&node.id, "failed", reason.to_string(), Some(wt_s.clone()), None);
    ctx.emit(EngineEvent::EscalationOpened {
        run_id: ctx.run_id.clone(),
        failed_node: node.id.clone(),
        check_node: check_node.clone(),
        gate_node: gate_node.clone(),
        reason: reason.to_string(),
        diagnosis: String::new(),
    });

    // Check agent: fast-model diagnosis.
    state(&check_node, "working", "diagnosing the failure…".into(), Some(wt_s.clone()), None);
    let diagnosis = diagnose(node, reason, wt, last_output).await;
    ctx.emit(EngineEvent::Session {
        run_id: ctx.run_id.clone(),
        node_id: check_node.clone(),
        event: SessionEvent::Text { text: diagnosis.clone() },
    });
    state(&check_node, "idle", "diagnosis ready".into(), Some(wt_s.clone()), Some(diagnosis.clone()));
    // Attach the diagnosis to the failed node so its card explains itself.
    state(&node.id, "failed", reason.to_string(), Some(wt_s.clone()), Some(diagnosis.clone()));

    // Human resolution gate.
    state(&gate_node, "standby", "awaiting your resolution".into(), Some(wt_s.clone()), None);
    let case = format!(
        "The `{}` step failed.\n\nReason: {}\n\nDiagnosis:\n{}\n\nFix anything needed in the worktree, then Approve to retry this step — or Skip to abandon it.",
        node.label.clone().unwrap_or_else(|| node.id.clone()),
        reason,
        diagnosis
    );
    ctx.emit(EngineEvent::GatePending {
        run_id: ctx.run_id.clone(),
        node_id: gate_node.clone(),
        worktree: Some(wt_s.clone()),
        case_text: case,
        checklist: vec![
            "Read the diagnosis".into(),
            "Apply any external fix in the worktree".into(),
            "Approve to retry the step".into(),
        ],
        outward: false,
    });

    let (tx, rx) = oneshot::channel::<GateDecision>();
    ctx.engine
        .gates
        .lock()
        .await
        .insert(format!("{}:{}", ctx.run_id, gate_node), tx);
    let decision = rx.await.unwrap_or(GateDecision { approve: false, memo: None });
    let retried = decision.approve && !ctx.engine.stopped.load(Ordering::SeqCst);

    ctx.emit(EngineEvent::EscalationClosed {
        run_id: ctx.run_id.clone(),
        failed_node: node.id.clone(),
        check_node,
        gate_node,
        retried,
    });
    if retried {
        state(&node.id, "idle", "retrying…".into(), Some(wt_s), None);
    }
    retried
}

/// Fast-model failure diagnosis (grok-composer-2.5-fast, plain output).
async fn diagnose(node: &Node, reason: &str, wt: &PathBuf, last_output: &str) -> String {
    let role = node.label.clone().unwrap_or_else(|| node.id.clone());
    let tail: String = {
        let s = last_output.trim();
        let start = s.len().saturating_sub(1400);
        s[start..].to_string()
    };
    let prompt = format!(
        "A step in an automated coding workflow failed. Diagnose it concisely.\n\nStep role: {role}\nWhat it was told to do: {}\nFailure reason: {reason}\nRecent agent output (tail):\n{tail}\n\nIn 2-4 sentences of plain language: the most likely cause and the concrete fix. No preamble, no restating the question.",
        node.prompt_context.clone().unwrap_or_else(|| "(no extra context)".into())
    );

    let bin = crate::adapters::resolve_bin("grok");
    let fut = tokio::process::Command::new(bin)
        .arg("-p")
        .arg(&prompt)
        .args(["--model", "grok-composer-2.5-fast", "--output-format", "plain"])
        .current_dir(wt)
        .output();
    match tokio::time::timeout(std::time::Duration::from_secs(90), fut).await {
        Ok(Ok(out)) => {
            let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if text.is_empty() {
                format!("Diagnosis unavailable. Raw reason: {reason}")
            } else {
                text
            }
        }
        _ => format!("Diagnosis timed out. Raw reason: {reason}"),
    }
}
