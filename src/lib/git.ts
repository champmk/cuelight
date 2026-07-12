// Frontend mirror of the git_probe / git_init_repo commands: one call tells
// the UI everything about a target path — repo or not, branch, remote,
// worktrees, and whether gh is available for PR ship actions.

import { invoke } from "@tauri-apps/api/core";

export interface GitWorktree {
  path: string;
  branch: string;
}

export interface GitProbe {
  isDir: boolean;
  isRepo: boolean;
  root?: string | null;
  branch?: string | null;
  hasCommits: boolean;
  remoteUrl?: string | null;
  gh: boolean;
  worktrees: GitWorktree[];
  branches: string[];
  dirtyFiles: number;
  fileEstimate: number;
}

/** What a repo can actually ship — drives which gate actions are offered. */
export interface RepoCaps {
  remote: boolean;
  gh: boolean;
}

export function capsOf(p: GitProbe): RepoCaps {
  return { remote: !!p.remoteUrl, gh: p.gh };
}

export function probeRepo(path: string): Promise<GitProbe> {
  return invoke<GitProbe>("git_probe", { path });
}

export function initRepo(path: string, commitExisting: boolean): Promise<string> {
  return invoke<string>("git_init_repo", { path, commitExisting });
}

/** Short display form of a remote URL: github.com/owner/repo */
export function shortRemote(url: string): string {
  return url
    .replace(/^git@/, "")
    .replace(/^https?:\/\//, "")
    .replace(/:/, "/")
    .replace(/\/\//g, "/")
    .replace(/\.git$/, "");
}
