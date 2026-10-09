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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function livestockBoardPath(cwd) {
  return path.join(cwd, ".herdr-issues.json");
}

async function loadBoard(cwd) {
  const target = livestockBoardPath(cwd);
  try {
    const board = JSON.parse(await readFile(target, "utf8"));
    if (!board || !Array.isArray(board.issues)) throw new Error("Livestock board must contain an issues array.");
    return { target, board };
  } catch (error) {
    if (error.code === "ENOENT") return { target, board: { version: 1, issues: [] } };
    throw error;
  }
}

async function saveBoard(target, board) {
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(board, null, 2)}\n`, { mode: 0o600 });
  const { rename } = await import("node:fs/promises");
  await rename(temp, target);
}

function newIssueId(issues) {
  let id;
  do { id = randomUUID().replaceAll("-", "").slice(0, 8); }
  while (issues.some((issue) => issue.id === id));
  return id;
}

async function createBoardTickets(state, tasks) {
  const { target, board } = await loadBoard(state.cwd);
  const timestamp = new Date().toISOString();
  const parentId = newIssueId(board.issues);
  const tag = `Harness Relay run ${state.runId}`;
  const parent = {
    id: parentId,
    title: state.changeRequest.slice(0, 160),
    status: "in progress",
    priority: "normal",
    notes: `${tag}\n\nThis issue tracks a multi-harness change. Child task tickets contain acceptance criteria and handoff notes.`,
    blocked_by: [],
    created_at: timestamp,
    updated_at: timestamp,
  };
  board.issues.push(parent);
  const ticketIds = [];
  tasks.forEach((task, index) => {
    const issueId = newIssueId(board.issues);
    ticketIds.push(issueId);
    board.issues.push({
      id: issueId,
      title: typeof task === "string" ? task : task.title,
      status: "open",
      priority: "normal",
      notes: `${tag}\nParent issue: ${parentId}\n\nChange request:\n${state.changeRequest}\n\nAcceptance criteria:\n${typeof task === "string" ? task : task.acceptanceCriteria}\n\nTask ${index + 1} of ${tasks.length}.`,
      blocked_by: [],
      created_at: timestamp,
      updated_at: timestamp,
    });
  });
  await saveBoard(target, board);
  state.livestock = { boardPath: target, parentTicketId: parentId, taskTicketIds: ticketIds };
  await persist(state);
  stdout.write(`Added a parent ticket and ${ticketIds.length} task ticket(s) to Livestock.\n`);
}

async function updateBoardTicket(state, issueId, { status, note } = {}) {
  if (!state.livestock?.boardPath || !issueId) return;
  const { board } = await loadBoard(state.cwd);
  const issue = board.issues.find((entry) => entry.id === issueId);
  if (!issue) throw new Error(`Livestock ticket ${issueId} is missing from ${state.livestock.boardPath}.`);
  if (status) issue.status = status;
  if (note) issue.notes = `${issue.notes || ""}${issue.notes ? "\n\n" : ""}[${new Date().toISOString()}] ${note}`;
  issue.updated_at = new Date().toISOString();
  await saveBoard(state.livestock.boardPath, board);
}

function extractMarker(text, prefix) {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Some terminal UIs decorate assistant-message lines with a leading bullet,
  // and Herdr can expose long JSON handoffs as wrapped terminal rows.
  const lines = text.replace(/\r/g, "").split("\n");
  const markerLine = new RegExp(`^[\\t ]*(?:[●•◦⏺][\\t ]*)?${escaped}[\\t ]*(.*)$`);
  const knownKeys = new Set([
    "request", "needsDesignReview", "needsSecondOpinion", "tasks", "title",
    "acceptanceCriteria", "recommendations", "decision", "findings", "status", "summary",
  ]);
  const parseWrappedJson = (parts) => {
    const candidates = [parts.join("\n"), parts.join(" ")];
    for (const candidate of candidates) {
      const normalized = candidate.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"(\s*):/g, (whole, key, colon) => {
        const compactKey = key.replace(/\s/g, "");
        return knownKeys.has(compactKey) ? `"${compactKey}"${colon}:` : whole;
      });
      try { return JSON.parse(normalized); } catch { /* The handoff may continue on the next wrapped row. */ }
    }
    return null;
  };

  for (let start = lines.length - 1; start >= 0; start--) {
    const match = lines[start].match(markerLine);
    if (!match) continue;
    const parts = [match[1].trim()];
    let value = parseWrappedJson(parts);
    if (value !== null) return value;
    for (let line = start + 1; line < lines.length; line++) {
      const continuation = lines[line].trim();
      if (/^(?:✻|❯|⏺\s+(?:RELAY_|Resending)|RELAY_[A-Z0-9_]+:)/.test(continuation)) break;
      parts.push(continuation);
      value = parseWrappedJson(parts);
      if (value !== null) return value;
    }
  }
  return null;
}

async function runAgent(state, role, prompt, marker) {
  const slot = state.chainCursor;
  const kind = state.harnessChain[slot];
  await ensureWorker(state, slot);
  const name = state.activeAgentName;
  state.chainCursor = (slot + 1) % state.harnessChain.length;
  state.stage = `waiting:${role}`;
  state.lastPrompt = { role, harness: kind, chainSlot: slot, at: new Date().toISOString(), marker };
  await persist(state);
  const activeTicketId = state.livestock?.taskTicketIds?.[state.taskIndex];
  let handoffPrompt = prompt;
  if (activeTicketId) {
    await updateBoardTicket(state, activeTicketId, { note: `${role} handed the baton to ${kind}.` });
    const { board } = await loadBoard(state.cwd);
    const ticket = board.issues.find((issue) => issue.id === activeTicketId);
    if (!ticket) throw new Error(`Livestock ticket ${activeTicketId} is missing from the board.`);
    handoffPrompt = [
      `Livestock ticket ${ticket.id}: ${ticket.title}\nStatus: ${ticket.status}\nPriority: ${ticket.priority}\nNotes and handoff history:\n${ticket.notes || "(none)"}`,
      prompt,
    ].join("\n\n");
  }
  stdout.write(`\n→ ${role} → ${kind} (${slot + 1}/${state.harnessChain.length})\n`);
  try {
    callHerdr(["agent", "prompt", name, handoffPrompt, "--wait", "--timeout", String(timeoutMs)]);
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

async function runInteractiveIntake(state) {
  await ensureWorker(state, 0);
  const name = state.activeAgentName;
  const resuming = state.stage === "waiting:first-harness-intake" && state.lastPrompt?.marker;
  const marker = resuming ? state.lastPrompt.marker : `RELAY_PLAN_${randomUUID().slice(0, 8)}:`;
  if (!resuming) {
    state.stage = "waiting:first-harness-intake";
    state.lastPrompt = { role: "planner", harness: state.harnessChain[0], chainSlot: 0, at: new Date().toISOString(), marker };
    await persist(state);
  }
  const prompt = [
    "You are the user's front-door coding harness in a multi-harness relay. The user will describe a code change directly to you in this pane.",
    "Discuss and clarify the request with the user in this pane. Draft a concise ordered implementation plan and show it to the user. Do not edit files or create tickets yet.",
    `When the request is clear and the user has approved the proposed plan, return exactly one final line in this shape: ${marker} {"request":"...","needsDesignReview":false,"needsSecondOpinion":false,"tasks":[{"title":"...","acceptanceCriteria":"..."}]}.`,
    "Set needsDesignReview=true only when the change has meaningful UI, architecture, data-model, API, or interaction choices. Set needsSecondOpinion=true only when an independent plan review would materially reduce risk. Include between 1 and 20 tasks. Every task needs a title and acceptance criteria.",
    "The final marker is the handoff signal to Relay. Until then, stay in conversation with the user and do not start implementation.",
  ].join("\n\n");
  if (!resuming) {
    try {
      callHerdr(["agent", "prompt", name, prompt]);
    } catch (error) {
      state.stage = "paused:first-harness-intake";
      state.pauseReason = error.message;
      await persist(state);
      throw new Error(`Could not start the first-harness conversation. The run is saved for inspection: ${error.message}`);
    }
    state.chainCursor = state.harnessChain.length > 1 ? 1 : 0;
    await persist(state);
  }
  stdout.write(`\nTalk to ${state.harnessChain[0]} in its focused pane. Relay is monitoring for the approved plan.\n`);
  return waitForInteractiveMarker(state, name, marker);
}

async function waitForInteractiveMarker(state, name, marker) {
  let blockedNoticeShown = false;
  while (true) {
    const recent = callHerdr(["agent", "read", name, "--source", "recent-unwrapped", "--lines", "200"], { allowFailure: true });
    let value = extractMarker(recent.stdout, marker);
    if (value !== null) return value;
    // Some harness TUIs render the completed response in the visible screen
    // without including it in Herdr's recent scrollback snapshot.
    const visible = callHerdr(["agent", "read", name, "--source", "visible"], { allowFailure: true });
    value = extractMarker(visible.stdout, marker);
    if (value !== null) return value;
    const snapshot = herdrJson(["agent", "get", name]);
    const agent = snapshot?.result?.agent;
    const lifecycle = agent?.state || agent?.status || agent?.lifecycle_state;
    if (lifecycle === "blocked" && !blockedNoticeShown) {
      stdout.write(`\n${state.harnessChain[state.activeSlot]} needs your input in its focused pane. Relay is waiting.\n`);
      blockedNoticeShown = true;
    } else if (lifecycle !== "blocked") {
      blockedNoticeShown = false;
    }
    await delay(900);
  }
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

async function ensureWorker(state, slot) {
  if (state.workerRunId === state.runId && state.activeSlot === slot && state.workerTabId && state.activeAgentName) return;
  const previousTabId = state.workerTabId;
  const kind = state.harnessChain[slot];
  const tab = herdrJson(["tab", "create", "--workspace", state.workspaceId, "--cwd", state.cwd,
    "--label", `Relay ${kind} ${state.runId.slice(0, 8)}`, "--focus"]);
  const workerTabId = tab?.result?.tab?.tab_id;
  const rootPane = tab?.result?.root_pane?.pane_id;
  if (!workerTabId || !rootPane) throw new Error("Herdr did not return a worker tab and root pane.");
  state.workerTabId = workerTabId;
  state.workerPaneId = rootPane;
  state.activeSlot = slot;
  state.activeAgentName = agentName(state.runId, slot);
  state.workerRunId = state.runId;
  await persist(state);
  stdout.write(`Starting chain slot ${slot + 1}: ${kind}…\n`);
  callHerdr(["agent", "start", state.activeAgentName, "--kind", kind, "--pane", rootPane]);
  if (previousTabId && previousTabId !== workerTabId) {
    callHerdr(["tab", "close", previousTabId]);
  }
  await persist(state);
}

async function runInteractiveApproval(state, tasks, reason = "Approve the final plan") {
  const slot = state.chainCursor;
  const kind = state.harnessChain[slot];
  await ensureWorker(state, slot);
  const name = state.activeAgentName;
  const marker = `RELAY_APPROVAL_${randomUUID().slice(0, 8)}:`;
  state.chainCursor = (slot + 1) % state.harnessChain.length;
  state.stage = "waiting:user-plan-approval";
  state.lastPrompt = { role: "plan-approval", harness: kind, chainSlot: slot, at: new Date().toISOString(), marker };
  await persist(state);
  const prompt = [
    `${reason}. You are the current harness in a multi-harness relay. Present the plan below to the user and discuss any requested changes in this pane. Do not edit files.`,
    "After the user explicitly approves the final plan, return the final tasks and a one-line marker response. If the user requests changes, revise the plan and ask again.",
    `After approval, return exactly one final line in this shape: ${marker} {"decision":"approve","tasks":[{"title":"...","acceptanceCriteria":"..."}]}.`,
    `Agreed change request:\n${state.changeRequest}`,
    `Plan to approve:\n${tasks.map(formatTask).join("\n\n")}`,
  ].join("\n\n");
  try { callHerdr(["agent", "prompt", name, prompt]); }
  catch (error) {
    state.stage = "paused:user-plan-approval";
    state.pauseReason = error.message;
    await persist(state);
    throw new Error(`Could not start the plan approval handoff: ${error.message}`);
  }
  stdout.write(`\n${kind} has the final plan for user approval. Continue in its focused pane.\n`);
  return waitForInteractiveMarker(state, name, marker);
}

async function execute(state) {
  const plan = await runInteractiveIntake(state);
  if (!plan || typeof plan !== "object" || typeof plan.request !== "string" || !plan.request.trim()) {
    throw new Error("The first harness plan must include the agreed request text.");
  }
  if (typeof plan.needsDesignReview !== "boolean" || typeof plan.needsSecondOpinion !== "boolean") {
    throw new Error("Planner must return boolean needsDesignReview and needsSecondOpinion fields.");
  }
  state.changeRequest = plan.request.trim();
  let tasks = validateTasks(plan.tasks, "Planner response");
  state.tasks = tasks;
  await persist(state);
  if (plan.needsDesignReview) {
    const designMarker = `RELAY_DESIGN_${randomUUID().slice(0, 8)}:`;
    const design = await runAgent(state, "designer", [
      "Review this plan for design, architecture, data-model, API, and interaction choices. Do not edit files.",
      `Return one final line: ${designMarker} {\"recommendations\":\"specific design decisions, tradeoffs, and changes the planner should consider\"}`,
      `Change request:\n${state.changeRequest}`,
      `Proposed plan:\n${tasks.map(formatTask).join("\n\n")}`,
    ].join("\n\n"), designMarker);
    state.designNote = design?.recommendations || String(design);
    state.stage = "design-review-complete";
    await persist(state);
    const revisedMarker = `RELAY_REVISED_PLAN_${randomUUID().slice(0, 8)}:`;
    const revised = await runAgent(state, "planner", [
      "Revise your plan using the design review. Keep sound tasks and update tasks and acceptance criteria where needed. Do not edit files.",
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
      `Return one final line: ${opinionMarker} {\"decision\":\"approve\"} OR ${opinionMarker} {\"decision\":\"revise\",\"findings\":\"specific risks or missing work\"}`,
      `Change request:\n${state.changeRequest}`,
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
  if (plan.needsDesignReview || plan.needsSecondOpinion) {
    const approval = await runInteractiveApproval(state, tasks, "Review the plan after design and second-opinion feedback");
    if (approval?.decision !== "approve") throw new Error("Plan approval handoff did not return decision=approve.");
    tasks = validateTasks(approval.tasks, "User-approved plan");
  }
  state.tasks = tasks;
  state.stage = "planned";
  await persist(state);
  await createBoardTickets(state, tasks);

  for (let index = 0; index < tasks.length; index++) {
    const taskText = formatTask(tasks[index], index);
    const ticketId = state.livestock.taskTicketIds[index];
    let approved = false;
    state.taskIndex = index;
    await persist(state);
    await updateBoardTicket(state, ticketId, { status: "in progress", note: "Implementation started." });
    for (let round = 1; round <= maxReviewRounds && !approved; round++) {
      const implementationMarker = `RELAY_IMPLEMENTATION_${randomUUID().slice(0, 8)}:`;
      const result = await runAgent(state, "implementer", [
        `Implement Livestock ticket ${ticketId}, task ${index + 1} of ${tasks.length}. Work only on this ticket's acceptance criteria.`,
        `Parent ticket: ${state.livestock.parentTicketId}. The project board at ${state.livestock.boardPath} is the durable context for this run.`,
        taskText,
        round > 1 ? `Address these review findings from the previous round:\n${state.reviewFindings}` : "",
        `When finished, respond with a short summary and a final line: ${implementationMarker} {\"status\":\"complete\",\"summary\":\"...\"}.`,
      ].filter(Boolean).join("\n\n"), implementationMarker);
      if (result?.status !== "complete") throw new Error("Implementer did not report status=complete; workflow paused.");
      await updateBoardTicket(state, ticketId, { status: "in progress", note: `Implementation round ${round}: ${result.summary || "complete"}` });
      const reviewMarker = `RELAY_REVIEW_${randomUUID().slice(0, 8)}:`;
      const review = await runAgent(state, "reviewer", [
        `Review Livestock ticket ${ticketId} for task ${index + 1} of ${tasks.length}.`, taskText,
        "Check correctness and acceptance criteria. Do not edit files.",
        `Return a final line: ${reviewMarker} {\"decision\":\"approve\"} OR ${reviewMarker} {\"decision\":\"changes\",\"findings\":\"specific actionable findings\"}.`,
      ].join("\n\n"), reviewMarker);
      if (review?.decision === "approve") approved = true;
      else if (review?.decision === "changes" && review.findings) {
        state.reviewFindings = review.findings;
        await updateBoardTicket(state, ticketId, { note: `Review requested changes: ${review.findings}` });
      } else throw new Error("Reviewer returned an invalid decision; workflow paused.");
      state.completedReviewRounds = (state.completedReviewRounds || 0) + 1;
      state.taskIndex = index;
      await persist(state);
    }
    if (!approved) throw new Error(`Task ${index + 1} reached the ${maxReviewRounds}-round review limit. Workflow paused for human review.`);
    await updateBoardTicket(state, ticketId, { status: "done", note: "Implementation approved by reviewer." });
    state.reviewFindings = null;
    state.approvedTasks = [...(state.approvedTasks || []), index];
    state.stage = "task-approved";
    await persist(state);
    stdout.write(`✓ Livestock ticket ${ticketId} approved.\n`);
  }
  await updateBoardTicket(state, state.livestock.parentTicketId, { status: "done", note: "All task tickets completed and reviewed." });
  state.stage = "complete";
  state.completedAt = new Date().toISOString();
  await persist(state);
  callHerdr(["notification", "show", "Harness Relay change complete", "--body", `${tasks.length} Livestock task(s) implemented and reviewed`, "--sound", "done"], { allowFailure: true });
  stdout.write("\nChange complete. Livestock tickets are up to date.\n");
}

async function main() {
  requireHerdrPaneContext();
  const context = (() => {
    try { return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}"); }
    catch { return {}; }
  })();
  const workspace = herdrJson(["workspace", "get", process.env.HERDR_WORKSPACE_ID]);
  const projectCwd = [context.cwd, context.workspace?.cwd, context.workspace?.path,
    context.focused_pane?.cwd, context.focusedPane?.cwd,
    context.workspace_cwd, context.workspaceCwd,
    context.focused_pane_cwd, context.focusedPaneCwd, context.worktree?.path,
    workspace?.result?.workspace?.cwd, workspace?.result?.workspace?.path,
    workspace?.result?.cwd, workspace?.workspace?.cwd, workspace?.workspace?.path]
    .find((candidate) => typeof candidate === "string" && path.isAbsolute(candidate));
  if (!projectCwd) throw new Error("Could not resolve the Herdr workspace directory from plugin context.");
  await acquireProjectLock(projectCwd);
  stdout.write("Harness Relay coordinator\nSelect your harness chain once. Then start each change in the focused first-harness pane; Relay coordinates the handoffs in the background.\n\n");
  const saved = await loadState(projectCwd);
  const canResumeIntake = saved?.stage === "waiting:first-harness-intake" && saved.activeAgentName && saved.lastPrompt?.marker;
  let abandonedRun = null;
  if (saved && !["complete", "cancelled"].includes(saved.stage) && !canResumeIntake) {
    stdout.write(`Saved run ${saved.runId.slice(0, 8)} is at stage ${saved.stage}.\n`);
    stdout.write("Automatic resume is disabled because a prompt may already have been delivered. Inspect the active worker pane before deciding whether to abandon this run.\n");
    if ((await ask("Type new to abandon its saved state and start another run", "no")).toLowerCase() !== "new") return;
    abandonedRun = saved;
  }
  if (canResumeIntake) stdout.write("Resuming the first harness intake for the saved run.\n");
  const setup = await configureHarnesses(await loadHarnessSetup());
  const { harnessChain } = setup;
  let previous = canResumeIntake ? null : saved?.stage === "complete" ? saved : abandonedRun;
  let resume = canResumeIntake ? saved : null;
  while (true) {
    const state = resume || {
      schemaVersion: 1,
      runId: randomUUID(),
      cwd: projectCwd,
      workspaceId: process.env.HERDR_WORKSPACE_ID,
      changeRequest: "",
      harnessChain,
      chainCursor: 0,
      createdAt: new Date().toISOString(),
      stage: "initializing",
      tasks: [],
      approvedTasks: [],
      workerTabId: previous?.workerTabId || null,
      workerPaneId: previous?.workerPaneId || null,
      activeSlot: previous?.activeSlot ?? null,
      activeAgentName: previous?.activeAgentName || null,
      workerRunId: previous?.workerRunId || null,
    };
    await persist(state);
    resume = null;
    await execute(state);
    if (state.stage !== "complete") break;
    previous = state;
    stdout.write("\nRelay is returning the baton to the first harness for your next change.\n");
  }
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
