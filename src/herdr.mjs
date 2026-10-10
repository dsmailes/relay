import { spawnSync } from "node:child_process";

const herdr = process.env.HERDR_BIN_PATH || "herdr";

export function callHerdr(args, { allowFailure = false } = {}) {
  const result = spawnSync(herdr, args, {
    encoding: "utf8",
    windowsHide: true,
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw new Error(`Could not run Herdr: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    throw new Error((result.stderr || result.stdout || `herdr ${args[0]} failed`).trim());
  }
  return { stdout: result.stdout || "", stderr: result.stderr || "", status: result.status ?? 1 };
}

export function herdrJson(args) {
  const { stdout } = callHerdr(args);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Herdr returned invalid JSON for: herdr ${args.join(" ")}`);
  }
}

// Returns the agent record (agent_status, state_change_seq, ...) or null when
// Herdr no longer knows the agent, for example after its tab was closed.
export function getAgent(name) {
  const result = callHerdr(["agent", "get", name], { allowFailure: true });
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout)?.result?.agent ?? null; }
  catch { return null; }
}

export function notify(title, body, sound = "request") {
  callHerdr(["notification", "show", title, "--body", body, "--sound", sound], { allowFailure: true });
}

export function requireHerdrPaneContext() {
  if (process.env.HERDR_ENV !== "1") {
    throw new Error("Open Harness Relay from a Herdr workspace so it can create and manage worker panes.");
  }
  if (!process.env.HERDR_WORKSPACE_ID) {
    throw new Error("Harness Relay needs a Herdr workspace context.");
  }
}
