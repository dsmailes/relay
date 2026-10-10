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

/** Adds a parent ticket and one child per task. Returns { boardPath, parentTicketId, taskTicketIds }. */
export async function createTickets({ cwd, runId, title, request, tasks }) {
  const target = boardPath(cwd);
  return withBoardLock(target, async () => {
    const board = await readBoard(target);
    const now = new Date().toISOString();
    const tag = `Harness Relay run ${runId}`;
    const parentTicketId = newIssueId(board.issues);
    board.issues.push({
      id: parentTicketId, title: title.slice(0, 160), status: "in progress", priority: "normal",
      notes: `${tag}\n\nThis issue tracks a multi-harness change. Child task tickets contain acceptance criteria and handoff notes.\n\nChange request:\n${request}`,
      blocked_by: [], created_at: now, updated_at: now,
    });
    const taskTicketIds = tasks.map((task, index) => {
      const id = newIssueId(board.issues);
      board.issues.push({
        id, title: task.title, status: "open", priority: "normal",
        notes: `${tag}\nParent issue: ${parentTicketId}\n\nAcceptance criteria:\n${task.acceptanceCriteria}\n\nTask ${index + 1} of ${tasks.length}.`,
        blocked_by: [], created_at: now, updated_at: now,
      });
      return id;
    });
    await writeBoard(target, board);
    return { boardPath: target, parentTicketId, taskTicketIds };
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
