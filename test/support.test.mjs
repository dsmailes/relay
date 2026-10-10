import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTickets, readTicket, updateTicket } from "../src/board.mjs";
import { diffTrees, excludeBoardLocally, saveCheckpoint, snapshotTree } from "../src/gitdiff.mjs";
import { detectInstalled, parseSelection } from "../src/harnesses.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });

async function repo() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "relay-git-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "t@t");
  git(cwd, "config", "user.name", "t");
  await writeFile(path.join(cwd, "a.txt"), "one\n");
  git(cwd, "add", "a.txt");
  git(cwd, "commit", "-qm", "init");
  return cwd;
}

test("snapshots capture untracked files, per-task diffs, and never touch the index or HEAD", async () => {
  const cwd = await repo();
  const head = git(cwd, "rev-parse", "HEAD");
  await writeFile(path.join(cwd, "pre-existing.txt"), "user's own work\n");
  const base = await snapshotTree(cwd);
  await writeFile(path.join(cwd, "a.txt"), "one\ntwo\n");
  await writeFile(path.join(cwd, "new.txt"), "new\n");
  const next = await snapshotTree(cwd);
  const diff = diffTrees(cwd, base, next);
  assert.match(diff.patch, /\+two/);
  assert.match(diff.patch, /new\.txt/);
  assert.doesNotMatch(diff.patch, /pre-existing/);
  assert.equal(git(cwd, "rev-parse", "HEAD"), head);
  assert.equal(git(cwd, "diff", "--cached", "--name-only"), "");
  const commit = saveCheckpoint(cwd, next, "refs/relay/test/task-1", "checkpoint");
  assert.equal(git(cwd, "rev-parse", "refs/relay/test/task-1").trim(), commit);
  assert.equal(git(cwd, "rev-parse", "HEAD"), head);
});

test("the Livestock board is excluded from snapshots and from git status", async () => {
  const cwd = await repo();
  const base = await snapshotTree(cwd);
  await writeFile(path.join(cwd, ".herdr-issues.json"), "{}");
  assert.equal(await snapshotTree(cwd), base);
  await excludeBoardLocally(cwd);
  await excludeBoardLocally(cwd);
  assert.equal(await snapshotTree(cwd), base, "snapshots still work once the board is git-excluded");
  assert.equal(git(cwd, "status", "--porcelain"), "");
  assert.equal((await readFile(path.join(cwd, ".git/info/exclude"), "utf8")).match(/\.herdr-issues\.json/g).length, 1);
});

test("large diffs are truncated for the prompt but kept whole", async () => {
  const cwd = await repo();
  const base = await snapshotTree(cwd);
  await writeFile(path.join(cwd, "big.txt"), "x".repeat(500) + "\n");
  const diff = diffTrees(cwd, base, await snapshotTree(cwd), { maxBytes: 100 });
  assert.equal(diff.truncated, true);
  assert.ok(diff.fullPatch.length > diff.patch.length);
});

test("non-git folders degrade to null", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "relay-nogit-"));
  assert.equal(await snapshotTree(cwd), null);
  assert.equal(diffTrees(cwd, null, null), null);
});

test("board tickets: create, update, preserve concurrent changes", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "relay-board-"));
  const tickets = await createTickets({ cwd, runId: "run-1", title: "T", request: "R",
    tasks: [{ title: "one", acceptanceCriteria: "c1" }, { title: "two", acceptanceCriteria: "c2" }] });
  assert.equal(tickets.taskTicketIds.length, 2);
  await Promise.all(tickets.taskTicketIds.map((id) => updateTicket(cwd, id, { status: "done", note: "hi" })));
  for (const id of tickets.taskTicketIds) assert.equal((await readTicket(cwd, id)).status, "done");
  assert.equal((await readTicket(cwd, tickets.parentTicketId)).status, "in progress");
});

test("harness selection by kind or number, in rotation order", () => {
  assert.deepEqual(parseSelection("codex, claude"), ["claude", "codex"]);
  assert.deepEqual(parseSelection("2,1,3"), ["claude", "codex", "opencode"]);
  assert.equal(parseSelection("claude"), null);
  assert.equal(parseSelection("claude,claude"), null);
  assert.equal(parseSelection("claude,nope"), null);
});

test("installed harnesses are detected from PATH", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "relay-bin-"));
  for (const bin of ["codex", "claude"]) { await writeFile(path.join(dir, bin), "#!/bin/sh\n", { mode: 0o755 }); }
  await writeFile(path.join(dir, "gemini"), "not executable", { mode: 0o644 });
  assert.deepEqual(detectInstalled(dir), ["claude", "codex"]);
});
