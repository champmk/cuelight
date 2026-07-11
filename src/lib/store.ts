// User-template persistence. Inside the Tauri shell templates are real files
// in ~/.cuelight/templates/ (validated by the Rust loader before writing);
// in plain-browser dev they fall back to localStorage so the feature still
// works end to end.

import { invoke } from "@tauri-apps/api/core";
import type { StageSpec } from "../types";

const LS_KEY = "cuelight-user-templates";

function lsRead(): StageSpec[] {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function lsWrite(all: StageSpec[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(all));
}

export async function listUserTemplates(): Promise<StageSpec[]> {
  try {
    return await invoke<StageSpec[]>("list_user_templates");
  } catch {
    return lsRead();
  }
}

export async function saveUserTemplate(spec: StageSpec): Promise<void> {
  try {
    await invoke("save_user_template", { name: spec.name, json: JSON.stringify(spec, null, 2) });
  } catch (e) {
    // Browser fallback — but re-throw real validation errors from the Rust side.
    if (typeof e === "string") throw new Error(e);
    const all = lsRead().filter((t) => t.name !== spec.name);
    all.push(spec);
    lsWrite(all);
  }
}

export async function deleteUserTemplate(name: string): Promise<void> {
  try {
    await invoke("delete_user_template", { name });
  } catch (e) {
    if (typeof e === "string") throw new Error(e);
    lsWrite(lsRead().filter((t) => t.name !== name));
  }
}
