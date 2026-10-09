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
const timeoutMs = 60 * 60 * 1000;
const maxReviewRounds = 3;
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
const input = readline.createInterface({ input: stdin, output: stdout });
let heldLockPath = null;

function ask(label, fallback = "") {
  return input.question(fallback ? `${label} [${fallback}]: ` : `${label}: `).then((v) => v.trim() || fallback);
}

async function pickHarnessSet(fallback = []) {
  stdout.write("\nSelect the harnesses you use. Their input order does not affect Relay's automatic rotation:\n");
  harnesses.forEach(([kind, name], i) => stdout.write(`  ${i + 1}. ${name} (${kind})\n`));
  while (true) {
    const initial = fallback.length ? fallback.join(",") : "";
    const answer = await ask("Enter at least two harness kinds or numbers, comma separated", initial);
    const selections = answer.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
    const selected = selections.map((selection) => {
      const entry = /^\d+$/.test(selection)
        ? harnesses[Number(selection) - 1]
        : harnesses.find(([kind]) => kind === selection);
      return entry?.[0] || null;
    });
    if (selected.length >= 2 && selected.every(Boolean) && new Set(selected).size === selected.length) {
      const chain = harnesses.map(([kind]) => kind).filter((kind) => selected.includes(kind));
      stdout.write(`\nAutomatic rotation order: ${chain.join(" → ")}\n`);
      return chain;
    }
    stdout.write("Choose at least two different harnesses from the list.\n");
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
  const savedChain = existing?.harnessChain || (existing?.harnesses ? [...new Set(Object.values(existing.harnesses))] : []);
  const validSavedChain = savedChain.length >= 2 && new Set(savedChain).size === savedChain.length
    && savedChain.every((kind) => harnesses.some(([available]) => available === kind));
  const existingChain = validSavedChain ? harnesses.map(([kind]) => kind).filter((kind) => savedChain.includes(kind)) : [];
  if (existing) {
    if (validSavedChain) stdout.write(`Saved harness selection; automatic rotation: ${existingChain.join(" → ")}\n`);
    else stdout.write("The saved harness settings need to be replaced with a selection of at least two supported harnesses.\n");
    if (validSavedChain && (await ask("Keep this harness selection? yes/no", "yes")).toLowerCase() === "yes") {
      return { harnessChain: existingChain };
    }
  }
  const harnessChain = await pickHarnessSet(existingChain);
  const setup = { harnessChain };
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

function agentName(runId, slot) {
  return `relay_${runId.slice(0, 8)}_h${String(slot + 1).padStart(2, "0")}`;
}

function extractMarker(text, prefix) {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...text.matchAll(new RegExp(`^${escaped}\\s*(.+)$`, "gm"))];
  const match = matches.at(-1);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return match[1].trim(); }
}

async function runAgent(state, role, prompt, marker) {
  const slot = state.chainCursor;
  const kind = state.harnessChain[slot];
  const paneId = state.panes[slot];
  const name = state.agents[slot];
  state.chainCursor = (slot + 1) % state.harnessChain.length;
  state.stage = `waiting:${role}`;
  state.lastPrompt = { role, harness: kind, chainSlot: slot, at: new Date().toISOString(), marker };
  await persist(state);
  stdout.write(`\n→ ${role} → ${kind} (${slot + 1}/${state.harnessChain.length})\n`);
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

function validateTasks(tasks, label) {
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > 20) {
    throw new Error(`${label} must contain between 1 and 20 tasks.`);
  }
  tasks.forEach(formatTask);
  return tasks;
}

async function ensureWorkers(state) {
  const tab = herdrJson(["tab", "create", "--workspace", state.workspaceId, "--cwd", state.cwd,
    "--label", `Relay ${state.runId.slice(0, 8)}`, "--no-focus"]);
  const rootPane = tab?.result?.root_pane?.pane_id;
  if (!rootPane) throw new Error("Herdr did not return a root pane when creating the worker tab.");
  const paneIds = [rootPane];
  let anchor = rootPane;
  for (let i = 1; i < state.harnessChain.length; i++) {
    const split = herdrJson(["pane", "split", anchor, "--direction", "down", "--cwd", state.cwd, "--no-focus"]);
    const paneId = split?.result?.pane?.pane_id;
    if (!paneId) throw new Error("Herdr did not return a pane id when creating a worker pane.");
    paneIds.push(paneId);
    anchor = paneId;
  }
  state.panes = paneIds;
  state.agents = state.harnessChain.map((_, index) => agentName(state.runId, index));
  await persist(state);
  for (let index = 0; index < state.harnessChain.length; index++) {
    const kind = state.harnessChain[index];
    stdout.write(`Starting chain slot ${index + 1}: ${kind}…\n`);
    callHerdr(["agent", "start", state.agents[index], "--kind", kind, "--pane", state.panes[index]]);
  }
}

