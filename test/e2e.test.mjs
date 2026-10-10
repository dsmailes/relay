import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const here = path.dirname(new URL(import.meta.url).pathname);
const consoleMain = path.join(here, "..", "src", "relay-console.mjs");

async function sandbox(extraEnv = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "relay-e2e-"));
  const cwd = path.join(root, "project");
  const fake = path.join(root, "fake");
  const stateDir = path.join(root, "state");
  const configDir = path.join(root, "config");
  await Promise.all([cwd, fake, stateDir, configDir].map((d) => mkdir(d, { recursive: true })));
  const run = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  run("init", "-q"); run("config", "user.email", "t@t"); run("config", "user.name", "t");
  await writeFile(path.join(cwd, "README.md"), "# project\n");
  run("add", "."); run("commit", "-qm", "init");
  const bin = path.join(root, "herdr");
  await writeFile(bin, `#!/bin/sh\nexec node "${path.join(here, "fake-herdr.mjs")}" "$@"\n`);
  await chmod(bin, 0o755);
  await writeFile(path.join(configDir, "harnesses.json"), JSON.stringify({ harnessChain: ["claude", "codex", "opencode"] }));
  const env = { ...process.env, HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_BIN_PATH: bin, HERDR_PLUGIN_STATE_DIR: stateDir,
    HERDR_PLUGIN_CONFIG_DIR: configDir, FAKE_HERDR_DIR: fake, FAKE_CWD: cwd, HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ cwd }), ...extraEnv };
  const start = (stdin) => {
    const child = spawn("node", [consoleMain], { env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    for (const line of stdin) child.stdin.write(`${line}\n`);
    return { child, output: () => output };
  };
  const calls = async () => (await readFile(path.join(fake, "calls.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const events = async () => (await readFile(path.join(stateDir, (await import("node:fs")).readdirSync(stateDir).find((f) => f.endsWith(".events.jsonl"))), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { cwd, stateDir, start, calls, events, run };
}

async function until(check, label, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const finish = (child) => new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGKILL"); });

test("full run: rotation, correction, review round, diffs, checkpoints, history", { timeout: 60000 }, async () => {
  const sb = await sandbox({ FAKE_BAD_PLAN: "1", FAKE_DESIGN: "1", FAKE_REVIEW_CHANGES: "1" });
  const proc = sb.start([""]);
  try {
    await until(async () => (await sb.events()).some((e) => e.type === "run.complete"), "run.complete");
  } catch (error) { throw new Error(`${error.message}\n${proc.output()}`); }
  await finish(proc.child);
  const calls = await sb.calls();
  const prompts = calls.filter((c) => c.prompt);
  const roles = prompts.map((c) => `${c.kind}:${c.text.match(/RELAY_([A-Z_]+)_[0-9a-f]{8}:/)[1]}`);
  // intake (claude) is rejected once and corrected, then the baton rotates codex, opencode, claude, ...
  assert.deepEqual(roles.slice(0, 5), ["claude:PLAN", "claude:PLAN", "codex:DESIGN", "opencode:REVISED_PLAN", "claude:APPROVAL"]);
  assert.match(prompts[1].text, /could not accept your handoff line.*approvedByUser/s);
  // plan changed (3 tasks) -> approval; task 1 needed a second round; every task was reviewed with its diff
  const impls = prompts.filter((c) => /IMPLEMENTATION/.test(c.text.match(/RELAY_[A-Z_]+_/)[0]));
  assert.equal(impls.length, 4);
  const reviews = prompts.filter((c) => /RELAY_REVIEW_/.test(c.text));
  assert.equal(reviews.length, 4);
  assert.match(reviews[0].text, /written by/);
  assert.match(impls[1].text, /add a trailing newline/);
  const steps = prompts.filter((c) => !c.text.startsWith("Relay could not accept"));
  assert.ok(steps.every((c, i) => i === 0 || c.kind !== steps[i - 1].kind), "the same harness never gets two consecutive steps");
  // outputs
  // Relay immediately starts the next run's intake, so read the archived snapshot of the finished one.
  const fs = await import("node:fs");
  const archived = fs.readdirSync(path.join(sb.stateDir, "runs"));
  assert.equal(archived.length, 1);
  const state = JSON.parse(await readFile(path.join(sb.stateDir, "runs", archived[0]), "utf8"));
  assert.equal(state.stage, "complete");
  assert.equal(state.timeline.length, 12); // intake, design, revision, approval, 4 implementations, 4 reviews
  assert.equal(Object.keys(state.git.checkpoints).length, 3);
  assert.match(sb.run("rev-parse", "refs/relay/" + state.runId.slice(0, 8) + "/task-3"), /^[0-9a-f]{40}/);
  assert.match(sb.run("status", "--porcelain"), /greeting\.txt/);
  assert.doesNotMatch(sb.run("status", "--porcelain"), /herdr-issues/);
  const board = JSON.parse(await readFile(path.join(sb.cwd, ".herdr-issues.json"), "utf8"));
  assert.equal(board.issues.length, 4);
  assert.ok(board.issues.every((i) => i.status === "done"));
  assert.match(board.issues[0].notes, /Timeline:/);
  assert.equal(state.outcome, "complete");
});

test("kill mid-review, restart, and resume without resending the prompt", { timeout: 60000 }, async () => {
  const hold = path.join(os.tmpdir(), `relay-hold-${process.pid}`);
  await writeFile(hold, "");
  const sb = await sandbox({ FAKE_HOLD: hold });
  const first = sb.start([""]);
  try {
    await until(async () => (await sb.calls()).some((c) => c.prompt && /RELAY_REVIEW_/.test(c.text)), "review prompt");
  } catch (error) { throw new Error(`${error.message}\n${first.output()}`); }
  await finish(first.child);
  const reviewPromptsBefore = (await sb.calls()).filter((c) => c.prompt && /RELAY_REVIEW_/.test(c.text)).length;
  assert.equal(reviewPromptsBefore, 1);
  await (await import("node:fs/promises")).rm(hold);
  const second = sb.start(["", ""]); // Enter = resume
  try {
    await until(async () => (await sb.events()).some((e) => e.type === "run.complete"), "run.complete after resume");
  } catch (error) { throw new Error(`${error.message}\n${second.output()}`); }
  await finish(second.child);
  assert.match(second.output(), /Resuming: reviewer/);
  const calls = await sb.calls();
  const reviewPrompts = calls.filter((c) => c.prompt && /RELAY_REVIEW_/.test(c.text));
  assert.equal(reviewPrompts.length, 2, "task 1 review was not resent on resume; only task 2 review was added");
});
