//! Grok Build adapter: drives `grok -p --output-format streaming-json`.
//! Auth rides the user's one-time browser OAuth (SuperGrok / X Premium+);
//! headless runs reuse the cached login. The adapter never touches
//! credentials and never sets XAI_API_KEY.
//!
//! Real stream shape (grok 0.2.93, verified against the CLI):
//!   {"type":"thought","data":"<token>"}   reasoning, token by token
//!   {"type":"text","data":"<token>"}       output, token by token
//!   {"type":"end","stopReason":"EndTurn","sessionId":...,"requestId":...}
//! Tool calls are NOT surfaced as discrete events in this version, so the
//! adapter streams reasoning/output and reports completion; the "currently"
//! line comes from the reasoning stream rather than tool targets.

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
        let creds = dirs_home().join(".grok").join("auth.json");
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
        // edit+exec sessions must not block on approval prompts headlessly.
        if spec.permissions == "edit+exec" || spec.permissions == "edit" {
            cmd.arg("--always-approve");
        }

        let mut child = cmd.spawn()?;
        let stdout = child.stdout.take().expect("piped stdout");
        let (tx, rx) = mpsc::channel::<SessionEvent>(256);
        let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();

        tokio::spawn(async move {
            let _ = tx.send(SessionEvent::Started { harness: "grok".into(), model: None }).await;
            let mut lines = BufReader::new(stdout).lines();

            let mut text_buf = String::new(); // full output (returned as result)
            let mut pending = String::new(); // buffer flushed to the feed on sentence/size
            let mut thought = String::new(); // latest reasoning fragment for "currently"
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
                            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                            match v.get("type").and_then(|t| t.as_str()) {
                                Some("thought") => {
                                    let tok = v.get("data").and_then(|d| d.as_str()).unwrap_or("");
                                    thought.push_str(tok);
                                    // Surface a reasoning fragment when a sentence lands.
                                    if ends_clause(tok) && thought.trim().len() > 8 {
                                        let frag = last_sentence(&thought);
                                        let _ = tx.send(SessionEvent::Text { text: format!("… {frag}") }).await;
                                        thought.clear();
                                    }
                                }
                                Some("text") => {
                                    let tok = v.get("data").and_then(|d| d.as_str()).unwrap_or("");
                                    text_buf.push_str(tok);
                                    pending.push_str(tok);
                                    if pending.len() > 90 || tok.contains('\n') {
                                        let chunk = std::mem::take(&mut pending);
                                        let chunk = chunk.trim();
                                        if !chunk.is_empty() {
                                            let _ = tx.send(SessionEvent::Text { text: chunk.to_string() }).await;
                                        }
                                    }
                                }
                                Some("tool") | Some("tool_call") | Some("action") => {
                                    // Some builds emit a tool line; surface it if present.
                                    let name = v.get("name").and_then(|n| n.as_str())
                                        .or_else(|| v.get("tool").and_then(|n| n.as_str()))
                                        .unwrap_or("tool");
                                    let target = v.pointer("/data/path")
                                        .or_else(|| v.pointer("/args/path"))
                                        .or_else(|| v.pointer("/data/command"))
                                        .and_then(|t| t.as_str())
                                        .unwrap_or("");
                                    let _ = tx.send(SessionEvent::ToolCall { tool: name.to_string(), target: target.to_string() }).await;
                                }
                                Some("error") => {
                                    let msg = v.get("data").and_then(|d| d.as_str())
                                        .or_else(|| v.get("message").and_then(|m| m.as_str()))
                                        .unwrap_or("error");
                                    let _ = tx.send(SessionEvent::Failed { error: msg.to_string() }).await;
                                    done_sent = true;
                                }
                                Some("end") => {
                                    let stop = v.get("stopReason").and_then(|s| s.as_str()).unwrap_or("");
                                    if !pending.trim().is_empty() {
                                        let _ = tx.send(SessionEvent::Text { text: pending.trim().to_string() }).await;
                                    }
                                    let ok = stop == "EndTurn" || stop.is_empty();
                                    let structured = extract_json(&text_buf);
                                    let _ = tx.send(SessionEvent::Done { ok, result_text: text_buf.clone(), structured }).await;
                                    done_sent = true;
                                }
                                _ => {}
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
                let ev = if ok && !text_buf.is_empty() {
                    SessionEvent::Done { ok: true, result_text: text_buf.clone(), structured: extract_json(&text_buf) }
                } else {
                    SessionEvent::Failed { error: "grok exited without an end event".into() }
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

fn ends_clause(tok: &str) -> bool {
    tok.ends_with('.') || tok.ends_with('\n') || tok.ends_with(':') || tok.ends_with(';')
}

fn last_sentence(s: &str) -> String {
    let t = s.trim();
    let start = t.rfind(['.', '\n', ':', ';']).map(|i| i + 1).unwrap_or(0);
    let frag = t[start..].trim();
    let frag = if frag.is_empty() { t } else { frag };
    if frag.len() > 90 { format!("{}…", &frag[..90]) } else { frag.to_string() }
}

/// Pull a JSON object out of the output text for structured-verdict gates.
fn extract_json(s: &str) -> Option<serde_json::Value> {
    let start = s.find('{')?;
    let end = s.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str(&s[start..=end]).ok()
}
