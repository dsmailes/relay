import { randomUUID } from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import { stdin, stdout } from "node:process";
import { createTickets, readTicket, updateTicket } from "./board.mjs";
import { diffTrees, excludeBoardLocally, saveCheckpoint, snapshotTree } from "./gitdiff.mjs";
import { callHerdr, getAgent, herdrJson, notify, requireHerdrPaneContext } from "./herdr.mjs";
import { detectInstalled, harnesses, inRotationOrder, parseSelection } from "./harnesses.mjs";
import { extractMarker } from "./markers.mjs";
import {
  RelayPause, approvalStep, designStep, formatTasks, implementationStep, intakeStep,
  markerInstruction, opinionStep, revisionStep, reviewStep,
} from "./steps.mjs";
import {
  acquireProjectLock, archiveRun, loadHarnessSetup, loadState, logEvent, persist,
  releaseProjectLock, saveHarnessSetup, writeDiff,
} from "./store.mjs";

const POLL_MS = 1500;
const STEP_TIMEOUT_MS = 4 * 60 * 60 * 1000; // unattended steps; the user is then offered a menu
const IDLE_NUDGE_MS = 90 * 1000;            // settled without a handoff line
const LOST_PROMPT_MS = 45 * 1000;           // prompt never started the harness
const START_TIMEOUT_MS = 180 * 1000;        // first-run dialogs can be slow
const MAX_CORRECTIONS = 3;
const REVIEW_ROUNDS = 3;
const SCHEMA_VERSION = 2;

const MARKER_NAMES = {
  planner: "REVISED_PLAN", designer: "DESIGN", "second-opinion": "OPINION",
  "plan-approval": "APPROVAL", implementer: "IMPLEMENTATION", reviewer: "REVIEW",
};

class StopRun extends Error {}

const input = readline.createInterface({ input: stdin, output: stdout });
const queued = [];
let waiting = null;
let inputClosed = false;
// Lines are buffered so that typing ahead (or piped input) is never lost between questions.
input.on("line", (line) => { if (waiting) { const resolve = waiting; waiting = null; resolve(line); } else queued.push(line); });
input.on("close", () => { inputClosed = true; if (waiting) { const resolve = waiting; waiting = null; resolve(null); } });
let currentState = null;

const out = (text = "") => stdout.write(`${text}\n`);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (state) => state.runId.slice(0, 8);

async function ask(label, fallback = "") {
  stdout.write(fallback ? `${label} [${fallback}]: ` : `${label}: `);
  const line = queued.length ? queued.shift() : inputClosed ? null : await new Promise((resolve) => { waiting = resolve; });
  if (line === null) return "stop";
  return line.trim() || fallback;
}

// ---------------------------------------------------------------- harness setup

async function chooseHarnesses() {
  const saved = await loadHarnessSetup();
  const savedChain = Array.isArray(saved?.harnessChain) ? inRotationOrder(saved.harnessChain) : [];
  const valid = savedChain.length >= 2 && savedChain.length === saved.harnessChain.length;
  if (valid) {
    out(`Harnesses (rotation order): ${savedChain.join(" → ")}`);
    if ((await ask("Press Enter to start, or type change to pick different harnesses", "")).toLowerCase() !== "change") return savedChain;
  }
  const installed = detectInstalled();
  out("\nAvailable harnesses:");
  harnesses.forEach(({ kind, name }, i) => out(`  ${String(i + 1).padStart(2)}. ${name} (${kind})${installed.includes(kind) ? "  ✓ installed" : ""}`));
  const suggestion = valid ? savedChain : installed.slice(0, 3);
  if (!valid && installed.length < 2) {
    out(`\nRelay needs at least two harnesses and found ${installed.length ? installed.join(", ") : "none"} on your PATH.`);
    out("You can still type kinds below if they are installed somewhere else.");
  } else if (!valid) {
    out(`\nFound on your PATH: ${installed.join(", ")}.`);
  }
  while (true) {
    const answer = await ask("Harnesses to rotate between (kinds or numbers, comma separated)", suggestion.join(","));
    if (answer === "stop") throw new StopRun();
    const chain = parseSelection(answer);
    if (!chain) { out("Choose at least two different harnesses from the list."); continue; }
    const missing = chain.filter((kind) => !installed.includes(kind));
    if (missing.length) out(`Note: ${missing.join(", ")} not found on PATH; Relay will stop if Herdr cannot start it.`);
    out(`Rotation order: ${chain.join(" → ")}`);
    await saveHarnessSetup({ harnessChain: chain });
    return chain;
  }
}

