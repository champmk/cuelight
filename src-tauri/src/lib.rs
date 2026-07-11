//! Cuelight — the live canvas for agent orchestration.
//! This crate is the conductor (brain) and adapters (hands); the React canvas
//! in `../src` is the face. Typed events cross the IPC boundary; nothing else.

pub mod adapters;
pub mod conductor;
pub mod events;

use adapters::{claude::ClaudeAdapter, grok::GrokAdapter, HarnessAdapter};
use conductor::stage::Stage;

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

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            preflight_harnesses,
            load_stage,
            list_templates
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cuelight");
}
