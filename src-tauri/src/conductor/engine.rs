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

    for id in entries {
        schedule(ctx.clone(), id, ctx.goal.clone(), None);
    }
    Ok(run_id)
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
                SessionEvent::Done { ok, result_text, structured: s } => {
                    final_text = result_text.clone();
                    structured = s.clone();
                    failed = !ok;
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
            ctx.emit(EngineEvent::NodeState {
                run_id: ctx.run_id.clone(),
                node_id: node.id.clone(),
                cue: "failed".into(),
                detail: gate_fail.unwrap_or_else(|| "session failed".into()),
                worktree: Some(wt.to_string_lossy().to_string()),
            });
            return;
        }

        ctx.emit(EngineEvent::NodeState {
            run_id: ctx.run_id.clone(),
            node_id: node.id.clone(),
            cue: "idle".into(),
            detail: "done".into(),
            worktree: Some(wt.to_string_lossy().to_string()),
        });
        for next in ctx.next_flow(&node.id) {
            schedule(ctx.clone(), next, final_text.clone(), Some(wt.clone()));
        }
        return;
    }
}
