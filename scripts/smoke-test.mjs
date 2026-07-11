#!/usr/bin/env node
// M0 smoke test — the assumption everything else stands on:
// harness CLIs must run HEADLESS on cached subscription auth (no API keys).
// Run: pnpm smoke [--live]  (--live sends one tiny real prompt per harness)

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const live = process.argv.includes("--live");
const results = [];

function report(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function checkCli(bin) {
  try {
    const { stdout } = await run(bin, ["--version"], { timeout: 15000, shell: true });
    return stdout.trim().split("\n")[0];
  } catch {
    return null;
  }
}

async function livePrompt(bin, args) {
  // A one-word task; verifies headless auth + structured output end to end.
  // shell:true concatenates args on Windows, so quote anything with spaces.
  const quoted = args.map((a) => (/\s/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a));
  const { stdout } = await run(bin, quoted, { timeout: 120000, shell: true });
  return stdout.length > 0;
}

console.log("\ncuelight smoke test — headless harness auth\n");

// Rust toolchain (needed to build the app itself, not to run harnesses)
const cargo = await checkCli("cargo");
report("rust toolchain (cargo)", !!cargo, cargo ?? "install from https://rustup.rs");

// Claude Code
const claude = await checkCli("claude");
if (!claude) {
  report("claude CLI", false, "not on PATH — install Claude Code and log in once");
} else {
  report("claude CLI", true, claude);
  if (live) {
    try {
      const ok = await livePrompt("claude", ["-p", "Reply with exactly: ok", "--output-format", "json"]);
      report("claude headless (subscription auth)", ok);
    } catch (e) {
      report("claude headless (subscription auth)", false, String(e.message ?? e).slice(0, 200));
    }
  }
}

// Grok Build
const grok = await checkCli("grok");
if (!grok) {
  report("grok CLI", false, "not on PATH — install Grok Build and complete browser OAuth once");
} else {
  report("grok CLI", true, grok);
  const creds = join(homedir(), ".grok", "auth.json");
  report("grok cached OAuth", existsSync(creds), existsSync(creds) ? creds : "no cached login found — run `grok` interactively once");
  if (process.env.XAI_API_KEY) {
    report("no API-key billing", false, "XAI_API_KEY is set — headless runs would bill per-token. Unset it; Cuelight uses subscription auth only.");
  } else {
    report("no API-key billing", true, "XAI_API_KEY not set");
  }
  if (live) {
    try {
      const ok = await livePrompt("grok", ["-p", "Reply with exactly: ok", "--output-format", "streaming-json"]);
      report("grok headless (subscription auth)", ok);
    } catch (e) {
      report("grok headless (subscription auth)", false, String(e.message ?? e).slice(0, 200));
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${live ? "" : "  (add --live to send a real one-word prompt per harness)"}\n`);
process.exit(failed.length > 0 ? 1 : 0);
