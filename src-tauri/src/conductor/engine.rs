//! The run engine: executes a stage live. Sessions spawn through the harness
//! adapters, every event is emitted to the canvas and journaled, kill gates
//! run at node boundaries, human gates park the branch until the operator
//! decides in the Review view.
//!
//! Semantics (deliberate):
//! - Runs are concurrent: each holds its own RunHandle; stop/pause are
//!   per-run. A global agent-slot cap queues sessions past max_parallel.
//! - A chain of agent nodes shares one worktree so reviewers see the diff.
//! - Pause stops NEW sessions from scheduling; running sessions finish.
//! - Return edges terminate the pass (loops re-arm on the next run).
//! - Runs on the same repo share one journal connection (single writer).

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
use crate::events::SessionEvent;
use crate::quiet::Quiet;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardInfo {
    pub prompt: String,
    pub permissions: String,
    pub harness: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    #[serde(default)]
    pub structured_output: Option<serde_json::Value>,
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
    /// What to do with the worktree on approve of an outward gate:
    /// "branch" | "push" | "pr" | "merge" | none (just continue).
    #[serde(default)]
    pub action: Option<String>,
    /// Optional branch name override for the ship action.
    #[serde(default)]
    pub branch: Option<String>,
}

/// Per-run control flags. Every scheduled task holds the run's handle;
/// stop/pause act on one run and never bleed into its neighbors.
#[derive(Default)]
pub struct RunHandle {
    pub paused: AtomicBool,
    pub stopped: AtomicBool,
}

pub struct Engine {
    pub gates: Mutex<HashMap<String, oneshot::Sender<GateDecision>>>,
    pub cancels: Mutex<HashMap<String, oneshot::Sender<()>>>,
    /// Live runs by id. Presence in this map IS the "running" state.
    /// std mutex: every touch is a brief sync map op, never held across await.
    pub runs: std::sync::Mutex<HashMap<String, Arc<RunHandle>>>,
    /// (session id, worktree) per run:node, for follow-up nudges.
    pub sessions: Mutex<HashMap<String, (String, String)>>,
    /// App handle so nudges can stream into the canvas.
    pub app: Mutex<Option<tauri::AppHandle>>,
    /// Global agent-slot cap across ALL runs (0 = unlimited). Sessions past
    /// the cap queue at the node boundary, visible as "queued".
    pub max_parallel: AtomicUsize,
    pub active_sessions: AtomicUsize,
    pub slots: tokio::sync::Notify,
}

impl Default for Engine {
    fn default() -> Self {
        Self {
            gates: Mutex::default(),
            cancels: Mutex::default(),
            runs: std::sync::Mutex::default(),
            sessions: Mutex::default(),
            app: Mutex::default(),
            max_parallel: AtomicUsize::new(3),
            active_sessions: AtomicUsize::new(0),
            slots: tokio::sync::Notify::new(),
        }
    }
}

impl Engine {
    /// Hard-stop one run: cancel its live sessions, reject its pending gates,
    /// and let its scheduled tasks unwind at their boundaries. Other runs are
    /// untouched.
    pub async fn stop_run(&self, run_id: &str) {
        if let Some(h) = self.runs.lock().ok().and_then(|r| r.get(run_id).cloned()) {
            h.stopped.store(true, Ordering::SeqCst);
            h.paused.store(false, Ordering::SeqCst); // unblock paused waiters so they can exit
        }
        let prefix = format!("{run_id}:");
        {
            let mut cancels = self.cancels.lock().await;
            let keys: Vec<String> = cancels.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
            for k in keys {
                if let Some(tx) = cancels.remove(&k) {
                    let _ = tx.send(());
                }
            }
        }
        let mut gates = self.gates.lock().await;
        let keys: Vec<String> = gates.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
        for k in keys {
            if let Some(tx) = gates.remove(&k) {
                let _ = tx.send(GateDecision { approve: false, memo: Some("run stopped".into()), action: None, branch: None });
            }
        }
    }

    /// Pause/resume one run at its scheduling boundary.
    pub fn set_paused(&self, run_id: &str, paused: bool) {
        if let Some(h) = self.runs.lock().ok().and_then(|r| r.get(run_id).cloned()) {
            h.paused.store(paused, Ordering::SeqCst);
        }
    }
}

