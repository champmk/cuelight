//! Cuelight — the live canvas for agent orchestration.
//! This crate is the conductor (brain) and adapters (hands); the React canvas
//! in `../src` is the face. Typed events cross the IPC boundary; nothing else.

pub mod adapters;
pub mod conductor;
pub mod events;
pub mod procjob;
pub mod quiet;

use std::collections::HashMap;
use std::sync::Arc;

use adapters::{claude::ClaudeAdapter, grok::GrokAdapter, HarnessAdapter};
use conductor::engine::{CardInfo, Engine, GateDecision};
use conductor::stage::Stage;
use tauri::State;

/// Preflight both bundled harnesses; the UI shows the result on launch and
/// the smoke test prints it. Returns (harness id, ok, message) triples.
#[tauri::command]
async fn preflight_harnesses() -> Vec<(String, bool, String)> {
    let adapters: Vec<Box<dyn HarnessAdapter>> = vec![Box::new(ClaudeAdapter), Box::new(GrokAdapter)];
    let mut out = Vec::new();
    for a in adapters {
        match a.preflight().await {
            Ok(()) => out.push((a.id().to_string(), true, "ready".into())),
            Err(e) => out.push((a.id().to_string(), false, e.to_string())),
        }
    }
    out
}

/// Load and validate a stage file; the canvas calls this to render a template
/// before any run exists.
#[tauri::command]
fn load_stage(path: String) -> Result<Stage, String> {
    Stage::load(std::path::Path::new(&path)).map_err(|e| e.to_string())
}

/// List bundled templates (name + description) for the template picker.
#[tauri::command]
fn list_templates(templates_dir: String) -> Result<Vec<serde_json::Value>, String> {
    let mut out = Vec::new();
    let dir = std::fs::read_dir(&templates_dir).map_err(|e| e.to_string())?;
    for entry in dir.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Ok(stage) = Stage::load(&path) {
                out.push(serde_json::json!({
                    "name": stage.name,
                    "description": stage.description,
                    "path": path.to_string_lossy(),
                    "nodes": stage.nodes.len(),
                }));
            }
        }
    }
    Ok(out)
}

fn user_templates_dir() -> std::path::PathBuf {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    home.join(".cuelight").join("templates")
}

fn valid_template_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().next().is_some_and(|c| c.is_ascii_lowercase())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn user_agents_dir() -> std::path::PathBuf {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    home.join(".cuelight").join("agents")
}

/// Custom agent cards live in ~/.cuelight/agents/<name>.agent.json.
#[tauri::command]
fn list_user_agents() -> Result<Vec<serde_json::Value>, String> {
    let dir = user_agents_dir();
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(out);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Ok(raw) = std::fs::read_to_string(&path) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                    out.push(v);
                }
            }
        }
    }
    Ok(out)
}

#[tauri::command]
fn save_user_agent(name: String, json: String) -> Result<(), String> {
    if !valid_template_name(&name) {
        return Err("agent name must be kebab-case (lowercase letters, digits, dashes)".into());
    }
    let v: serde_json::Value = serde_json::from_str(&json).map_err(|e| format!("invalid agent JSON: {e}"))?;
    // Enforce the required agent fields (mirrors schema/agent.schema.json).
    for field in ["name", "description", "harness", "permissions", "prompt"] {
        if v.get(field).is_none() {
            return Err(format!("agent is missing required field: {field}"));
        }
    }
    if v.get("name").and_then(|n| n.as_str()) != Some(name.as_str()) {
        return Err("file name and agent name must match".into());
    }
    let perms = v.get("permissions").and_then(|p| p.as_str()).unwrap_or("");
    if !matches!(perms, "plan" | "edit" | "edit+exec") {
        return Err("permissions must be plan, edit, or edit+exec".into());
    }
    let dir = user_agents_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{name}.agent.json")), json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_user_agent(name: String) -> Result<(), String> {
    if !valid_template_name(&name) {
        return Err("invalid agent name".into());
    }
    let path = user_agents_dir().join(format!("{name}.agent.json"));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// User templates live in ~/.cuelight/templates/<name>.stage.json.
#[tauri::command]
fn list_user_templates() -> Result<Vec<serde_json::Value>, String> {
    let dir = user_templates_dir();
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(out); // no dir yet = no templates, not an error
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Ok(raw) = std::fs::read_to_string(&path) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                    out.push(v);
                }
            }
        }
    }
    Ok(out)
}

