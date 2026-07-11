//! Claude Code adapter: drives `claude -p --output-format stream-json`.
//! Auth rides the user's claude.ai login (Pro/Max subscription); the adapter
//! never touches credentials.

use async_trait::async_trait;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

use super::{permission_args, AdapterError, HarnessAdapter, SessionHandle, SessionSpec};
use crate::events::SessionEvent;
use crate::quiet::Quiet;

pub struct ClaudeAdapter;

#[async_trait]
impl HarnessAdapter for ClaudeAdapter {
    fn id(&self) -> &'static str {
        "claude"
    }

    async fn preflight(&self) -> Result<(), AdapterError> {
        let out = Command::new(super::resolve_bin("claude"))
            .quiet()
            .arg("--version")
            .output()
            .await
            .map_err(|_| AdapterError::NotInstalled("claude".into()))?;
        if !out.status.success() {
            return Err(AdapterError::NotInstalled("claude".into()));
        }
        Ok(())
    }

    async fn spawn(&self, spec: SessionSpec) -> Result<SessionHandle, AdapterError> {
        let mut cmd = Command::new(super::resolve_bin("claude"));
        cmd.quiet()
            .arg("-p")
            .arg(&spec.prompt)
            .args(["--output-format", "stream-json", "--verbose"])
            .args(permission_args(&spec.permissions))
            .current_dir(&spec.workdir)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .stdin(std::process::Stdio::null());
        if let Some(model) = &spec.model {
            cmd.args(["--model", model]);
        }

        let mut child = cmd.spawn()?;
        if let Some(pid) = child.id() {
            crate::procjob::contain(pid);
        }
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
                    SessionEvent::Done { ok: true, result_text: String::new(), structured: None, resume_id: None }
                } else {
                    SessionEvent::Failed { error: "process exited without a result message".into() }
                };
                let _ = tx.send(ev).await;
            }
        });

        Ok(SessionHandle { events: rx, cancel: cancel_tx })
    }
}

/// Translate one line of Claude Code's stream-json into the normalized
/// vocabulary. Unknown message types are ignored on purpose — additive CLI
/// changes must not break running stages. The contract tests in
/// `tests/fixtures/claude/` pin the shapes we depend on.
fn parse_stream_line(line: &str) -> Option<SessionEvent> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    match v.get("type")?.as_str()? {
        "system" => Some(SessionEvent::Started {
            harness: "claude".into(),
            model: v.get("model").and_then(|m| m.as_str()).map(String::from),
        }),
        "assistant" => {
            let content = v.pointer("/message/content")?.as_array()?;
            for block in content {
                match block.get("type").and_then(|t| t.as_str()) {
                    Some("tool_use") => {
                        let tool = block.get("name")?.as_str()?.to_string();
                        let input = block.get("input").cloned().unwrap_or_default();
                        let target = input
                            .get("file_path")
                            .or_else(|| input.get("command"))
                            .or_else(|| input.get("pattern"))
                            .and_then(|t| t.as_str())
                            .unwrap_or("")
                            .to_string();
                        return Some(SessionEvent::ToolCall { tool, target });
                    }
                    Some("text") => {
                        let text = block.get("text")?.as_str()?.to_string();
                        if !text.is_empty() {
                            return Some(SessionEvent::Text { text });
                        }
                    }
                    _ => {}
                }
            }
            None
        }
        "result" => {
            let ok = v.get("subtype").and_then(|s| s.as_str()) == Some("success");
            let result_text = v.get("result").and_then(|r| r.as_str()).unwrap_or("").to_string();
            let structured = serde_json::from_str(&result_text).ok();
            Some(SessionEvent::Done { ok, result_text, structured, resume_id: None })
        }
        _ => None,
    }
}
