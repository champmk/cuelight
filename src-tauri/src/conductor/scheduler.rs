//! The run engine. One `Run` per launched stage; nodes fire when an in-edge
//! delivers a payload and the quota governor permits. Everything lands in the
//! journal; the canvas subscribes to the same event stream.
//!
//! Core invariant — edit-at-the-boundary: graph mutations queue until the
//! node whose edge they touch is between sessions. Running sessions are never
//! yanked except by an explicit kill.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;

use crate::conductor::stage::{KillGate, Node, Stage};
use crate::events::CueState;
use crate::quiet::Quiet;

/// Worktree management: every agent session gets a disposable git worktree
/// under `.cuelight/worktrees/<run>-<node>`, created from the repo's HEAD.
pub struct Worktrees {
    repo: PathBuf,
}

impl Worktrees {
    pub fn new(repo: PathBuf) -> Self {
        Self { repo }
    }

    pub fn create(&self, run_id: &str, node_id: &str) -> std::io::Result<PathBuf> {
        let name = format!("{}-{}", &run_id[..8.min(run_id.len())], node_id);
        let path = self.repo.join(".cuelight").join("worktrees").join(&name);
        std::fs::create_dir_all(path.parent().unwrap())?;
        let out = Command::new("git")
            .quiet()
            .current_dir(&self.repo)
            .args(["worktree", "add", "--detach"])
            .arg(&path)
            .output()?;
        if !out.status.success() {
            return Err(std::io::Error::other(String::from_utf8_lossy(&out.stderr).to_string()));
        }
        Ok(path)
    }

    /// Capture the worktree's current tree as a checkpoint ref (used by rewind).
    pub fn checkpoint(&self, worktree: &PathBuf) -> std::io::Result<String> {
        run_git(worktree, &["add", "-A"])?;
        // `git stash create` gives a commit without moving anything.
        let sha = run_git(worktree, &["stash", "create"])?;
        Ok(if sha.is_empty() { run_git(worktree, &["rev-parse", "HEAD"])? } else { sha })
    }

    pub fn remove(&self, worktree: &PathBuf) -> std::io::Result<()> {
        let out = Command::new("git")
            .quiet()
            .current_dir(&self.repo)
            .args(["worktree", "remove", "--force"])
            .arg(worktree)
            .output()?;
        if !out.status.success() {
            return Err(std::io::Error::other(String::from_utf8_lossy(&out.stderr).to_string()));
        }
        Ok(())
    }
}

