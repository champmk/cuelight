//! Stage spec types — the Rust mirror of `schema/stage.schema.json`.
//! Loading validates against the JSON schema first, then enforces the one
//! invariant the schema can't express: outward gates must be human.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub name: String,
    pub version: String,
    pub description: String,
    #[serde(default)]
    pub target: Target,
    #[serde(default)]
    pub defaults: Defaults,
    #[serde(default)]
    pub caps: Caps,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    /// Saved canvas positions ({nodeId: {x, y}}); UI-only, conductor ignores it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub repo_path: Option<String>,
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Defaults {
    pub harness: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Caps {
    pub max_concurrent_sessions: Option<u32>,
    pub max_sessions_per_day: Option<u32>,
    pub max_open_prs: Option<u32>,
    pub max_open_prs_per_repo: Option<u32>,
    #[serde(default)]
    pub quota_priority: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: NodeType,
    pub label: Option<String>,
    pub card: Option<String>,
    pub harness: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub prompt_context: Option<String>,
    pub permissions: Option<String>,
    pub trigger: Option<String>,
    #[serde(default)]
    pub kill_gates: Vec<KillGate>,
    pub gate: Option<GateConfig>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeType {
    Agent,
    Gate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KillGate {
    pub check: String,
    pub arg: Option<String>,
    #[serde(default = "default_on_fail")]
    pub on_fail: String,
    pub max_retries: Option<u32>,
}

fn default_on_fail() -> String {
    "kill".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateConfig {
    pub mode: GateMode,
    #[serde(default)]
    pub outward: bool,
    pub batch_limit_per_day: Option<u32>,
    #[serde(default)]
    pub checklist: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GateMode {
    Human,
    Auto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edge {
    pub from: String,
    pub to: String,
    #[serde(default = "default_edge_kind")]
    pub kind: String,
    pub label: Option<String>,
    /// Verdict condition: this edge fires only when the source node's
    /// structured verdict matches ("pass" / "reject"). Unconditioned edges
    /// are the default path. This is how a graph routes on outcomes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
}

fn default_edge_kind() -> String {
    "flow".into()
}

#[derive(Debug, thiserror::Error)]
pub enum StageError {
    #[error("cannot read stage file: {0}")]
    Io(#[from] std::io::Error),
    #[error("stage is not valid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("stage violates schema: {0}")]
    Schema(String),
    #[error("SAFETY: gate `{0}` is outward-facing but not human-mode; refusing to load")]
    OutwardGateNotHuman(String),
    #[error("edge references unknown node `{0}`")]
    DanglingEdge(String),
    #[error("agent node `{0}` has no card")]
    MissingCard(String),
}

impl Stage {
    /// Load and validate. This is the only entry point — nothing in the
    /// conductor constructs a Stage from unvalidated input.
    pub fn load(path: &Path) -> Result<Self, StageError> {
        let raw = std::fs::read_to_string(path)?;
        let stage: Stage = serde_json::from_str(&raw)?;
        stage.validate()?;
        Ok(stage)
    }

    pub fn validate(&self) -> Result<(), StageError> {
        let ids: HashSet<&str> = self.nodes.iter().map(|n| n.id.as_str()).collect();
        for e in &self.edges {
            for end in [&e.from, &e.to] {
                if !ids.contains(end.as_str()) {
                    return Err(StageError::DanglingEdge(end.clone()));
                }
            }
        }
        for n in &self.nodes {
            match n.node_type {
                NodeType::Agent => {
                    if n.card.is_none() {
                        return Err(StageError::MissingCard(n.id.clone()));
                    }
                }
                NodeType::Gate => {
                    if let Some(g) = &n.gate {
                        // The invariant the whole product leans on.
                        if g.outward && g.mode != GateMode::Human {
                            return Err(StageError::OutwardGateNotHuman(n.id.clone()));
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Flow-edge predecessor ids of `to`, deduplicated, in spec order.
    pub fn flow_preds(&self, to: &str) -> Vec<String> {
        let mut v: Vec<String> = Vec::new();
        for e in self.edges.iter().filter(|e| e.to == to && e.kind == "flow") {
            if !v.contains(&e.from) {
                v.push(e.from.clone());
            }
        }
        v
    }

    /// Forward targets out of `from` for a completed node. Verdict-conditioned
    /// edges are exceptions to the default path: when at least one `when`
    /// matches the verdict, exactly the matching set fires; otherwise the
    /// unconditioned edges do.
    pub fn flow_targets(&self, from: &str, verdict: Option<&str>) -> Vec<String> {
        let out: Vec<&Edge> = self.edges.iter().filter(|e| e.from == from && e.kind == "flow").collect();
        let matched: Vec<String> = out
            .iter()
            .filter(|e| e.when.is_some() && e.when.as_deref() == verdict)
            .map(|e| e.to.clone())
            .collect();
        if !matched.is_empty() {
            return matched;
        }
        out.iter().filter(|e| e.when.is_none()).map(|e| e.to.clone()).collect()
    }

    /// Everywhere a rejection from `from` can route, in preference order:
    /// explicit `when: "reject"` edges, explicit return edges, else every
    /// upstream agent — the nodes whose work was under review. Empty only
    /// for a node with no route at all; that genuinely needs a human.
    pub fn reject_targets(&self, from: &str) -> Vec<String> {
        let when: Vec<String> = self
            .edges
            .iter()
            .filter(|e| e.from == from && e.when.as_deref() == Some("reject"))
            .map(|e| e.to.clone())
            .collect();
        if !when.is_empty() {
            return when;
        }
        let ret: Vec<String> = self
            .edges
            .iter()
            .filter(|e| e.from == from && e.kind == "return")
            .map(|e| e.to.clone())
            .collect();
        if !ret.is_empty() {
            return ret;
        }
        self.flow_preds(from)
            .into_iter()
            .filter(|p| self.nodes.iter().any(|n| n.id == *p && n.node_type == NodeType::Agent))
            .collect()
    }
}
