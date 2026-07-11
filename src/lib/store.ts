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

// ---- custom agent cards (backend-persisted to ~/.cuelight/agents) ----

export interface AgentCardFile {
  name: string;
  displayName?: string;
  description: string;
  harness: string;
  permissions: string;
  effort?: string;
  prompt: string;
  tags?: string[];
}

const LS_AGENTS = "cuelight-user-agents";

export async function listUserAgents(): Promise<AgentCardFile[]> {
  try {
    return await invoke<AgentCardFile[]>("list_user_agents");
  } catch {
    try {
      return JSON.parse(localStorage.getItem(LS_AGENTS) ?? "[]");
    } catch {
      return [];
    }
  }
}

export async function saveUserAgent(card: AgentCardFile): Promise<void> {
  try {
    await invoke("save_user_agent", { name: card.name, json: JSON.stringify(card, null, 2) });
  } catch (e) {
    if (typeof e === "string") throw new Error(e);
    const all: AgentCardFile[] = JSON.parse(localStorage.getItem(LS_AGENTS) ?? "[]").filter((a: AgentCardFile) => a.name !== card.name);
    all.push(card);
    localStorage.setItem(LS_AGENTS, JSON.stringify(all));
  }
}

export async function deleteUserAgent(name: string): Promise<void> {
  try {
    await invoke("delete_user_agent", { name });
  } catch (e) {
    if (typeof e === "string") throw new Error(e);
    const all: AgentCardFile[] = JSON.parse(localStorage.getItem(LS_AGENTS) ?? "[]").filter((a: AgentCardFile) => a.name !== name);
    localStorage.setItem(LS_AGENTS, JSON.stringify(all));
  }
}

// ---- custom gate presets (local; they're drag-templates, not conductor-validated) ----

export interface GatePreset {
  name: string;
  label: string;
  mode: "human" | "auto";
  outward: boolean;
  checklist: string[];
}

const LS_GATES = "cuelight-gate-presets";

export function listGatePresets(): GatePreset[] {
  try {
    return JSON.parse(localStorage.getItem(LS_GATES) ?? "[]");
  } catch {
    return [];
  }
}

export function saveGatePreset(preset: GatePreset): void {
  const all = listGatePresets().filter((g) => g.name !== preset.name);
  all.push(preset);
  localStorage.setItem(LS_GATES, JSON.stringify(all));
}

export function deleteGatePreset(name: string): void {
  localStorage.setItem(LS_GATES, JSON.stringify(listGatePresets().filter((g) => g.name !== name)));
}