// ---------------------------------------------------------------- progress record

function brief(result) {
  const text = result.summary || result.recommendations || result.findings
    || (result.decision && `${result.decision}`) || (result.tasks && `${result.tasks.length} task(s)`) || "";
  return String(text).replace(/\s+/g, " ").slice(0, 200);
}

async function record(state, entry) {
  state.timeline.push({ at: new Date().toISOString(), ...entry });
  await logEvent(state, "step.done", entry);
}

function printProgress(state) {
  out(`\nRun ${short(state)}${state.title ? ` — ${state.title}` : ""}  (${state.harnessChain.join(" → ")})`);
  out(`  ${state.done.intake ? "✓" : "▸"} plan`);
  state.tasks.forEach((task, i) => {
    const mark = state.done[`task-${i}`] ? "✓" : i === state.taskIndex ? "▸" : "·";
    out(`  ${mark} task ${i + 1}/${state.tasks.length}: ${task.title}`);
  });
  if (state.pending) out(`  waiting on: ${state.pending.role} (${state.pending.harness})`);
}

async function withBoard(state, fn) {
  if (!state.livestock || state.livestock.disabled) return undefined;
  try { return await fn(); }
  catch (error) {
    if (!state.boardWarned) { out(`Note: could not update the Livestock board (${error.message}). Relay continues without it.`); state.boardWarned = true; }
    await logEvent(state, "board.error", { message: error.message });
    return undefined;
  }
}

const ticketNote = (state, ticketId, note, status) =>
  withBoard(state, () => updateTicket(state.cwd, ticketId, { note, status }));

// ---------------------------------------------------------------- worker panes

async function ensureWorker(state, slot) {
  const worker = state.worker;
  if (worker && worker.runId === state.runId && worker.slot === slot && getAgent(worker.agent)) return { created: false };
  const kind = state.harnessChain[slot];
  const seq = (state.workerSeq || 0) + 1;
  const agent = `relay_${short(state)}_${String(seq).padStart(2, "0")}`;
  const tab = herdrJson(["tab", "create", "--workspace", state.workspaceId, "--cwd", state.cwd,
    "--label", `Relay ${kind} ${short(state)}`, "--focus"]);
  const tabId = tab?.result?.tab?.tab_id;
  const paneId = tab?.result?.root_pane?.pane_id;
  if (!tabId || !paneId) throw new Error("Herdr did not return a worker tab and root pane.");
  out(`Starting ${kind}…`);
  const started = callHerdr(["agent", "start", agent, "--kind", kind, "--pane", paneId, "--timeout", String(START_TIMEOUT_MS)], { allowFailure: true });
  if (started.status !== 0) {
    callHerdr(["tab", "close", tabId], { allowFailure: true });
    throw new RelayPause(`Herdr could not start ${kind}: ${(started.stderr || started.stdout).trim()}`);
  }
  const previousTab = worker?.tabId;
  state.workerSeq = seq;
  state.worker = { runId: state.runId, slot, tabId, paneId, agent };
  await persist(state);
  await logEvent(state, "worker.start", { harness: kind, agent, tabId });
  if (previousTab && previousTab !== tabId) callHerdr(["tab", "close", previousTab], { allowFailure: true });
  return { created: true };
}

async function sendPrompt(state, text) {
  const deadline = Date.now() + 30 * 60 * 1000;
  let noticed = false;
  while (true) {
    const result = callHerdr(["agent", "prompt", state.worker.agent, text], { allowFailure: true });
    if (result.status === 0) return;
    const message = (result.stderr || result.stdout).trim();
    if (!message.includes("agent_blocked")) throw new RelayPause(`Herdr could not deliver the prompt: ${message}`);
    if (!noticed) {
      notify("Harness Relay needs you", "A harness is waiting on a permission or question before Relay can continue.");
      out("The harness is blocked on a question or permission. Answer it in its pane; Relay will continue.");
      noticed = true;
    }
    if (Date.now() > deadline) throw new RelayPause("The harness stayed blocked for 30 minutes.");
    await delay(2000);
  }
}

// ---------------------------------------------------------------- the step runner

function newMarker(spec) {
  return `RELAY_${spec.key === "intake" ? "PLAN" : MARKER_NAMES[spec.role]}_${randomUUID().slice(0, 8)}:`;
}

const fullPrompt = (p) => `${p.body}\n\n${markerInstruction(p.marker, p.shape)}`;

