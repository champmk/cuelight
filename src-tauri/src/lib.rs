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

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            preflight_harnesses,
            load_stage,
            list_templates,
            list_user_templates,
            save_user_template,
            delete_user_template
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cuelight");
}
