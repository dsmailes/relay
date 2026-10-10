import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

// Layout inside HERDR_PLUGIN_STATE_DIR, where <key> is a hash of the project path:
//   <key>.json          the current run (rewritten atomically at every step)
//   <key>.events.jsonl  append-only log of everything Relay did, across all runs
//   <key>.lock          project lock
//   runs/<runId>.json   final snapshot of every finished or abandoned run
//   diffs/<run>-*.patch the full diff each reviewer was given

const stateDir = () => {
  if (!process.env.HERDR_PLUGIN_STATE_DIR) {
    throw new Error("Herdr did not provide HERDR_PLUGIN_STATE_DIR; refusing to save workflow data in the plugin directory.");
  }
  return process.env.HERDR_PLUGIN_STATE_DIR;
};

export function projectKey(cwd) {
  return createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 20);
}

export const statePath = (cwd) => path.join(stateDir(), `${projectKey(cwd)}.json`);
export const eventsPath = (cwd) => path.join(stateDir(), `${projectKey(cwd)}.events.jsonl`);
export const diffPath = (name) => path.join(stateDir(), "diffs", name);

async function writeAtomic(target, text) {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, text, { mode: 0o600 });
  await rename(temp, target);
}

export async function persist(state) {
  state.updatedAt = new Date().toISOString();
  await writeAtomic(statePath(state.cwd), `${JSON.stringify(state, null, 2)}\n`);
}

export async function loadState(cwd) {
  try { return JSON.parse(await readFile(statePath(cwd), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function logEvent(state, type, data = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), runId: state.runId, type, ...data });
  try {
    await mkdir(stateDir(), { recursive: true });
    await appendFile(eventsPath(state.cwd), `${line}\n`, { mode: 0o600 });
  } catch { /* The event log must never take the workflow down. */ }
}

export async function archiveRun(state, outcome) {
  state.outcome = outcome;
  await persist(state);
  await writeAtomic(path.join(stateDir(), "runs", `${state.runId}.json`), `${JSON.stringify(state, null, 2)}\n`);
  await logEvent(state, `run.${outcome}`);
}

export async function writeDiff(name, text) {
  const target = diffPath(name);
  await writeAtomic(target, text);
  return target;
}

export async function loadHarnessSetup() {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (!dir) throw new Error("Herdr did not provide HERDR_PLUGIN_CONFIG_DIR.");
  try { return JSON.parse(await readFile(path.join(dir, "harnesses.json"), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function saveHarnessSetup(setup) {
  await writeAtomic(path.join(process.env.HERDR_PLUGIN_CONFIG_DIR, "harnesses.json"), `${JSON.stringify(setup, null, 2)}\n`);
}

let heldLockPath = null;

export async function acquireProjectLock(cwd) {
  await mkdir(stateDir(), { recursive: true });
  const target = `${statePath(cwd)}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(target, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await handle.close();
      heldLockPath = target;
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner;
      try { owner = JSON.parse(await readFile(target, "utf8")); }
      catch { throw new Error("Another Harness Relay may be starting for this project. Check the relay panes, then remove the stale lock if needed."); }
      if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new Error("The existing Harness Relay lock is invalid; inspect it before removing it.");
      try {
        process.kill(owner.pid, 0);
        throw new Error(`Harness Relay is already running for this project (process ${owner.pid}).`);
      } catch (probeError) {
        if (probeError.message.startsWith("Harness Relay is already running")) throw probeError;
        if (probeError.code !== "ESRCH") throw new Error("Could not confirm whether the existing Harness Relay process is still running.");
        await unlink(target);
      }
    }
  }
  throw new Error("Could not acquire the project workflow lock.");
}

export async function releaseProjectLock() {
  if (!heldLockPath) return;
  try { await unlink(heldLockPath); } catch { /* The lock may have been removed while the pane was closing. */ }
  heldLockPath = null;
}