async function execute(state, changeRequest) {
  await ensureWorkers(state);
  const planMarker = `RELAY_PLAN_${randomUUID().slice(0, 8)}:`;
  const plan = await runAgent(state, "planner", [
    "Create a concise ordered implementation plan for the requested code change.",
    `Return exactly one final line in this format: ${planMarker} {\"needsDesignReview\":false,\"needsSecondOpinion\":false,\"tasks\":[{\"title\":\"...\",\"acceptanceCriteria\":\"...\"}]}`,
    "Set needsDesignReview=true when the change has meaningful UI, architecture, data-model, API, or interaction choices that merit design input. Set needsSecondOpinion=true when an independent plan review would materially reduce risk. Otherwise set each to false. Do not edit files.",
    `\nChange request:\n${changeRequest}`,
  ].join("\n"), planMarker);
  if (!plan || typeof plan.needsDesignReview !== "boolean" || typeof plan.needsSecondOpinion !== "boolean") {
    throw new Error("Planner must return boolean needsDesignReview and needsSecondOpinion fields.");
  }
  let tasks = validateTasks(plan.tasks, "Planner response");
  if (plan.needsDesignReview) {
    const designMarker = `RELAY_DESIGN_${randomUUID().slice(0, 8)}:`;
    const design = await runAgent(state, "designer", [
      "Review this plan for design, architecture, data-model, API, and interaction choices. Do not edit files.",
      `Return one final line: ${designMarker} {\"recommendations\":\"specific design decisions, tradeoffs, and changes the planner should consider\"}`,
      `Change request:\n${changeRequest}`,
      `Proposed plan:\n${tasks.map(formatTask).join("\n\n")}`,
    ].join("\n\n"), designMarker);
    state.designNote = design?.recommendations || String(design);
    state.stage = "design-review-complete";
    await persist(state);
    const revisedMarker = `RELAY_REVISED_PLAN_${randomUUID().slice(0, 8)}:`;
    const revised = await runAgent(state, "planner", [
      "Revise your plan using the design review. Keep sound tasks and update the tasks and acceptance criteria where needed. Do not edit files.",
      `Return exactly one final line: ${revisedMarker} {\"tasks\":[{\"title\":\"...\",\"acceptanceCriteria\":\"...\"}]}`,
      `Original plan:\n${tasks.map(formatTask).join("\n\n")}`,
      `Design recommendations:\n${state.designNote}`,
    ].join("\n\n"), revisedMarker);
    tasks = validateTasks(revised?.tasks, "Planner's design revision");
  }
  if (plan.needsSecondOpinion) {
    const opinionMarker = `RELAY_OPINION_${randomUUID().slice(0, 8)}:`;
    const opinion = await runAgent(state, "second-opinion", [
      "Give an independent second opinion on this implementation plan. Do not edit files.",
      `Return one final line in this format: ${opinionMarker} {\"decision\":\"approve\"} OR ${opinionMarker} {\"decision\":\"revise\",\"findings\":\"specific risks or missing work\"}`,
      `Change request:\n${changeRequest}`,
      `Plan:\n${tasks.map(formatTask).join("\n\n")}`,
      state.designNote ? `Design recommendations:\n${state.designNote}` : "",
    ].filter(Boolean).join("\n\n"), opinionMarker);
    if (opinion?.decision === "revise" && opinion.findings) {
      const revisedMarker = `RELAY_REVISED_PLAN_${randomUUID().slice(0, 8)}:`;
      const revised = await runAgent(state, "planner", [
        "Revise your plan using the independent review findings. Keep sound tasks, add or adjust tasks where needed, and do not edit files.",
        `Return exactly one final line: ${revisedMarker} {\"tasks\":[{\"title\":\"...\",\"acceptanceCriteria\":\"...\"}]}`,
        `Original plan:\n${tasks.map(formatTask).join("\n\n")}`,
        `Second-opinion findings:\n${opinion.findings}`,
      ].join("\n\n"), revisedMarker);
      tasks = validateTasks(revised?.tasks, "Planner's second-opinion revision");
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
  const { harnessChain } = setup;
  const changeRequest = await ask("Describe the code change");
  if (!changeRequest) throw new Error("A change description is required.");
  const state = {
    schemaVersion: 1,
    runId: randomUUID(),
    cwd: projectCwd,
    workspaceId: process.env.HERDR_WORKSPACE_ID,
    changeRequest,
    harnessChain,
    chainCursor: 0,
    createdAt: new Date().toISOString(),
    stage: "initializing",
    tasks: [],
    approvedTasks: [],
    panes: [],
    agents: [],
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