struct RunCtx {
    app: tauri::AppHandle,
    engine: Arc<Engine>,
    handle: Arc<RunHandle>,
    stage: Stage,
    cards: HashMap<String, CardInfo>,
    run_id: String,
    repo: PathBuf,
    goal: String,
    /// Shared per REPO (std mutex, never dropped writes): two runs on the
    /// same repo journal through one connection — SQLite's single writer.
    journal: Option<Arc<std::sync::Mutex<Journal>>>,
    seq: AtomicU64,
    active: AtomicUsize,
    loop_counts: Mutex<HashMap<String, u32>>,
    /// Fan-in joins: per target node, the outputs that have arrived from its
    /// flow predecessors this pass. A node with N>1 inbound flow edges runs
    /// once per pass, after all N have reported.
    joins: Mutex<HashMap<String, HashMap<String, String>>>,
}

impl RunCtx {
    /// Emit to the canvas AND journal — the journal carries the exact same
    /// type-tagged stream the canvas renders, so restart-replay is faithful.
    fn emit(&self, ev: EngineEvent) {
        let _ = self.app.emit("engine-event", &ev);
        if let Some(j) = &self.journal {
            if let Ok(v) = serde_json::to_value(&ev) {
                let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("").to_string();
                let node = v
                    .get("node_id")
                    .or_else(|| v.get("failed_node"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string();
                // Blocking lock, never try_lock: with concurrent runs sharing
                // a repo journal, a dropped event would corrupt replay.
                if let Ok(j) = j.lock() {
                    let _ = j.append_engine(&self.run_id, &node, self.seq.fetch_add(1, Ordering::Relaxed), &kind, &v.to_string());
                }
            }
        }
    }

    fn node(&self, id: &str) -> Option<Node> {
        self.stage.nodes.iter().find(|n| n.id == id).cloned()
    }

}

/// One journal connection per repo, shared by every run targeting it —
/// SQLite wants a single writer, and interleaved runs separate by run_id.
fn repo_journal(repo: &std::path::Path) -> Option<Arc<std::sync::Mutex<Journal>>> {
    use std::sync::OnceLock;
    static POOL: OnceLock<std::sync::Mutex<HashMap<PathBuf, Arc<std::sync::Mutex<Journal>>>>> = OnceLock::new();
    let pool = POOL.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let key = std::fs::canonicalize(repo).unwrap_or_else(|_| repo.to_path_buf());
    let mut m = pool.lock().ok()?;
    if let Some(j) = m.get(&key) {
        return Some(j.clone());
    }
    let dir = repo.join(".cuelight");
    std::fs::create_dir_all(&dir).ok();
    let j = Arc::new(std::sync::Mutex::new(Journal::open(&dir.join("journal.sqlite")).ok()?));
    m.insert(key, j.clone());
    Some(j)
}

pub fn start(
    app: tauri::AppHandle,
    engine: Arc<Engine>,
    run_id: String,
    stage: Stage,
    cards: HashMap<String, CardInfo>,
    repo: PathBuf,
    goal: String,
) -> Result<String, String> {
    if run_id.is_empty() || run_id.len() > 64 || !run_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("run id must be a short alphanumeric/dash token".into());
    }
    stage.validate().map_err(|e| e.to_string())?;

    // Idempotent launch: a duplicate id (double-fired click, IPC retry) joins
    // the existing run instead of double-starting it.
    let handle = {
        let mut runs = engine.runs.lock().map_err(|_| "run registry poisoned")?;
        if runs.contains_key(&run_id) {
            return Ok(run_id);
        }
        let h = Arc::new(RunHandle::default());
        runs.insert(run_id.clone(), h.clone());
        h
    };

    let journal = repo_journal(&repo);
    if let Some(j) = &journal {
        if let Ok(j) = j.lock() {
            let _ = j.start_run(&run_id, &stage.name, &serde_json::to_string(&stage).unwrap_or_default());
        }
    }

    let ctx = Arc::new(RunCtx {
        app,
        engine: engine.clone(),
        handle,
        stage,
        cards,
        run_id: run_id.clone(),
        repo,
        goal,
        journal,
        seq: AtomicU64::new(0),
        active: AtomicUsize::new(0),
        loop_counts: Mutex::new(HashMap::new()),
        joins: Mutex::new(HashMap::new()),
    });

    // Entry nodes: no incoming flow edge.
    let entries: Vec<String> = ctx
        .stage
        .nodes
        .iter()
        .filter(|n| !ctx.stage.edges.iter().any(|e| e.to == n.id && e.kind == "flow"))
        .map(|n| n.id.clone())
        .collect();

    // Expose the app handle so nudges can stream into any run's canvas.
    if let Ok(mut a) = engine.app.try_lock() {
        *a = Some(ctx.app.clone());
    }

    for id in entries {
        schedule(ctx.clone(), id, ctx.goal.clone(), None);
    }
    Ok(run_id)
}

/// Nudge a node's agent: resume its harness session with a follow-up message,
/// streaming the reply into that node's chat. Requires the node to have
/// completed at least one turn (so a resumable session id exists).
pub async fn nudge(engine: Arc<Engine>, run_id: String, node_id: String, text: String) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, BufReader};
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
        .quiet()
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
        while ctx.handle.paused.load(Ordering::SeqCst) && !ctx.handle.stopped.load(Ordering::SeqCst) {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        }
        // A stop between scheduling and running skips this node entirely.
        if !ctx.handle.stopped.load(Ordering::SeqCst) {
            run_node(ctx.clone(), &node_id, payload, worktree).await;
        }
        if ctx.active.fetch_sub(1, Ordering::SeqCst) == 1 {
            let stopped = ctx.handle.stopped.load(Ordering::SeqCst);
            let status = if stopped { "stopped" } else { "finished" };
            // This run is over: leave the registry and drop its nudge cursors.
            if let Ok(mut runs) = ctx.engine.runs.lock() {
                runs.remove(&ctx.run_id);
            }
            let prefix = format!("{}:", ctx.run_id);
            ctx.engine.sessions.lock().await.retain(|k, _| !k.starts_with(&prefix));
            if let Some(j) = &ctx.journal {
                if let Ok(j) = j.lock() {
                    let _ = j.finish_run(&ctx.run_id, status);
                }
            }
            ctx.emit(EngineEvent::RunFinished { run_id: ctx.run_id.clone(), status: status.into() });
        }
    });
}

