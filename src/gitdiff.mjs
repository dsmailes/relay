import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Relay never touches the user's index, branch or HEAD. Snapshots are tree
// objects built through a throwaway index, so they include untracked files and
// ignore anything .gitignore ignores. The Livestock board is excluded because
// Relay itself rewrites it between snapshots.
const BOARD_FILE = ".herdr-issues.json";

function git(cwd, args, { env = {}, input } = {}) {
  const result = spawnSync("git", args, {
    cwd, encoding: "utf8", input, env: { ...process.env, ...env }, maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

export function isGitRepo(cwd) {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
}

export async function snapshotTree(cwd) {
  if (!isGitRepo(cwd)) return null;
  const index = path.join(os.tmpdir(), `relay-index-${randomUUID()}`);
  try {
    const env = { GIT_INDEX_FILE: index };
    if (git(cwd, ["add", "-A"], { env }) === null) return null;
    // Removed from the throwaway index afterwards: an explicit exclude pathspec makes
    // `git add` fail once the board is also in .git/info/exclude.
    if (git(cwd, ["rm", "--cached", "-q", "--ignore-unmatch", "--", BOARD_FILE], { env }) === null) return null;
    return git(cwd, ["write-tree"], { env })?.trim() || null;
  } finally {
    await rm(index, { force: true });
  }
}

/** Diff between two snapshots: { stat, patch, truncated }. */
export function diffTrees(cwd, from, to, { maxBytes = 80_000 } = {}) {
  if (!from || !to) return null;
  const patch = git(cwd, ["diff", "--no-color", "-M", from, to]);
  if (patch === null) return null;
  const stat = git(cwd, ["diff", "--no-color", "--stat", from, to]) || "";
  const truncated = Buffer.byteLength(patch) > maxBytes;
  return { stat: stat.trim(), patch: truncated ? Buffer.from(patch).subarray(0, maxBytes).toString("utf8") : patch, truncated, fullPatch: patch };
}

/** Records a recoverable checkpoint as a commit under refs/relay/..., without moving any branch. */
export function saveCheckpoint(cwd, tree, ref, message) {
  if (!tree) return null;
  const parent = git(cwd, ["rev-parse", "--verify", "-q", "HEAD"])?.trim();
  const env = {
    GIT_AUTHOR_NAME: "Harness Relay", GIT_AUTHOR_EMAIL: "relay@localhost",
    GIT_COMMITTER_NAME: "Harness Relay", GIT_COMMITTER_EMAIL: "relay@localhost",
  };
  const commit = git(cwd, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], { env })?.trim();
  if (!commit || git(cwd, ["update-ref", ref, commit]) === null) return null;
  return commit;
}

/** Keeps the Livestock board out of `git status` without editing tracked files. */
export async function excludeBoardLocally(cwd) {
  if (!isGitRepo(cwd)) return;
  if (git(cwd, ["ls-files", "--error-unmatch", BOARD_FILE]) !== null) return; // already tracked
  const excludeRel = git(cwd, ["rev-parse", "--git-path", "info/exclude"])?.trim();
  if (!excludeRel) return;
  const exclude = path.resolve(cwd, excludeRel);
  let current = "";
  try { current = await readFile(exclude, "utf8"); } catch { /* created below */ }
  if (current.split("\n").some((line) => line.trim() === BOARD_FILE)) return;
  await mkdir(path.dirname(exclude), { recursive: true });
  await appendFile(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}${BOARD_FILE}\n`);
}