fn run_git(dir: &std::path::Path, args: &[&str]) -> std::io::Result<String> {
    let out = Command::new("git").quiet().current_dir(dir).args(args).output()?;
    if !out.status.success() {
        return Err(std::io::Error::other(String::from_utf8_lossy(&out.stderr).to_string()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Materialize an approved worktree's changes into the real repo. `action` is
/// the operator's choice at the gate; each is progressively more outward.
/// Returns a human-readable result line.
pub fn ship_action(
    repo: &std::path::Path,
    worktree: &std::path::Path,
    action: &str,
    branch: &str,
    message: &str,
) -> Result<String, String> {
    let g = |dir: &std::path::Path, args: &[&str]| run_git(dir, args).map_err(|e| e.to_string());
    // Commit whatever the agent left in the worktree (no-op if already clean).
    g(worktree, &["add", "-A"])?;
    let _ = run_git(worktree, &["commit", "-m", message]); // ok if nothing to commit
    let sha = g(worktree, &["rev-parse", "HEAD"])?;
    if sha.is_empty() {
        return Err("worktree has no commit to ship".into());
    }
    match action {
        "branch" => {
            g(repo, &["branch", "-f", branch, &sha])?;
            Ok(format!("committed to branch `{branch}`"))
        }
        "push" => {
            g(repo, &["branch", "-f", branch, &sha])?;
            g(repo, &["push", "-u", "origin", branch])?;
            Ok(format!("pushed branch `{branch}` to origin"))
        }
        "pr" => {
            g(repo, &["branch", "-f", branch, &sha])?;
            g(repo, &["push", "-u", "origin", branch])?;
            let out = Command::new("gh")
                .quiet()
                .current_dir(repo)
                .args(["pr", "create", "--fill", "--head", branch])
                .output()
                .map_err(|e| format!("pushed, but gh not found: {e}"))?;
            if !out.status.success() {
                return Err(format!("pushed `{branch}`, but gh pr create failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
            }
            Ok(format!("opened PR from `{branch}`: {}", String::from_utf8_lossy(&out.stdout).trim()))
        }
        "merge" => {
            g(repo, &["merge", "--no-ff", "-m", message, &sha])?;
            Ok("merged into the current branch".into())
        }
        _ => Ok("approved — no ship action".into()),
    }
}

/// Kill-gate evaluation, run in the node's worktree after its session ends.
pub fn evaluate_kill_gate(gate: &KillGate, worktree: &PathBuf, structured: Option<&serde_json::Value>) -> bool {
    match gate.check.as_str() {
        "command-succeeds" => {
            let cmd = gate.arg.as_deref().unwrap_or("");
            if cmd == "auto:test" {
                // No detectable test command = nothing to run = don't block.
                match detect_test_command(worktree) {
                    Some(c) => shell(worktree, &c),
                    None => true,
                }
            } else if cmd.is_empty() {
                false
            } else {
                shell(worktree, cmd)
            }
        }
        "artifact-exists" => gate
            .arg
            .as_deref()
            .map(|p| worktree.join(p).exists())
            .unwrap_or(false),
        "diff-nonempty" => !run_git(worktree, &["status", "--porcelain"]).unwrap_or_default().is_empty(),
        "diff-max-files" => {
            let max: usize = gate.arg.as_deref().and_then(|a| a.parse().ok()).unwrap_or(usize::MAX);
            run_git(worktree, &["status", "--porcelain"])
                .map(|s| s.lines().count() <= max)
                .unwrap_or(false)
        }
        "structured-verdict" => {
            let Some(v) = structured else { return false };
            let Some(arg) = gate.arg.as_deref() else { return false };
            // "field.length>=N" — array length check (e.g. targets.length>=1).
            if let Some((field, min)) = arg.split_once(".length>=") {
                let n: usize = min.trim().parse().unwrap_or(1);
                return v.get(field).and_then(|x| x.as_array()).map(|a| a.len() >= n).unwrap_or(false);
            }
            // "array.field!=a,b" — pass if NO element's field is in the set
            // (e.g. findings.severity!=critical,high).
            if let Some((lhs, set)) = arg.split_once("!=") {
                let banned: Vec<&str> = set.split(',').map(|s| s.trim()).collect();
                if let Some((arr, key)) = lhs.split_once('.') {
                    // array form: arr[].key not in banned
                    if let Some(items) = v.get(arr).and_then(|x| x.as_array()) {
                        return items.iter().all(|it| {
                            it.get(key).and_then(|s| s.as_str()).map(|s| !banned.contains(&s)).unwrap_or(true)
                        });
                    }
                }
                // scalar form: field != value
                return v.get(lhs).and_then(|x| x.as_str()).map(|s| !banned.contains(&s)).unwrap_or(true);
            }
            // "field=value" — top-level equality.
            if let Some((field, want)) = arg.split_once('=') {
                return v.get(field).map(|x| x.as_str() == Some(want) || x.to_string() == want).unwrap_or(false);
            }
            false
        }
        _ => false,
    }
}

fn detect_test_command(worktree: &PathBuf) -> Option<String> {
    let has = |f: &str| worktree.join(f).exists();
    // Node projects: only use a script that actually exists in package.json.
    // Prefer test, then check/typecheck, then lint — never assume `test`.
    if has("package.json") {
        if let Ok(pkg) = std::fs::read_to_string(worktree.join("package.json")) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&pkg) {
                let scripts = v.get("scripts").and_then(|s| s.as_object());
                let runner = if has("pnpm-lock.yaml") { "pnpm" } else if has("yarn.lock") { "yarn" } else { "npm run" };
                if let Some(scripts) = scripts {
                    for name in ["test", "check", "typecheck", "lint"] {
                        if scripts.contains_key(name) {
                            return Some(format!("{runner} {name}"));
                        }
                    }
                }
            }
        }
        // package.json but no usable script — don't block on a phantom test.
        return None;
    }
    if has("Cargo.toml") {
        Some("cargo test".into())
    } else if has("pyproject.toml") || has("pytest.ini") {
        Some("pytest".into())
    } else if has("go.mod") {
        Some("go test ./...".into())
    } else {
        None
    }
}

fn shell(dir: &PathBuf, cmd: &str) -> bool {
    #[cfg(windows)]
    let out = Command::new("cmd").quiet().current_dir(dir).args(["/C", cmd]).status();
    #[cfg(not(windows))]
    let out = Command::new("sh").current_dir(dir).args(["-c", cmd]).status();
    out.map(|s| s.success()).unwrap_or(false)
}

/// Live per-node state the canvas renders. Kept flat and serializable —
/// this struct crossing the IPC boundary IS the UI's data model.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeState {
    pub node_id: String,
    pub cue: CueState,
    pub state_pill: String,
    pub currently: Option<String>,
    pub ctx_pct: Option<u8>,
    pub session_tokens: u64,
    pub attempts: u32,
}

/// A run in progress. The full async engine (session supervision loops,
/// cron triggers, gate queues) lands in M1; the data model and transitions
/// here are its foundation and are exercised by unit tests.
pub struct Run {
    pub id: String,
    pub stage: Stage,
    pub node_states: HashMap<String, NodeState>,
}

impl Run {
    pub fn new(id: String, stage: Stage) -> Self {
        let node_states = stage
            .nodes
            .iter()
            .map(|n| {
                (
                    n.id.clone(),
                    NodeState {
                        node_id: n.id.clone(),
                        cue: CueState::Idle,
                        state_pill: "IDLE".into(),
                        currently: None,
                        ctx_pct: None,
                        session_tokens: 0,
                        attempts: 0,
                    },
                )
            })
            .collect();
        Self { id, stage, node_states }
    }

    /// Nodes with no in-edges (or manual/schedule triggers) are the entry set.
    pub fn entry_nodes(&self) -> Vec<&Node> {
        self.stage
            .nodes
            .iter()
            .filter(|n| {
                let has_in_flow = self
                    .stage
                    .edges
                    .iter()
                    .any(|e| e.to == n.id && e.kind == "flow");
                !has_in_flow
                    || matches!(n.trigger.as_deref(), Some(t) if t == "manual" || t.starts_with("schedule:"))
            })
            .collect()
    }

    /// Downstream targets of a completed node, following flow edges.
    pub fn next_nodes(&self, from: &str) -> Vec<&Node> {
        self.stage
            .edges
            .iter()
            .filter(|e| e.from == from && e.kind == "flow")
            .filter_map(|e| self.stage.nodes.iter().find(|n| n.id == e.to))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conductor::stage::Stage;

    fn load_template(name: &str) -> Stage {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../templates")
            .join(format!("{name}.stage.json"));
        Stage::load(&path).expect("template loads and validates")
    }

    #[test]
    fn all_templates_load_and_validate() {
        for t in [
            "ship-a-feature",
            "oss-contributor",
            "bug-hunt",
            "test-coverage",
            "nightly-refactor",
            "docs-sync",
            "pr-babysitter",
        ] {
            let stage = load_template(t);
            assert!(!stage.nodes.is_empty(), "{t} has nodes");
        }
    }

    #[test]
    fn oss_contributor_wiring() {
        let stage = load_template("oss-contributor");
        let run = Run::new("test-run".into(), stage);
        let next: Vec<_> = run.next_nodes("triage").iter().map(|n| n.id.clone()).collect();
        assert_eq!(next, vec!["fix"]);
        assert!(run.node_states.contains_key("lifecycle"));
    }

    #[test]
    fn outward_gates_must_be_human() {
        let mut stage = load_template("ship-a-feature");
        for n in &mut stage.nodes {
            if let Some(g) = &mut n.gate {
                g.mode = crate::conductor::stage::GateMode::Auto;
            }
        }
        assert!(stage.validate().is_err(), "auto outward gate must be rejected");
    }

    #[test]
    fn return_target_falls_back_to_sole_upstream_agent() {
        // Explicit return edge wins when present.
        let stage = load_template("ship-a-feature");
        for e in stage.edges.iter().filter(|e| e.kind == "return") {
            assert_eq!(stage.return_target(&e.from).as_deref(), Some(e.to.as_str()));
        }

        // Strip every return edge: a reviewer with one upstream agent must
        // still route the reject back to it, never dead-end into escalation.
        let mut stripped = load_template("ship-a-feature");
        let explicit: Vec<_> = stripped
            .edges
            .iter()
            .filter(|e| e.kind == "return")
            .map(|e| (e.from.clone(), e.to.clone()))
            .collect();
        assert!(!explicit.is_empty(), "template exercises return edges");
        stripped.edges.retain(|e| e.kind != "return");
        for (from, to) in &explicit {
            let upstream: Vec<_> = stripped
                .edges
                .iter()
                .filter(|e| &e.to == from && e.kind == "flow")
                .collect();
            if upstream.len() == 1 && upstream[0].from == *to {
                assert_eq!(
                    stripped.return_target(from).as_deref(),
                    Some(to.as_str()),
                    "implicit fallback recovers the dropped return edge from {from}"
                );
            }
        }

        // Ambiguity stays None: two upstream agents, no return edge.
        let json = r#"{
            "name": "fanin", "version": "0.1.0", "description": "t",
            "nodes": [
                {"id": "a", "type": "agent", "label": "A", "card": "implementer"},
                {"id": "b", "type": "agent", "label": "B", "card": "implementer"},
                {"id": "verify", "type": "agent", "label": "V", "card": "adversarial-reviewer"}
            ],
            "edges": [
                {"from": "a", "to": "verify"},
                {"from": "b", "to": "verify"}
            ]
        }"#;
        let fanin: Stage = serde_json::from_str(json).unwrap();
        fanin.validate().unwrap();
        assert_eq!(fanin.return_target("verify"), None);
    }

    #[test]
    fn permission_narrowing() {
        use crate::conductor::min_permissions;
        assert_eq!(min_permissions("edit+exec", Some("plan")), "plan");
        assert_eq!(min_permissions("plan", Some("edit+exec")), "plan");
        assert_eq!(min_permissions("edit", None), "edit");
    }
}
