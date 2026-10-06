import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { callHerdr, herdrJson, requireHerdrPaneContext } from "./herdr.mjs";

const harnesses = [
  ["claude", "Claude Code"], ["codex", "Codex"], ["opencode", "OpenCode"],
  ["copilot", "GitHub Copilot CLI"], ["pi", "Pi"], ["gemini", "Gemini CLI"],
  ["cursor", "Cursor Agent"], ["amp", "Amp"], ["droid", "Droid"],
  ["kimi", "Kimi Code"], ["kiro", "Kiro CLI"], ["cline", "Cline"],
  ["devin", "Devin CLI"], ["agy", "Antigravity CLI"], ["hermes", "Hermes Agent"],
  ["kilo", "Kilo Code CLI"], ["qodercli", "Qoder CLI"], ["qwen", "Qwen Code"],
  ["mastracode", "MastraCode"], ["grok", "Grok CLI"], ["omp", "OMP"],
  ["maki", "Maki"], ["letta", "Letta Code"], ["muse", "Muse"],
];
const requiredRoles = ["planner", "implementer", "reviewer"];
const timeoutMs = 60 * 60 * 1000;
const maxReviewRounds = 3;
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
const input = readline.createInterface({ input: stdin, output: stdout });
let heldLockPath = null;

function ask(label, fallback = "") {
  return input.question(fallback ? `${label} [${fallback}]: ` : `${label}: `).then((v) => v.trim() || fallback);
}

async function pickHarness(role, fallback = "") {
  stdout.write(`\n${role} harness:\n`);
  harnesses.forEach(([kind, name], i) => stdout.write(`  ${i + 1}. ${name} (${kind})\n`));
  while (true) {
    const answer = await ask("Select number or harness kind", fallback);
    const byIndex = harnesses[Number(answer) - 1];
    const found = byIndex || harnesses.find(([kind]) => kind === answer.toLowerCase());
    if (found) return found[0];
    stdout.write("Choose a listed harness kind.\n");
  }
}

function statePath(cwd) {
  const key = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 20);
  return path.join(stateDir, `${key}.json`);
}

async function persist(state) {
  if (!stateDir) throw new Error("Herdr did not provide HERDR_PLUGIN_STATE_DIR; refusing to save workflow data in the plugin directory.");
  await mkdir(stateDir, { recursive: true });
  const target = statePath(state.cwd);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  const { rename } = await import("node:fs/promises");
  await rename(temp, target);
}

