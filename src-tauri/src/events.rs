//! The normalized event vocabulary. Every harness adapter translates its CLI's
//! streaming output into these; the conductor journals them and the canvas
//! renders them. This enum is the contract between all three layers — additive
//! changes only once 0.1 ships.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionEvent {
    /// Session process spawned and accepted the prompt.
    Started { harness: String, model: Option<String> },
    /// The agent produced narrative text (thinking summaries, status prose).
    Text { text: String },
    /// The agent invoked a tool. `target` is the human-legible object — a file
    /// path for edits, a command line for exec — used verbatim by the canvas
    /// for the "currently: editing lib/alt/solve.rs" line.
    ToolCall { tool: String, target: String },
    /// A tool finished; `ok` drives the inline ✓/✗ in the live feed.
    ToolResult { tool: String, ok: bool, summary: String },
    /// Periodic usage snapshot when the harness reports one.
    Usage {
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        context_used: Option<u64>,
        context_limit: Option<u64>,
    },
    /// The harness reported a quota / rate-limit condition. The quota governor
    /// reacts to this; the canvas shows the amber "waiting on quota" cue.
    RateLimited { retry_after_secs: Option<u64> },
    /// The session needs input it cannot get headlessly. In Cuelight this is a
    /// bug in the stage design (headless sessions must be self-sufficient), so
    /// it surfaces loudly instead of hanging.
    AwaitingInput { prompt: String },
    /// Terminal: the session finished. `result_text` is the agent's final
    /// message; `structured` is its parsed JSON when the card demands one.
    Done {
        ok: bool,
        result_text: String,
        structured: Option<serde_json::Value>,
    },
    /// Terminal: the process died or emitted unparseable output.
    Failed { error: String },
}

/// An event as journaled and as emitted to the canvas: the raw `SessionEvent`
/// plus the coordinates that locate it in a run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunEvent {
    pub run_id: String,
    pub node_id: String,
    pub session_id: String,
    pub seq: u64,
    pub at: DateTime<Utc>,
    #[serde(flatten)]
    pub event: SessionEvent,
}

/// Node lifecycle states as shown by the cue light. Kept deliberately small:
/// these five ARE the product's visual vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CueState {
    Idle,
    Standby,
    Working,
    Blocked,
    Failed,
}
