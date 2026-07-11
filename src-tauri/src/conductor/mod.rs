//! The conductor: owns the graph, schedules sessions, enforces gates and caps,
//! journals everything. The canvas is a view over this module's state; the
//! adapters are its hands.
//!
//! M1 status: stage loading/validation, journal, and the scheduling skeleton
//! are real; worktree management and kill-gate evaluation are implemented;
//! cron triggers and the quota governor are wired but minimal. See PLAN.md
//! milestones.

pub mod journal;
pub mod quota;
pub mod scheduler;
pub mod stage;

use std::path::PathBuf;

/// Where a project's Cuelight state lives: `<repo>/.cuelight/` (gitignored).
pub fn state_dir(repo_path: &str) -> PathBuf {
    PathBuf::from(repo_path).join(".cuelight")
}

/// Compose the full prompt for an agent session:
/// card prompt + stage-specific context + the task payload from upstream.
pub fn compose_prompt(card_prompt: &str, prompt_context: Option<&str>, task_payload: &str) -> String {
    let mut out = String::with_capacity(card_prompt.len() + task_payload.len() + 256);
    out.push_str(card_prompt);
    if let Some(ctx) = prompt_context {
        out.push_str("\n\n## Stage context\n");
        out.push_str(ctx);
    }
    if !task_payload.is_empty() {
        out.push_str("\n\n## Task\n");
        out.push_str(task_payload);
    }
    out
}

/// The more restrictive of two permission ceilings — conductor policy is that
/// a node can narrow a card's permissions but never widen them.
pub fn min_permissions<'a>(card: &'a str, node: Option<&'a str>) -> &'a str {
    fn rank(p: &str) -> u8 {
        match p {
            "plan" => 0,
            "edit" => 1,
            _ => 2,
        }
    }
    match node {
        Some(n) if rank(n) < rank(card) => n,
        _ => card,
    }
}