async function deliver(state, p, text) {
  p.seqAtSend = getAgent(state.worker.agent)?.state_change_seq;
  await sendPrompt(state, text);
  p.outbox = null;
  p.sentAt = new Date().toISOString();
  await persist(state);
}

function readMarker(name, marker) {
  const recent = callHerdr(["agent", "read", name, "--source", "recent-unwrapped", "--lines", "200"], { allowFailure: true });
  const value = extractMarker(recent.stdout, marker);
  if (value !== null) return value;
  // Some TUIs keep the finished reply in the visible screen but not in scrollback.
  return extractMarker(callHerdr(["agent", "read", name, "--source", "visible"], { allowFailure: true }).stdout, marker);
}

async function awaitMarker(state, p, spec) {
  const started = Date.now();
  let idleSince = null;
  let blockedShown = false;
  let nudged = false;
  let resent = false;
  while (true) {
    const value = readMarker(state.worker.agent, p.marker);
    if (value !== null) return value;
    const agent = getAgent(state.worker.agent);
    if (!agent) throw new RelayPause(`The ${p.harness} pane is gone (it was closed or crashed).`);
    const status = agent.agent_status;
    if (status === "blocked") {
      idleSince = null;
      if (!blockedShown) {
        notify("Harness Relay needs you", `${p.harness} is waiting on a permission or question in its pane.`);
        out(`${p.harness} needs your input in its pane. Relay is waiting.`);
        blockedShown = true;
      }
    } else {
      blockedShown = false;
      if (status === "idle" || status === "done") {
        idleSince ??= Date.now();
        const idleFor = Date.now() - idleSince;
        const sawActivity = agent.state_change_seq !== p.seqAtSend;
        if (!sawActivity && !resent && idleFor > LOST_PROMPT_MS) {
          out(`${p.harness} never started on the prompt; sending it again.`);
          await logEvent(state, "prompt.resent", { key: p.key });
          await deliver(state, p, fullPrompt(p));
          resent = true;
          idleSince = null;
        } else if (!spec.interactive && sawActivity && !nudged && idleFor > IDLE_NUDGE_MS) {
          notify("Harness Relay", `${p.harness} stopped without a handoff line. Answer it in its pane if it asked a question.`, "none");
          await deliver(state, p, `You stopped without the handoff line Relay needs. If you are waiting on the user, say so and continue once they answer. Otherwise reply now with only the handoff line:\n${p.marker} ${p.shape}`);
          nudged = true;
          idleSince = null;
        }
      } else {
        idleSince = null;
      }
    }
    if (!spec.interactive && Date.now() - started > STEP_TIMEOUT_MS) {
      throw new RelayPause(`${p.harness} has not finished after ${Math.round(STEP_TIMEOUT_MS / 3600000)} hours.`);
    }
    await delay(POLL_MS);
  }
}

async function pauseMenu(state, p, reason) {
  state.stage = `paused:${p.key}`;
  state.pauseReason = reason;
  await persist(state);
  await logEvent(state, "paused", { key: p.key, reason });
  notify("Harness Relay paused", reason);
  out(`\nRelay is paused: ${reason}`);
  out(`Inspect the "${p.role}" pane (${p.harness}); your work is saved.`);
  const answer = (await ask("Enter = keep waiting, resend = send the prompt again, stop = exit and resume later", "wait")).toLowerCase();
  if (answer === "stop") throw new StopRun();
  state.stage = `running:${p.key}`;
  state.pauseReason = null;
  if (answer === "resend") {
    p.marker = newMarker({ key: p.key, role: p.role });
    p.outbox = fullPrompt(p);
    p.corrections = 0;
  }
  await persist(state);
}

/**
 * Runs one workflow step to completion and returns its validated result. Results are
 * stored in state.done, so re-running the same step after a restart returns instantly.
 * The prompt is sent at most once per marker; on resume Relay re-reads the pane instead.
 */