/// Deliver a completed node's output forward. Single-predecessor targets run
/// immediately (inheriting the chain's worktree). Fan-in targets run once per
/// pass: outputs accumulate until every flow predecessor has reported, then
/// the merged bundle is scheduled in a fresh worktree — a joined node never
/// judges partial input.
async fn feed(ctx: Arc<RunCtx>, from: &str, to: String, payload: String, worktree: Option<PathBuf>) {
    let preds = ctx.stage.flow_preds(&to);
    if preds.len() <= 1 {
        schedule(ctx, to, payload, worktree);
        return;
    }
    let (ready, have) = {
        let mut joins = ctx.joins.lock().await;
        let slot = joins.entry(to.clone()).or_default();
        slot.insert(from.to_string(), payload);
        let have = slot.len();
        (if have >= preds.len() { joins.remove(&to) } else { None }, have)
    };
    match ready {
        Some(parts) => {
            let merged = preds
                .iter()
                .filter_map(|p| parts.get(p).map(|t| format!("## Input from `{p}`\n\n{t}")))
                .collect::<Vec<_>>()
                .join("\n\n---\n\n");
            schedule(ctx, to, merged, None);
        }
        None => {
            ctx.emit(EngineEvent::NodeState {
                run_id: ctx.run_id.clone(),
                node_id: to,
                cue: "standby".into(),
                detail: format!("waiting for inputs ({have}/{})", preds.len()),
                worktree: None,
                diagnosis: None,
            });
        }
    }
}

