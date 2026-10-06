import { spawnSync } from "node:child_process";

const herdr = process.env.HERDR_BIN_PATH || "herdr";

export function callHerdr(args, { allowFailure = false } = {}) {
  const result = spawnSync(herdr, args, {
    encoding: "utf8",
    windowsHide: true,
    env: process.env,
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

export function requireHerdrPaneContext() {
  if (process.env.HERDR_ENV !== "1") {
    throw new Error("Open Harness Relay from a Herdr workspace so it can create and manage worker panes.");
  }
  if (!process.env.HERDR_WORKSPACE_ID) {
    throw new Error("Harness Relay needs a Herdr workspace context.");
  }
}