async function loadState(cwd) {
  try { return JSON.parse(await readFile(statePath(cwd), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function loadHarnessSetup() {
  if (!configDir) throw new Error("Herdr did not provide HERDR_PLUGIN_CONFIG_DIR.");
  try { return JSON.parse(await readFile(path.join(configDir, "harnesses.json"), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function saveHarnessSetup(setup) {
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "harnesses.json"), `${JSON.stringify(setup, null, 2)}\n`, { mode: 0o600 });
}

async function configureHarnesses(existing) {
  if (existing) {
    stdout.write(`Saved harness roles: ${Object.entries(existing.harnesses).map(([role, kind]) => `${role}=${kind}`).join(", ")}\n`);
    if ((await ask("Keep these harness assignments? yes/no", "yes")).toLowerCase() === "yes") return existing;
  }
  const harnessMap = {};
  for (const role of requiredRoles) harnessMap[role] = await pickHarness(role, existing?.harnesses?.[role]);
  const optionalRoles = [];
  if ((await ask("Add a design slot? yes/no", existing?.optionalRoles?.includes("designer") ? "yes" : "no")).toLowerCase() === "yes") optionalRoles.push("designer");
  if ((await ask("Add a second-opinion slot? yes/no", existing?.optionalRoles?.includes("second-opinion") ? "yes" : "no")).toLowerCase() === "yes") optionalRoles.push("second-opinion");
  for (const role of optionalRoles) harnessMap[role] = await pickHarness(role, existing?.harnesses?.[role]);
  const setup = { harnesses: harnessMap, optionalRoles };
  await saveHarnessSetup(setup);
  return setup;
}

async function acquireProjectLock(cwd) {
  if (!stateDir) throw new Error("Herdr did not provide HERDR_PLUGIN_STATE_DIR.");
  await mkdir(stateDir, { recursive: true });
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

function agentName(runId, role) {
  return `relay_${runId.slice(0, 8)}_${role}`;
}

function extractMarker(text, prefix) {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...text.matchAll(new RegExp(`^${escaped}\\s*(.+)$`, "gm"))];
  const match = matches.at(-1);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return match[1].trim(); }
}

async function runAgent(state, role, prompt, marker) {
  const paneId = state.panes[role];
  const name = state.agents[role];
  state.stage = `waiting:${role}`;
  state.lastPrompt = { role, at: new Date().toISOString(), marker };
  await persist(state);
  stdout.write(`\n→ ${role} (${state.harnesses[role]})\n`);
  try {
    callHerdr(["agent", "prompt", name, prompt, "--wait", "--timeout", String(timeoutMs)]);
  } catch (error) {
    state.stage = `paused:${role}`;
    state.pauseReason = error.message;
    await persist(state);
    throw new Error(`Herdr did not confirm the ${role} handoff. The run is saved for inspection: ${error.message}`);
  }
  const result = callHerdr(["agent", "read", name, "--source", "recent-unwrapped", "--lines", "200"]);
  const value = extractMarker(result.stdout, marker);
  if (value === null) {
    state.stage = `paused:${role}`;
    state.pauseReason = `No ${marker} marker found in the harness response.`;
    await persist(state);
    throw new Error(`${state.pauseReason} The run is saved and paused; inspect the ${role} pane before retrying.`);
  }
  return value;
}

function formatTask(task, index) {
  if (typeof task === "string") return `${index + 1}. ${task}`;
  if (!task || typeof task.title !== "string" || typeof task.acceptanceCriteria !== "string") {
    throw new Error("Planner returned a task without title and acceptanceCriteria.");
  }
  return `${index + 1}. ${task.title}\nAcceptance criteria: ${task.acceptanceCriteria}`;
}

async function ensureWorkers(state) {
  const tab = herdrJson(["tab", "create", "--workspace", state.workspaceId, "--cwd", state.cwd,
    "--label", `Relay ${state.runId.slice(0, 8)}`, "--no-focus"]);
  const rootPane = tab?.result?.root_pane?.pane_id;
  if (!rootPane) throw new Error("Herdr did not return a root pane when creating the worker tab.");
  const paneIds = [rootPane];
  let anchor = rootPane;
  for (let i = 1; i < state.roles.length; i++) {
    const split = herdrJson(["pane", "split", anchor, "--direction", "down", "--cwd", state.cwd, "--no-focus"]);
    const paneId = split?.result?.pane?.pane_id;
    if (!paneId) throw new Error("Herdr did not return a pane id when creating a worker pane.");
    paneIds.push(paneId);
    anchor = paneId;
  }
  state.panes = Object.fromEntries(state.roles.map((role, index) => [role, paneIds[index]]));
  state.agents = Object.fromEntries(state.roles.map((role) => [role, agentName(state.runId, role)]));
  await persist(state);
  for (const role of state.roles) {
    stdout.write(`Starting ${role} (${state.harnesses[role]})…\n`);
    callHerdr(["agent", "start", state.agents[role], "--kind", state.harnesses[role], "--pane", state.panes[role]]);
  }
}

async function execute(state, changeRequest) {
  await ensureWorkers(state);
  if (state.roles.includes("designer")) {
    const designMarker = `RELAY_DESIGN_${randomUUID().slice(0, 8)}:`;
    const design = await runAgent(state, "designer", [
      "Explore the requested change as a design task. Do not edit files.",
      `Return one final line in this format: ${designMarker} {\"recommendations\":\"brief design guidance and important tradeoffs\"}`,
      `Change request:\n${changeRequest}`,
    ].join("\n\n"), designMarker);
    state.designNote = design?.recommendations || String(design);
    state.stage = "design-complete";
    await persist(state);
  }
  const planMarker = `RELAY_PLAN_${randomUUID().slice(0, 8)}:`;
  const plan = await runAgent(state, "planner", [
    "Create a concise ordered implementation plan for the requested code change.",
    `Return exactly one final line in this format: ${planMarker} {\"tasks\":[{\"title\":\"...\",\"acceptanceCriteria\":\"...\"}]}`,
    "Keep tasks small and sequential. Do not edit files.",
    state.designNote ? `Design guidance:\n${state.designNote}` : "",
    `\nChange request:\n${changeRequest}`,
  ].join("\n"), planMarker);
  let tasks = Array.isArray(plan) ? plan : plan?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("Planner must return a non-empty tasks array.");
  if (tasks.length > 20) throw new Error("Planner returned more than 20 tasks; split the proposal into a smaller plan.");
  tasks.forEach(formatTask);
  if (state.roles.includes("second-opinion")) {
    const opinionMarker = `RELAY_OPINION_${randomUUID().slice(0, 8)}:`;
    const opinion = await runAgent(state, "second-opinion", [
      "Give an independent second opinion on this implementation plan. Do not edit files.",
      `Return one final line in this format: ${opinionMarker} {\"decision\":\"approve\"} OR ${opinionMarker} {\"decision\":\"revise\",\"findings\":\"specific risks or missing work\"}`,
      `Change request:\n${changeRequest}`,
      `Plan:\n${tasks.map(formatTask).join("\n\n")}`,
      state.designNote ? `Design guidance:\n${state.designNote}` : "",
    ].filter(Boolean).join("\n\n"), opinionMarker);
    if (opinion?.decision === "revise" && opinion.findings) {
      const revisedMarker = `RELAY_REVISED_PLAN_${randomUUID().slice(0, 8)}:`;
      const revised = await runAgent(state, "planner", [
        "Revise your plan using the independent review findings. Keep sound tasks, add or adjust tasks where needed, and do not edit files.",
        `Return exactly one final line: ${revisedMarker} {\"tasks\":[{\"title\":\"...\",\"acceptanceCriteria\":\"...\"}]}`,
        `Original plan:\n${tasks.map(formatTask).join("\n\n")}`,
        `Second-opinion findings:\n${opinion.findings}`,
      ].join("\n\n"), revisedMarker);
      tasks = Array.isArray(revised) ? revised : revised?.tasks;
      if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > 20) {
        throw new Error("Planner returned an invalid revised plan; workflow paused.");
      }
      state.opinionFindings = opinion.findings;
    } else if (opinion?.decision !== "approve") {
      throw new Error("Second-opinion harness returned an invalid decision; workflow paused.");
    }
  }
  state.tasks = tasks;
  state.stage = "planned";
  await persist(state);
  stdout.write(`\nPlan has ${tasks.length} task(s):\n${tasks.map(formatTask).join("\n\n")}\n`);
  const proceed = (await ask("Proceed with this plan? Type yes to continue", "no")).toLowerCase();
  if (proceed !== "yes") {
    state.stage = "paused:plan-approval";
    await persist(state);
    stdout.write("Plan saved. No implementation work was started.\n");
    return;
  }

  for (let index = 0; index < tasks.length; index++) {
    const taskText = formatTask(tasks[index], index);
    let approved = false;
    for (let round = 1; round <= maxReviewRounds && !approved; round++) {
      const implementationMarker = `RELAY_IMPLEMENTATION_${randomUUID().slice(0, 8)}:`;
      const result = await runAgent(state, "implementer", [
        `Implement task ${index + 1} of ${tasks.length}. Work only on this task and its acceptance criteria.`,
        taskText,
        round > 1 ? `Address these review findings from the previous round:\n${state.reviewFindings}` : "",
        `When finished, respond with a short summary and a final line: ${implementationMarker} {\"status\":\"complete\",\"summary\":\"...\"}.`,
      ].filter(Boolean).join("\n\n"), implementationMarker);
      if (result?.status !== "complete") throw new Error("Implementer did not report status=complete; workflow paused.");
      const reviewMarker = `RELAY_REVIEW_${randomUUID().slice(0, 8)}:`;
      const review = await runAgent(state, "reviewer", [
        `Review the current diff for task ${index + 1} of ${tasks.length}.`, taskText,
        "Check correctness and acceptance criteria. Do not edit files.",
        `Return a final line: ${reviewMarker} {\"decision\":\"approve\"} OR ${reviewMarker} {\"decision\":\"changes\",\"findings\":\"specific actionable findings\"}.`,
      ].join("\n\n"), reviewMarker);
      if (review?.decision === "approve") approved = true;
      else if (review?.decision === "changes" && review.findings) state.reviewFindings = review.findings;
      else throw new Error("Reviewer returned an invalid decision; workflow paused.");
      state.completedReviewRounds = (state.completedReviewRounds || 0) + 1;
      state.taskIndex = index;
      await persist(state);
    }
    if (!approved) throw new Error(`Task ${index + 1} reached the ${maxReviewRounds}-round review limit. Workflow paused for human review.`);
    state.reviewFindings = null;
    state.approvedTasks = [...(state.approvedTasks || []), index];
    state.stage = "task-approved";
    await persist(state);
    stdout.write(`✓ Task ${index + 1} approved.\n`);
  }
  state.stage = "complete";
  state.completedAt = new Date().toISOString();
  await persist(state);
  callHerdr(["notification", "show", "Harness Relay complete", "--body", `${tasks.length} task(s) implemented and reviewed`, "--sound", "done"], { allowFailure: true });
  stdout.write("\nWorkflow complete. Every task received reviewer approval.\n");
}

async function main() {
  requireHerdrPaneContext();
  const context = (() => {
    try { return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}"); }
    catch { return {}; }
  })();
  const workspace = herdrJson(["workspace", "get", process.env.HERDR_WORKSPACE_ID]);
  const projectCwd = [context.cwd, context.workspace?.cwd, context.workspace?.path,
    context.focused_pane?.cwd, context.focusedPane?.cwd, context.worktree?.path,
    workspace?.result?.workspace?.cwd, workspace?.result?.workspace?.path,
    workspace?.result?.cwd, workspace?.workspace?.cwd, workspace?.workspace?.path]
    .find((candidate) => typeof candidate === "string" && path.isAbsolute(candidate));
  if (!projectCwd) throw new Error("Could not resolve the Herdr workspace directory from plugin context.");
  await acquireProjectLock(projectCwd);
  stdout.write("Harness Relay\nPlan a change, then send each task through implementation and review.\n\n");
  const saved = await loadState(projectCwd);
  if (saved && !["complete", "cancelled"].includes(saved.stage)) {
    stdout.write(`Saved run ${saved.runId.slice(0, 8)} is at stage ${saved.stage}.\n`);
    stdout.write("Automatic resume is disabled because a prompt may already have been delivered. Inspect the recorded worker panes before deciding whether to abandon this run.\n");
    if ((await ask("Type new to abandon its saved state and start another run", "no")).toLowerCase() !== "new") return;
  }
  const setup = await configureHarnesses(await loadHarnessSetup());
  const { harnesses: harnessMap, optionalRoles } = setup;
  const changeRequest = await ask("Describe the code change");
  if (!changeRequest) throw new Error("A change description is required.");
  const state = {
    schemaVersion: 1,
    runId: randomUUID(),
    cwd: projectCwd,
    workspaceId: process.env.HERDR_WORKSPACE_ID,
    changeRequest,
    harnesses: harnessMap,
    roles: [...requiredRoles, ...optionalRoles],
    createdAt: new Date().toISOString(),
    stage: "initializing",
    tasks: [],
    approvedTasks: [],
    panes: {},
    agents: {},
  };
  await persist(state);
  await execute(state, changeRequest);
}

try {
  await main();
} catch (error) {
  stdout.write(`\nHarness Relay paused: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  input.close();
  if (heldLockPath) {
    try { await unlink(heldLockPath); } catch { /* The lock may have been removed while the pane was closing. */ }
  }
}
