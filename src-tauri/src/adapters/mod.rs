//! Harness adapters: one thin driver per coding-agent CLI.
//!
//! Invariants every adapter must uphold:
//! - Auth belongs to the CLI. Adapters never read, store, or forward
//!   credentials; they detect "not logged in" and report it as a typed error.
//! - Subscription-first. An adapter whose only auth path is an API key does
//!   not belong in this tree.
//! - Streaming, not scraping. Adapters parse the CLI's structured output mode
//!   (`--output-format stream-json` etc.), never its human-readable TUI.

pub mod claude;
pub mod grok;

use std::path::PathBuf;
use tokio::sync::mpsc;

use crate::events::SessionEvent;

#[derive(Debug, thiserror::Error)]
pub enum AdapterError {
    #[error("harness CLI `{0}` not found on PATH")]
    NotInstalled(String),
    #[error("harness `{0}` is not authenticated — run it interactively once to log in")]
    NotAuthenticated(String),
    #[error("failed to spawn session: {0}")]
    Spawn(#[from] std::io::Error),
}

/// Everything a session needs to start. The conductor owns worktree creation;
/// adapters just receive a directory they may treat as disposable.
#[derive(Debug, Clone)]
pub struct SessionSpec {
    /// Full composed prompt: agent card prompt + stage promptContext + task payload.
    pub prompt: String,
    /// Working directory (a git worktree unless isolation=none).
    pub workdir: PathBuf,
    /// Model override, if the node/card pins one.
    pub model: Option<String>,
    /// Effort/reasoning level where the harness supports it.
    pub effort: Option<String>,
    /// Permission ceiling: "plan" | "edit" | "edit+exec".
    pub permissions: String,
}

/// A live session: a handle to cancel it and the event stream it produces.
pub struct SessionHandle {
    pub events: mpsc::Receiver<SessionEvent>,
    pub cancel: tokio::sync::oneshot::Sender<()>,
}

#[async_trait::async_trait]
pub trait HarnessAdapter: Send + Sync {
    /// Stable identifier used in stage specs ("claude", "grok").
    fn id(&self) -> &'static str;

    /// Cheap preflight: is the CLI on PATH and logged in? Called by the smoke
    /// test and before every run. Must not consume meaningful quota.
    async fn preflight(&self) -> Result<(), AdapterError>;

    /// Spawn a headless session. Implementations translate the CLI's stream
    /// into `SessionEvent`s and must always terminate the stream with exactly
    /// one `Done` or `Failed`.
    async fn spawn(&self, spec: SessionSpec) -> Result<SessionHandle, AdapterError>;
}

/// Map a permission ceiling to CLI flags, shared by adapters where semantics
/// align. Each adapter may override; the conductor already took the more
/// restrictive of card vs node before this point.
pub fn permission_args(permissions: &str) -> Vec<&'static str> {
    match permissions {
        "plan" => vec!["--permission-mode", "plan"],
        "edit" => vec!["--permission-mode", "acceptEdits"],
        _ => vec!["--permission-mode", "acceptAll"],
    }
}