async function runStep(state, spec, { onStart, onDone } = {}) {
  if (state.done[spec.key] !== undefined) return state.done[spec.key];
  let p = state.pending?.key === spec.key ? state.pending : null;
  if (p) {
    out(`\nResuming: ${p.role} → ${p.harness}`);
  } else {
    const slot = state.chainCursor;
    state.chainCursor = (slot + 1) % state.harnessChain.length;
    const header = spec.ticketId ? await withBoard(state, () => ticketHeader(state, spec.ticketId)) : "";
    p = state.pending = {
      key: spec.key, role: spec.role, slot, harness: state.harnessChain[slot], shape: spec.shape,
      body: [header, spec.intro].filter(Boolean).join("\n\n"), marker: newMarker(spec),
      corrections: 0, outbox: null, sentAt: null, startedAt: new Date().toISOString(),
    };
    p.outbox = fullPrompt(p);
    state.stage = `running:${spec.key}`;
    await persist(state);
    await logEvent(state, "step.start", { key: spec.key, role: spec.role, harness: p.harness });
    out(`\n→ ${spec.role} → ${p.harness} (${slot + 1}/${state.harnessChain.length})`);
    await onStart?.(p);
  }
  while (true) {
    try {
      const { created } = await ensureWorker(state, p.slot);
      if (created) p.outbox = fullPrompt(p); // a new agent has no memory of earlier prompts
      if (p.outbox) await deliver(state, p, p.outbox);
      const value = await awaitMarker(state, p, spec);
      let result;
      try { result = spec.validate(value); }
      catch (error) {
        if (error instanceof RelayPause) {
          // The reply was understood but needs a human (for example "blocked"). Rotate the
          // marker so that "keep waiting" does not re-read the same stale line forever.
          p.marker = newMarker(spec);
          p.outbox = `Relay recorded your reply: ${error.message}\nResolve it (ask the user in this pane if you need to), then end with a new handoff line:\n${p.marker} ${p.shape}`;
          await persist(state);
          throw error;
        }
        if (++p.corrections > MAX_CORRECTIONS) throw new RelayPause(`${p.harness} could not produce a valid handoff line: ${error.message}`);
        out(`${p.harness}'s handoff was rejected (${error.message}); asking for a correction.`);
        await logEvent(state, "handoff.rejected", { key: p.key, reason: error.message });
        p.marker = newMarker(spec);
        p.outbox = `Relay could not accept your handoff line: ${error.message}\n\nReply with a corrected handoff line only:\n${p.marker} ${p.shape}`;
        await persist(state);
        continue;
      }
      state.done[spec.key] = result;
      state.pending = null;
      state.stage = `done:${spec.key}`;
      await record(state, { key: spec.key, role: p.role, harness: p.harness, summary: brief(result) });
      await persist(state);
      await onDone?.(result, p);
      return result;
    } catch (error) {
      if (!(error instanceof RelayPause)) throw error;
      await pauseMenu(state, p, error.message);
    }
  }
}

async function ticketHeader(state, ticketId) {
  const ticket = await readTicket(state.cwd, ticketId);
  if (!ticket) return "";
  return `Livestock ticket ${ticket.id}: ${ticket.title}\nStatus: ${ticket.status}\nNotes and handoff history:\n${ticket.notes || "(none)"}`;
}

// ---------------------------------------------------------------- the workflow

async function planPhase(state) {
  const plan = await runStep(state, intakeStep);
  state.title = plan.title;
  state.changeRequest = plan.request;
  let tasks = plan.tasks;
  const original = tasks;
  let designNote = null;
  let findings = null;
  if (plan.needsDesignReview) {
    const design = await runStep(state, designStep({ request: plan.request, tasks }));
    designNote = design.recommendations;
    tasks = (await runStep(state, revisionStep({
      key: "design-revision", label: "the design review", request: plan.request, tasks,
      feedbackTitle: "Design recommendations", feedback: designNote,
    }))).tasks;
  }
  if (plan.needsSecondOpinion) {
    const opinion = await runStep(state, opinionStep({ request: plan.request, tasks, designNote }));
    if (opinion.decision === "revise") {
      findings = opinion.findings;
      tasks = (await runStep(state, revisionStep({
        key: "opinion-revision", label: "the independent review", request: plan.request, tasks,
        feedbackTitle: "Second-opinion findings", feedback: findings,
      }))).tasks;
    }
  }
  if (JSON.stringify(tasks) !== JSON.stringify(original)) {
    tasks = (await runStep(state, approvalStep({ request: plan.request, original, tasks, designNote, findings }))).tasks;
  }
  state.tasks = tasks;
  state.stage = "planned";
  await persist(state);
  return plan;
}

async function ensureTickets(state) {
  if (state.livestock) return;
  try {
    state.livestock = await createTickets({
      cwd: state.cwd, runId: state.runId, title: state.title, request: state.changeRequest, tasks: state.tasks,
    });
    out(`Added a parent ticket and ${state.tasks.length} task ticket(s) to Livestock.`);
  } catch (error) {
    state.livestock = { disabled: true };
    out(`Note: could not create Livestock tickets (${error.message}). Relay continues without them.`);
  }
  await persist(state);
}

