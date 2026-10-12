import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// The Livestock board (.herdr-issues.json) is shared with the Livestock plugin
// and with the harnesses, so every change is a locked read-modify-write.

export function boardPath(cwd) {
  return path.join(cwd, ".herdr-issues.json");
}

async function withBoardLock(target, fn) {
  const lock = `${target}.lock`;
  const deadline = Date.now() + 10_000;
  while (true) {
    try { await mkdir(lock); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      try { if (Date.now() - (await stat(lock)).mtimeMs > 30_000) { await rmdir(lock); continue; } }
      catch { continue; }
      if (Date.now() > deadline) throw new Error("The Livestock board is locked by another process.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try { return await fn(); }
  finally { await rmdir(lock).catch(() => {}); }
}

async function readBoard(target) {
  try {
    const board = JSON.parse(await readFile(target, "utf8"));
    if (!board || !Array.isArray(board.issues)) throw new Error("Livestock board must contain an issues array.");
    return board;
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, issues: [] };
    throw error;
  }
}

async function writeBoard(target, board) {
  let mode = 0o644;
  try { mode = (await stat(target)).mode & 0o777; } catch { /* new file */ }
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(board, null, 2)}\n`, { mode });
  await chmod(temp, mode);
  await rename(temp, target);
}

function newIssueId(issues) {
  let id;
  do { id = randomUUID().replaceAll("-", "").slice(0, 8); }
  while (issues.some((issue) => issue.id === id));
  return id;
}

export async function readTicket(cwd, issueId) {
  const board = await readBoard(boardPath(cwd));
  return board.issues.find((issue) => issue.id === issueId) || null;
}

const normalizeKey = (value) => String(value ?? "").trim().toLowerCase();

/** Find board issues that correspond to an external ticket key. Prefer imported source IDs. */
export async function findTicketsByReference(cwd, reference) {
  const board = await readBoard(boardPath(cwd));
  const key = normalizeKey(reference);
  const sourceMatches = board.issues.filter((issue) => normalizeKey(issue.source_id) === key);
  if (sourceMatches.length) return sourceMatches;
  return board.issues.filter((issue) => {
    const title = String(issue.title ?? "").trim();
    const suffix = title.slice(reference.length, reference.length + 1);
    return title.toLowerCase() === key || (title.toLowerCase().startsWith(key) && (!suffix || /[:\s—-]/.test(suffix)));
  });
}

/** Attach one child per task to an existing or newly-created parent ticket. */
export async function createTickets({ cwd, runId, title, request, tasks, parentTicketId: requestedParentId }) {
  const target = boardPath(cwd);
  return withBoardLock(target, async () => {
    const board = await readBoard(target);
    const now = new Date().toISOString();
    const tag = `Harness Relay run ${runId}`;
    let parent = requestedParentId ? board.issues.find((issue) => issue.id === requestedParentId) : null;
    if (requestedParentId && !parent) throw new Error(`Parent Livestock ticket ${requestedParentId} is missing from ${target}.`);
    if (!parent) parent = board.issues.find((issue) => issue.relay_run_id === runId && issue.relay_parent === true) || null;
    if (parent) {
      parent.status = "in progress";
      if (!String(parent.notes || "").includes(tag)) {
        parent.notes = `${parent.notes || ""}${parent.notes ? "\n\n" : ""}${tag}\n\nRelay is tracking this request as child implementation steps.\n\nRelay request:\n${request}`;
      }
      parent.updated_at = now;
    } else {
      parent = {
        relay_run_id: runId, relay_parent: true,
        id: newIssueId(board.issues), title: title.slice(0, 160), status: "in progress", priority: "normal",
        notes: `${tag}\n\nThis issue tracks a multi-harness change. Child task tickets contain acceptance criteria and handoff notes.\n\nChange request:\n${request}`,
        blocked_by: [], created_at: now, updated_at: now,
      };
      board.issues.push(parent);
    }
    const parentTicketId = parent.id;
    const taskTicketIds = tasks.map((task, index) => {
      const existing = board.issues.find((issue) => issue.parent_id === parentTicketId
        && issue.relay_run_id === runId && issue.relay_task_index === index);
      if (existing) return existing.id;
      const id = newIssueId(board.issues);
      board.issues.push({
        id, title: task.title, status: "open", priority: "normal",
        parent_id: parentTicketId, relay_run_id: runId, relay_task_index: index,
        notes: `${tag}\nParent issue: ${parentTicketId} (${parent.source_id || parent.title})\n\nAcceptance criteria:\n${task.acceptanceCriteria}\n\nSubtask ${index + 1} of ${tasks.length}.`,
        blocked_by: [], created_at: now, updated_at: now,
      });
      return id;
    });
    await writeBoard(target, board);
    return { boardPath: target, parentTicketId, parentTitle: parent.title, parentSourceId: parent.source_id || null, taskTicketIds };
  });
}

export async function updateTicket(cwd, issueId, { status, note } = {}) {
  if (!issueId) return;
  const target = boardPath(cwd);
  await withBoardLock(target, async () => {
    const board = await readBoard(target);
    const issue = board.issues.find((entry) => entry.id === issueId);
    if (!issue) throw new Error(`Livestock ticket ${issueId} is missing from ${target}.`);
    const now = new Date().toISOString();
    if (status) issue.status = status;
    if (note) issue.notes = `${issue.notes || ""}${issue.notes ? "\n\n" : ""}[${now}] ${note}`;
    issue.updated_at = now;
    await writeBoard(target, board);
  });
}