/// Validate through the same loader the conductor uses, then write. A template
/// that would be refused at run time is refused at save time.
#[tauri::command]
fn save_user_template(name: String, json: String) -> Result<(), String> {
    if !valid_template_name(&name) {
        return Err("template name must be kebab-case (lowercase letters, digits, dashes)".into());
    }
    let stage: Stage = serde_json::from_str(&json).map_err(|e| format!("invalid stage JSON: {e}"))?;
    if stage.name != name {
        return Err("file name and stage name must match".into());
    }
    // Empty templates are allowed at save time (a fresh canvas); the full
    // validate() runs when a run is launched.
    if !stage.nodes.is_empty() {
        stage.validate().map_err(|e| e.to_string())?;
    }
    let dir = user_templates_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{name}.stage.json")), json).map_err(|e| e.to_string())?;
    Ok(())
}

/// Generate a workflow from a natural-language description by running a
/// headless harness session (Grok first, Claude fallback). The output is
/// parsed and validated with the same loader the conductor uses — a workflow
/// that generates is a workflow that runs.
#[tauri::command]
async fn generate_template(name: String, description: String) -> Result<String, String> {
    if !valid_template_name(&name) {
        return Err("workflow name must be kebab-case".into());
    }
    let prompt = format!(
        r#"Author a Cuelight stage (workflow) JSON file. Output ONLY the JSON object — no prose, no code fences.

A stage is a directed graph of agent nodes and gates. Rules:
- Top-level fields: name, version ("0.1.0"), description, nodes, edges. Optional: defaults, caps.
- name MUST be exactly "{name}".
- Node: {{"id": kebab-case, "type": "agent"|"gate", "label": short human title}}.
  Agent nodes MUST have "card" — one of: implementer (fixes with tests), adversarial-reviewer (refutes work, fresh context), repo-scout (scores OSS repos), issue-triager (repro-first issue triage), lifecycle-monitor (keeps PRs alive), security-reviewer (diff security sweep), test-engineer (tests proven by sabotage), docs-writer (fixes doc drift), refactor-surgeon (behavior-preserving refactors), ideation-lead (specs fuzzy goals).
  Agent nodes SHOULD have "promptContext" (what this node must know about THIS workflow) and "killGates" (array of {{"check": "command-succeeds"|"artifact-exists"|"structured-verdict"|"diff-nonempty"|"diff-max-files", "arg": string}}). Use {{"check":"command-succeeds","arg":"auto:test"}} for test gates.
  Gate nodes MUST have "gate": {{"mode":"human"|"auto","outward":bool,"checklist":[strings]}}. Any gate releasing an outward action (push, PR, reply, publish) MUST be mode "human" with "outward": true.
- Edge: {{"from": id, "to": id}} for forward flow; add "kind":"return" and a short "label" for edges that close a loop.
- Design taste: 3-6 nodes, every agent node gets a kill gate, verification is a separate fresh-context node, exactly one human gate before anything ships, and the graph should loop.

The workflow to author: {description}"#
    );

    async fn run_headless(bin: &str, args: &[&str]) -> Result<String, String> {
        use crate::quiet::Quiet;
        let mut cmd = tokio::process::Command::new(crate::adapters::resolve_bin(bin));
        let fut = cmd.quiet().args(args).output();
        let out = tokio::time::timeout(std::time::Duration::from_secs(300), fut)
            .await
            .map_err(|_| format!("{bin} timed out"))?
            .map_err(|e| format!("{bin} failed to spawn: {e}"))?;
        if !out.status.success() {
            return Err(format!("{bin} exited with {}", out.status));
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    let raw = match run_headless("grok", &["-p", &prompt]).await {
        Ok(r) => r,
        Err(_) => run_headless("claude", &["-p", &prompt]).await?,
    };

    // Extract the JSON object (models occasionally add fences despite orders).
    let start = raw.find('{').ok_or("model returned no JSON")?;
    let end = raw.rfind('}').ok_or("model returned no JSON")?;
    let mut value: serde_json::Value =
        serde_json::from_str(&raw[start..=end]).map_err(|e| format!("model returned invalid JSON: {e}"))?;
    value["name"] = serde_json::Value::String(name);

    let stage: Stage = serde_json::from_value(value.clone()).map_err(|e| format!("generated stage malformed: {e}"))?;
    stage.validate().map_err(|e| format!("generated stage rejected: {e}"))?;
    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_user_template(name: String) -> Result<(), String> {
    if !valid_template_name(&name) {
        return Err("invalid template name".into());
    }
    let path = user_templates_dir().join(format!("{name}.stage.json"));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------- run engine commands ----------

#[tauri::command]
fn start_run(
    app: tauri::AppHandle,
    engine: State<'_, Arc<Engine>>,
    stage: Stage,
    cards: HashMap<String, CardInfo>,
    repo_path: String,
    goal: String,
) -> Result<String, String> {
    let repo = std::path::PathBuf::from(&repo_path);
    if !repo.join(".git").exists() {
        return Err("target repo is not a git repository — runs need worktree isolation".into());
    }
    conductor::engine::start(app, engine.inner().clone(), stage, cards, repo, goal)
}

#[tauri::command]
async fn gate_decision(
    engine: State<'_, Arc<Engine>>,
    run_id: String,
    node_id: String,
    approve: bool,
    memo: Option<String>,
    action: Option<String>,
    branch: Option<String>,
) -> Result<(), String> {
    let key = format!("{run_id}:{node_id}");
    let tx = engine.gates.lock().await.remove(&key).ok_or("gate not pending")?;
    tx.send(GateDecision { approve, memo, action, branch })
        .map_err(|_| "gate branch already gone".to_string())
}

#[tauri::command]
async fn kill_node(engine: State<'_, Arc<Engine>>, run_id: String, node_id: String) -> Result<(), String> {
    let key = format!("{run_id}:{node_id}");
    let tx = engine.cancels.lock().await.remove(&key).ok_or("no running session on that node")?;
    let _ = tx.send(());
    Ok(())
}

#[tauri::command]
fn set_paused(engine: State<'_, Arc<Engine>>, paused: bool) {
    engine.paused.store(paused, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
async fn stop_run(engine: State<'_, Arc<Engine>>) -> Result<(), String> {
    engine.stop().await;
    Ok(())
}

#[tauri::command]
async fn nudge_node(engine: State<'_, Arc<Engine>>, node_id: String, text: String) -> Result<(), String> {
    conductor::engine::nudge(engine.inner().clone(), node_id, text).await
}

// ---------- git inspection for the Review view ----------

fn git_out(dir: &str, args: &[&str]) -> Result<String, String> {
    use crate::quiet::Quiet;
    let out = std::process::Command::new("git").quiet().current_dir(dir).args(args).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[derive(serde::Serialize)]
struct ChangedFile { path: String, adds: u32, dels: u32 }

#[tauri::command]
fn git_changed_files(worktree: String) -> Result<Vec<ChangedFile>, String> {
    let mut files = Vec::new();
    for line in git_out(&worktree, &["diff", "HEAD", "--numstat"])?.lines() {
        let mut parts = line.split_whitespace();
        let adds = parts.next().and_then(|a| a.parse().ok()).unwrap_or(0);
        let dels = parts.next().and_then(|d| d.parse().ok()).unwrap_or(0);
        if let Some(path) = parts.next() {
            files.push(ChangedFile { path: path.to_string(), adds, dels });
        }
    }
    for line in git_out(&worktree, &["ls-files", "--others", "--exclude-standard"])?.lines() {
        if !line.trim().is_empty() {
            files.push(ChangedFile { path: line.trim().to_string(), adds: 0, dels: 0 });
        }
    }
    Ok(files)
}

#[tauri::command]
fn git_file_diff(worktree: String, path: String) -> Result<String, String> {
    let tracked = git_out(&worktree, &["diff", "HEAD", "--", &path])?;
    if !tracked.trim().is_empty() {
        return Ok(tracked);
    }
    // Untracked file: synthesize an all-additions diff.
    git_out(&worktree, &["diff", "--no-index", "--", "NUL", &path]).or_else(|e| {
        if e.is_empty() { Ok(String::new()) } else { Err(e) }
    }).or_else(|_| {
        std::fs::read_to_string(std::path::Path::new(&worktree).join(&path))
            .map(|c| c.lines().map(|l| format!("+{l}")).collect::<Vec<_>>().join("\n"))
            .map_err(|e| e.to_string())
    })
}

// ---------- run history (from the per-repo journal) ----------

#[tauri::command]
fn list_runs(repo_path: String) -> Result<Vec<serde_json::Value>, String> {
    let db = std::path::PathBuf::from(&repo_path).join(".cuelight").join("journal.sqlite");
    if !db.exists() {
        return Ok(vec![]);
    }
    let conn = rusqlite::Connection::open(&db).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, stage_name, status, started_at, finished_at FROM runs ORDER BY started_at DESC LIMIT 200")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, String>(0)?,
                "stageName": r.get::<_, String>(1)?,
                "status": r.get::<_, String>(2)?,
                "startedAt": r.get::<_, String>(3)?,
                "finishedAt": r.get::<_, Option<String>>(4)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_run(repo_path: String, run_id: String) -> Result<serde_json::Value, String> {
    let db = std::path::PathBuf::from(&repo_path).join(".cuelight").join("journal.sqlite");
    let conn = rusqlite::Connection::open(&db).map_err(|e| e.to_string())?;
    let stage_json: String = conn
        .query_row("SELECT stage_json FROM runs WHERE id = ?1", [&run_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT at, payload FROM events WHERE run_id = ?1 ORDER BY at, seq")
        .map_err(|e| e.to_string())?;
    let events: Vec<serde_json::Value> = stmt
        .query_map([&run_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|row| {
            let (at, payload) = row.ok()?;
            let mut v: serde_json::Value = serde_json::from_str(&payload).ok()?;
            // Engine-event payloads don't carry a timestamp — attach the row's.
            if let Some(obj) = v.as_object_mut() {
                obj.entry("at").or_insert(serde_json::Value::String(at));
            }
            Some(v)
        })
        .collect();
    // Gate decisions let replay tell a still-pending gate from a decided one.
    let decisions: Vec<serde_json::Value> = conn
        .prepare("SELECT node_id, decision FROM gate_decisions WHERE run_id = ?1")
        .map_err(|e| e.to_string())?
        .query_map([&run_id], |r| {
            Ok(serde_json::json!({ "nodeId": r.get::<_, String>(0)?, "decision": r.get::<_, String>(1)? }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|d| d.ok())
        .collect();
    let (status, goal_started): (String, String) = conn
        .query_row("SELECT status, started_at FROM runs WHERE id = ?1", [&run_id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "stage": serde_json::from_str::<serde_json::Value>(&stage_json).unwrap_or_default(),
        "events": events,
        "decisions": decisions,
        "status": status,
        "startedAt": goal_started,
    }))
}

/// Worktrees still on disk for a run — a dead run's approved-able evidence.
#[tauri::command]
fn list_run_worktrees(repo_path: String, run_id: String) -> Result<Vec<serde_json::Value>, String> {
    let prefix = format!("{}-", &run_id[..8.min(run_id.len())]);
    let dir = std::path::PathBuf::from(&repo_path).join(".cuelight").join("worktrees");
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with(&prefix) && e.path().is_dir() {
                out.push(serde_json::json!({
                    "node": name[prefix.len()..].to_string(),
                    "path": e.path().to_string_lossy().to_string(),
                }));
            }
        }
    }
    Ok(out)
}

/// Complete a human gate whose engine died (app closed / crashed mid-run).
/// Shipping is a pure git operation on the surviving worktree, so approval
/// still works; the decision is journaled and the run marked finished.
#[tauri::command]
fn ship_orphan(
    repo_path: String,
    worktree: String,
    action: String,
    branch: String,
    message: String,
    run_id: Option<String>,
    node_id: Option<String>,
) -> Result<String, String> {
    let repo = std::path::Path::new(&repo_path);
    let wt = std::path::Path::new(&worktree);
    if !wt.exists() {
        return Err(format!("worktree no longer exists: {worktree}"));
    }
    let msg = conductor::scheduler::ship_action(repo, wt, &action, &branch, &message)?;
    if let Some(rid) = run_id {
        let db = repo.join(".cuelight").join("journal.sqlite");
        if let Ok(conn) = rusqlite::Connection::open(&db) {
            let now = chrono::Utc::now().to_rfc3339();
            let _ = conn.execute(
                "INSERT INTO gate_decisions (run_id, node_id, decided_at, decision, memo) VALUES (?1, ?2, ?3, 'approved', ?4)",
                rusqlite::params![rid, node_id.unwrap_or_default(), now, format!("recovered · {msg}")],
            );
            let _ = conn.execute(
                "UPDATE runs SET finished_at = ?2, status = 'finished' WHERE id = ?1 AND status = 'running'",
                rusqlite::params![rid, now],
            );
        }
    }
    Ok(msg)
}

#[tauri::command]
fn git_info(repo_path: String) -> Result<serde_json::Value, String> {
    let branch = git_out(&repo_path, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string();
    Ok(serde_json::json!({ "branch": branch }))
}

pub fn run() {
    // Contain child sessions in a kill-on-close job before any can spawn, so a
    // crash can never orphan a quota-burning agent process.
    procjob::init();
    tauri::Builder::default()
        .manage(Arc::new(Engine::default()))
        .invoke_handler(tauri::generate_handler![
            preflight_harnesses,
            load_stage,
            list_templates,
            list_user_templates,
            save_user_template,
            delete_user_template,
            list_user_agents,
            save_user_agent,
            delete_user_agent,
            generate_template,
            start_run,
            gate_decision,
            kill_node,
            set_paused,
            stop_run,
            nudge_node,
            git_changed_files,
            git_file_diff,
            git_info,
            list_runs,
            get_run,
            list_run_worktrees,
            ship_orphan
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cuelight");
}