async function runTask(state, index) {
  const tasks = state.tasks;
  const task = tasks[index];
  const ticketId = state.livestock.taskTicketIds?.[index];
  state.taskIndex = index;
  if (!(index in state.git.base)) state.git.base[index] = await snapshotTree(state.cwd);
  if (!state.done[`started-${index}`]) {
    await ticketNote(state, ticketId, "Implementation started.", "in progress");
    state.done[`started-${index}`] = true;
  }
  await persist(state);
  printProgress(state);
  const hasGit = state.git.base[index] !== null;
  const baton = (p) => ticketNote(state, ticketId, `Baton passed to ${p.harness} as ${p.role}.`);
  let accepted = false;
  for (let round = 1; !accepted; round++) {
    if (round > (state.allowedRounds[index] ?? REVIEW_ROUNDS)) {
      out(`\nTask ${index + 1} has used ${round - 1} implementation/review rounds without approval.`);
      const answer = (await ask("more = allow 2 more rounds, accept = accept the work as it is, stop = exit and resume later", "stop")).toLowerCase();
      if (answer === "more") { state.allowedRounds[index] = (state.allowedRounds[index] ?? REVIEW_ROUNDS) + 2; await persist(state); }
      else if (answer === "accept") { accepted = true; await ticketNote(state, ticketId, "Accepted by the user after the review limit."); break; }
      else throw new StopRun();
    }
    const findings = round > 1 ? state.done[`review-${index}-${round - 1}`]?.findings : null;
    const impl = await runStep(state, implementationStep({
      key: `impl-${index}-${round}`, ticket: { id: ticketId }, index, total: tasks.length, task, findings, hasGit,
    }), {
      onStart: baton,
      onDone: (result) => ticketNote(state, ticketId, `Implementation round ${round}: ${result.summary}`, "in progress"),
    });
    const reviewKey = `review-${index}-${round}`;
    let diff = null;
    if (state.done[reviewKey] === undefined && hasGit) {
      const tree = await snapshotTree(state.cwd);
      diff = diffTrees(state.cwd, state.git.base[index], tree);
      if (diff) {
        const file = await writeDiff(`${short(state)}-task${index + 1}-round${round}.patch`, diff.fullPatch);
        await logEvent(state, "diff.saved", { task: index + 1, round, file, stat: diff.stat });
      }
    }
    const review = await runStep(state, reviewStep({
      key: reviewKey, ticket: { id: ticketId }, index, total: tasks.length, task, summary: impl.summary, diff,
    }), {
      onStart: baton,
      onDone: (result) => ticketNote(state, ticketId,
        result.decision === "approve" ? "Reviewer approved." : `Reviewer requested changes: ${result.findings}`),
    });
    if (review.decision === "approve") accepted = true;
  }
  const tree = await snapshotTree(state.cwd);
  const ref = `refs/relay/${short(state)}/task-${index + 1}`;
  if (saveCheckpoint(state.cwd, tree, ref, `Harness Relay: ${task.title}`)) state.git.checkpoints[index] = ref;
  if (!(index + 1 in state.git.base)) state.git.base[index + 1] = tree;
  state.done[`task-${index}`] = true;
  await ticketNote(state, ticketId, "Task approved.", "done");
  await persist(state);
  await logEvent(state, "task.done", { task: index + 1, checkpoint: state.git.checkpoints[index] || null });
  out(`✓ Task ${index + 1}/${tasks.length} approved: ${task.title}`);
}

async function execute(state) {
  await excludeBoardLocally(state.cwd).catch(() => {});
  await planPhase(state);
  if (!state.announcedPlan) {
    out(`\nApproved plan — ${state.title}\n${formatTasks(state.tasks)}`);
    state.announcedPlan = true;
    await persist(state);
  }
  await ensureTickets(state);
  for (let index = 0; index < state.tasks.length; index++) {
    if (!state.done[`task-${index}`]) await runTask(state, index);
  }
  const summary = state.timeline.map((entry) => `${entry.role} (${entry.harness}): ${entry.summary}`).join("\n");
  await withBoard(state, () => updateTicket(state.cwd, state.livestock.parentTicketId, {
    status: "done", note: `All task tickets completed and reviewed.\n\nTimeline:\n${summary}`,
  }));
  state.stage = "complete";
  state.completedAt = new Date().toISOString();
  await archiveRun(state, "complete");
  notify("Harness Relay change complete", `${state.tasks.length} task(s) implemented and reviewed`, "done");
  out(`\nChange complete: ${state.title}`);
  out(`${state.tasks.length} task(s) implemented and reviewed. Changes are in your working tree, uncommitted.`);
  const refs = Object.values(state.git.checkpoints);
  if (refs.length) out(`Checkpoints per task: ${refs.join(", ")}`);
}