/// A node died (failed and was skipped). Its fan-in consumers must not starve
/// waiting for input that will never come — feed them an explicit absence.
async fn feed_failure(ctx: &Arc<RunCtx>, node: &Node) {
    for next in ctx.stage.flow_targets(&node.id, None) {
        if ctx.stage.flow_preds(&next).len() > 1 {
            feed(
                ctx.clone(),
                &node.id,
                next,
                format!("[`{}` failed and was skipped — no output from this branch]", node.id),
                None,
            )
            .await;
        }
    }
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
        for next in ctx.stage.flow_targets(&node.id, None) {
            feed(ctx.clone(), &node.id, next, payload.clone(), worktree.clone()).await;
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

    let decision = rx.await.unwrap_or(GateDecision { approve: false, memo: Some("gate channel dropped".into()), action: None, branch: None });
    // A stop unblocks the gate with a reject — don't re-run upstream, just exit.
    if ctx.handle.stopped.load(Ordering::SeqCst) {
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
        // On an outward gate, carry out the operator's chosen ship action
        // against the worktree that produced the change.
        let mut detail = "approved".to_string();
        if cfg.outward {
            if let (Some(action), Some(wt)) = (decision.action.as_deref(), worktree.as_ref()) {
                if action != "continue" && !action.is_empty() {
                    let branch = decision
                        .branch
                        .clone()
                        .unwrap_or_else(|| format!("cuelight/{}", slug(if ctx.goal.is_empty() { &ctx.stage.name } else { &ctx.goal })));
                    let message = if ctx.goal.is_empty() {
                        format!("Cuelight: {}", ctx.stage.name)
                    } else {
                        ctx.goal.clone()
                    };
                    match crate::conductor::scheduler::ship_action(&ctx.repo, wt, action, &branch, &message) {
                        Ok(msg) => {
                            detail = format!("approved · {msg}");
                            ctx.emit(EngineEvent::Session {
                                run_id: ctx.run_id.clone(),
                                node_id: node.id.clone(),
                                event: SessionEvent::Text { text: format!("✓ {msg}") },
                            });
                        }
                        Err(e) => {
                            ctx.emit(EngineEvent::NodeState {
                                run_id: ctx.run_id.clone(),
                                node_id: node.id.clone(),
                                cue: "failed".into(),
                                detail: format!("ship failed: {e}"),
                                worktree: worktree.as_ref().map(|w| w.to_string_lossy().to_string()),
                                diagnosis: None,
                            });
                            return;
                        }
                    }
                }
            }
        }
        ctx.emit(EngineEvent::NodeState {
            run_id: ctx.run_id.clone(),
            node_id: node.id.clone(),
            cue: "idle".into(),
            detail,
            worktree: None,
            diagnosis: None,
        });
        for next in ctx.stage.flow_targets(&node.id, None) {
            feed(ctx.clone(), &node.id, next, payload.clone(), worktree.clone()).await;
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

        // Global agent-slot limiter: at most max_parallel harness sessions
        // run at once across every live run; the rest queue here, at the
        // node boundary, and say so on their card.
        let mut queued = false;
        loop {
            if ctx.handle.stopped.load(Ordering::SeqCst) {
                return;
            }
            let max = ctx.engine.max_parallel.load(Ordering::SeqCst);
            let cur = ctx.engine.active_sessions.load(Ordering::SeqCst);
            if max == 0 || cur < max {
                if ctx
                    .engine
                    .active_sessions
                    .compare_exchange(cur, cur + 1, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
                {
                    break;
                }
                continue;
            }
            if !queued {
                queued = true;
                ctx.emit(EngineEvent::NodeState {
                    run_id: ctx.run_id.clone(),
                    node_id: node.id.clone(),
                    cue: "standby".into(),
                    detail: format!("queued — {cur}/{max} agent slots busy"),
                    worktree: Some(wt.to_string_lossy().to_string()),
                    diagnosis: None,
                });
            }
            let _ = tokio::time::timeout(std::time::Duration::from_millis(400), ctx.engine.slots.notified()).await;
        }
        let release_slot = || {
            ctx.engine.active_sessions.fetch_sub(1, Ordering::SeqCst);
            ctx.engine.slots.notify_waiters();
        };

        let prompt = compose_prompt(&card.prompt, node.prompt_context.as_deref(), &payload);
        let spec = SessionSpec {
            prompt,
            workdir: wt.clone(),
            model: node.model.clone().or(card.model.clone()).or(ctx.stage.defaults.model.clone()),
            effort: node.effort.clone().or(card.effort.clone()).or(ctx.stage.defaults.effort.clone()),
            permissions: permissions.clone(),
            json_schema: card.structured_output.as_ref().map(|s| s.to_string()),
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
                release_slot();
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

        let cancel_key = format!("{}:{}", ctx.run_id, node.id);
        ctx.engine.cancels.lock().await.insert(cancel_key.clone(), handle.cancel);

        let mut events = handle.events;
        let mut final_text = String::new();
        let mut structured: Option<serde_json::Value> = None;
        let mut failed = false;
        // Stall reaper: a session that produces NOTHING for this long is a
        // hung CLI, not a thinking agent — kill it and fail the attempt, so a
        // wedged process can never pin an agent slot forever.
        let idle_limit = std::time::Duration::from_secs(30 * 60);
        loop {
            match tokio::time::timeout(idle_limit, events.recv()).await {
                Ok(Some(ev)) => {
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
                                    .insert(cancel_key.clone(), (rid.clone(), wt.to_string_lossy().to_string()));
                            }
                        }
                        SessionEvent::Failed { .. } => failed = true,
                        _ => {}
                    }
                    ctx.emit(EngineEvent::Session { run_id: ctx.run_id.clone(), node_id: node.id.clone(), event: ev });
                }
                Ok(None) => break,
                Err(_) => {
                    failed = true;
                    if let Some(tx) = ctx.engine.cancels.lock().await.remove(&cancel_key) {
                        let _ = tx.send(());
                    }
                    ctx.emit(EngineEvent::Session {
                        run_id: ctx.run_id.clone(),
                        node_id: node.id.clone(),
                        event: SessionEvent::Failed { error: "session reaped — no output for 30 minutes".into() },
                    });
                    break;
                }
            }
        }
        ctx.engine.cancels.lock().await.remove(&cancel_key);
        release_slot();

        // Kill gates at the boundary. A structured-verdict "reject" is NOT a
        // failure — it's a routable outcome: `when:"reject"` edges win, then
        // explicit return edges, then every upstream agent whose work was
        // under review. Escalation is for graphs with no route or spent caps.
        let verdict: Option<String> = structured
            .as_ref()
            .and_then(|s| s.get("verdict"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let mut gate_fail: Option<String> = None;
        let mut rejected = false;
        if !failed {
            for g in &node.kill_gates {
                if g.check == "structured-verdict" && g.arg.as_deref() == Some("verdict=pass") {
                    match verdict.as_deref() {
                        Some("pass") => continue,
                        Some("reject") => {
                            rejected = true;
                            break;
                        }
                        _ => {
                            gate_fail = Some("structured-verdict: no readable verdict".into());
                            break;
                        }
                    }
                } else if !evaluate_kill_gate(g, &wt, structured.as_ref()) {
                    gate_fail = Some(format!("{} {}", g.check, g.arg.clone().unwrap_or_default()));
                    break;
                }
            }
        }

        // A rejection never retries the reviewer (same code → same verdict).
        if rejected {
            let fb = structured
                .as_ref()
                .and_then(|s| s.get("failureScenario").or_else(|| s.get("reason")).or_else(|| s.get("attacks")))
                .map(|v| v.to_string())
                .unwrap_or_else(|| final_text.clone());
            let targets = ctx.stage.reject_targets(&node.id);
            let count = {
                let mut m = ctx.loop_counts.lock().await;
                let c = m.entry(node.id.clone()).or_insert(0);
                *c += 1;
                *c
            };
            if !targets.is_empty() && count <= 3 {
                ctx.emit(EngineEvent::NodeState {
                    run_id: ctx.run_id.clone(),
                    node_id: node.id.clone(),
                    cue: "idle".into(),
                    detail: format!("rejected — routing to {} (loop {count}/3)", targets.join(", ")),
                    worktree: Some(wt.to_string_lossy().to_string()),
                    diagnosis: None,
                });
                let payload = format!(
                    "The reviewer REJECTED the previous work. Address this feedback specifically, then it will be re-reviewed.\n\nReviewer feedback:\n{fb}"
                );
                // A single target continues in the reviewed worktree; a
                // broadcast (fan-in rework) gives each agent a fresh one.
                let solo = targets.len() == 1;
                for t in targets {
                    schedule(ctx.clone(), t, payload.clone(), if solo { Some(wt.clone()) } else { None });
                }
                return;
            }
            let reason = if count > 3 {
                "review rejected 3 times — needs a human".to_string()
            } else {
                "reviewer rejected with no route back — add a reject edge or a return edge".to_string()
            };
            if escalate(&ctx, node, &reason, &wt, &final_text).await {
                // Human intervened — the reject-loop budget starts fresh.
                ctx.loop_counts.lock().await.remove(&node.id);
                attempt = 0;
                continue;
            }
            feed_failure(&ctx, node).await;
            return;
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
            feed_failure(&ctx, node).await;
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
        for next in ctx.stage.flow_targets(&node.id, verdict.as_deref()) {
            feed(ctx.clone(), &node.id, next, final_text.clone(), Some(wt.clone())).await;
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
    let decision = rx.await.unwrap_or(GateDecision { approve: false, memo: None, action: None, branch: None });
    let retried = decision.approve && !ctx.handle.stopped.load(Ordering::SeqCst);

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

/// Kebab-case slug for branch names from a goal/stage string.
fn slug(s: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in s.chars().take(60) {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() { "change".into() } else { trimmed }
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
    let mut cmd = tokio::process::Command::new(bin);
    let fut = cmd
        .quiet()
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
