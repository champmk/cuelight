//! Grok Build adapter: drives `grok -p --output-format streaming-json`.
//! Auth rides the user's one-time browser OAuth (SuperGrok / X Premium+);
//! headless runs reuse the cached login. The adapter never touches
//! credentials and never sets XAI_API_KEY.
//!
//! NOTE: Grok Build is in beta and its stream shape is pinned by the fixture
//! tests in `tests/fixtures/grok/`. When xAI changes the format, the fixtures
//! fail loudly and only this file needs to move.

use async_trait::async_trait;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

use super::{AdapterError, HarnessAdapter, SessionHandle, SessionSpec};
use crate::events::SessionEvent;

pub struct GrokAdapter;

#[async_trait]
impl HarnessAdapter for GrokAdapter {
    fn id(&self) -> &'static str {
        "grok"
    }

    async fn preflight(&self) -> Result<(), AdapterError> {
        let out = Command::new("grok")
            .arg("--version")
            .output()
            .await
            .map_err(|_| AdapterError::NotInstalled("grok".into()))?;
        if !out.status.success() {
            return Err(AdapterError::NotInstalled("grok".into()));
        }
        // A cheap no-op prompt would burn quota; instead check for the cached
        // credential file Grok Build writes after browser OAuth.
        let creds = dirs_home().join(".grok").join("credentials.json");
        if !creds.exists() {
            return Err(AdapterError::NotAuthenticated("grok".into()));
        }
        Ok(())
    }

    async fn spawn(&self, spec: SessionSpec) -> Result<SessionHandle, AdapterError> {
        let mut cmd = Command::new("grok");
        cmd.arg("-p")
            .arg(&spec.prompt)
            .args(["--output-format", "streaming-json"])
            .current_dir(&spec.workdir)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .stdin(std::process::Stdio::null());
        if let Some(model) = &spec.model {
            cmd.args(["--model", model]);
        }
        if let Some(effort) = &spec.effort {
            cmd.args(["--effort", effort]);
        }
        if spec.permissions == "edit+exec" {
            cmd.arg("--always-approve");
        }

        let mut child = cmd.spawn()?;
        let stdout = child.stdout.take().expect("piped stdout");
        let (tx, rx) = mpsc::channel::<SessionEvent>(256);
        let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();

        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let mut done_sent = false;
            loop {
                tokio::select! {
                    _ = &mut cancel_rx => {
                        let _ = child.kill().await;
                        let _ = tx.send(SessionEvent::Failed { error: "killed by operator".into() }).await;
                        return;
                    }
                    line = lines.next_line() => match line {
                        Ok(Some(line)) => {
                            if let Some(ev) = parse_stream_line(&line) {
                                done_sent |= matches!(ev, SessionEvent::Done { .. } | SessionEvent::Failed { .. });
                                if tx.send(ev).await.is_err() { return; }
                            }
                        }
                        Ok(None) => break,
                        Err(e) => {
                            let _ = tx.send(SessionEvent::Failed { error: e.to_string() }).await;
                            return;
                        }
                    }
                }
            }
            let status = child.wait().await;
            if !done_sent {
                let ok = status.map(|s| s.success()).unwrap_or(false);
                let ev = if ok {
                    SessionEvent::Done { ok: true, result_text: String::new(), structured: None }
                } else {
                    SessionEvent::Failed { error: "process exited without a result message".into() }
                };
                let _ = tx.send(ev).await;
            }
        });

        Ok(SessionHandle { events: rx, cancel: cancel_tx })
    }
}

fn dirs_home() -> std::path::PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
        .unwrap_or_default()
}

/// Grok Build streaming-json → normalized events. Shape pinned by fixtures;
/// unknown types ignored by design.
fn parse_stream_line(line: &str) -> Option<SessionEvent> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    match v.get("type")?.as_str()? {
        "session_start" => Some(SessionEvent::Started {
            harness: "grok".into(),
            model: v.get("model").and_then(|m| m.as_str()).map(String::from),
        }),
        "text" => Some(SessionEvent::Text {
            text: v.get("text")?.as_str()?.to_string(),
        }),
        "tool_call" => Some(SessionEvent::ToolCall {
            tool: v.get("tool")?.as_str()?.to_string(),
            target: v
                .pointer("/args/path")
                .or_else(|| v.pointer("/args/command"))
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string(),
        }),
        "tool_result" => Some(SessionEvent::ToolResult {
            tool: v.get("tool").and_then(|t| t.as_str()).unwrap_or("").to_string(),
            ok: v.get("ok").and_then(|o| o.as_bool()).unwrap_or(true),
            summary: v.get("summary").and_then(|s| s.as_str()).unwrap_or("").to_string(),
        }),
        "usage" => Some(SessionEvent::Usage {
            input_tokens: v.pointer("/input_tokens").and_then(|t| t.as_u64()),
            output_tokens: v.pointer("/output_tokens").and_then(|t| t.as_u64()),
            context_used: v.pointer("/context/used").and_then(|t| t.as_u64()),
            context_limit: v.pointer("/context/limit").and_then(|t| t.as_u64()),
        }),
        "rate_limit" => Some(SessionEvent::RateLimited {
            retry_after_secs: v.get("retry_after").and_then(|t| t.as_u64()),
        }),
        "result" => {
            let ok = v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false);
            let result_text = v.get("text").and_then(|r| r.as_str()).unwrap_or("").to_string();
            let structured = serde_json::from_str(&result_text).ok();
            Some(SessionEvent::Done { ok, result_text, structured })
        }
        _ => None,
    }
}