// ---------------------------------------------------------------- startup

function resolveProjectCwd() {
  const context = (() => {
    try { return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}"); }
    catch { return {}; }
  })();
  const workspace = herdrJson(["workspace", "get", process.env.HERDR_WORKSPACE_ID]);
  const cwd = [context.cwd, context.workspace?.cwd, context.workspace?.path,
    context.focused_pane?.cwd, context.focusedPane?.cwd,
    context.workspace_cwd, context.workspaceCwd,
    context.focused_pane_cwd, context.focusedPaneCwd, context.worktree?.path,
    workspace?.result?.workspace?.cwd, workspace?.result?.workspace?.path,
    workspace?.result?.cwd, workspace?.workspace?.cwd, workspace?.workspace?.path]
    .find((candidate) => typeof candidate === "string" && path.isAbsolute(candidate));
  if (!cwd) throw new Error("Could not resolve the Herdr workspace directory from plugin context.");
  return cwd;
}

function newState(cwd, harnessChain, previous) {
  return {
    schemaVersion: SCHEMA_VERSION, runId: randomUUID(), cwd, workspaceId: process.env.HERDR_WORKSPACE_ID,
    harnessChain, chainCursor: 0, createdAt: new Date().toISOString(), stage: "initializing",
    title: "", changeRequest: "", tasks: [], taskIndex: null,
    done: {}, pending: null, timeline: [], allowedRounds: {},
    git: { base: {}, checkpoints: {} },
    worker: previous?.worker || null, workerSeq: 0, livestock: null,
  };
}

const finished = (state) => state.stage === "complete" || Boolean(state.outcome);

async function main() {
  requireHerdrPaneContext();
  const cwd = resolveProjectCwd();
  await acquireProjectLock(cwd);
  out("Harness Relay\nYou talk to the first harness; Relay passes the baton for implementation and review.\n");
  const saved = await loadState(cwd);
  let resume = null;
  let previous = saved && finished(saved) ? saved : null;
  if (saved && !finished(saved)) {
    if (saved.schemaVersion === SCHEMA_VERSION) {
      printProgress(saved);
      out(`Stage: ${saved.stage}${saved.pauseReason ? ` (${saved.pauseReason})` : ""}`);
      const answer = (await ask("\nPress Enter to resume this run, type new to abandon it and start another, or quit", "resume")).toLowerCase();
      if (answer === "quit" || answer === "stop") return;
      if (answer === "new") { await archiveRun(saved, "abandoned"); previous = saved; }
      else resume = saved;
    } else {
      out(`Saved run ${saved.runId.slice(0, 8)} was made by an older Relay version and cannot be resumed.`);
      if ((await ask("Type new to abandon it and start another", "quit")).toLowerCase() !== "new") return;
      previous = saved;
    }
  }
  const harnessChain = resume ? resume.harnessChain : await chooseHarnesses();
  while (true) {
    const state = resume || newState(cwd, harnessChain, previous);
    resume = null;
    currentState = state;
    await persist(state);
    await logEvent(state, "run.start", { harnessChain: state.harnessChain });
    if (state.stage === "initializing") out("\nTalk to the first harness in its focused pane. Relay is waiting for the approved plan.");
    else printProgress(state);
    await execute(state);
    previous = state;
    out("\nRelay is returning the baton to the first harness for your next change.");
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof StopRun) {
    out("\nStopped. Progress is saved; start Harness Relay again to resume.");
  } else {
    out(`\nHarness Relay stopped: ${error.message}\nProgress is saved; start Harness Relay again to resume.`);
    process.exitCode = 1;
    if (currentState) {
      currentState.stage = `error:${currentState.pending?.key || currentState.stage}`;
      currentState.pauseReason = error.message;
      await persist(currentState).catch(() => {});
      await logEvent(currentState, "error", { message: error.message });
    }
  }
} finally {
  input.close();
  await releaseProjectLock();
}
