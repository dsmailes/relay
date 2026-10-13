import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadState, statePath } from "./store.mjs";
import { harnesses } from "./harnesses.mjs";

const POLL_MS = 500;
const RESET = "\u001b[0m";
const COLORS = [36, 35, 32, 33, 34, 91, 96, 92, 95, 94, 93, 90];
const ICONS = {
  claude: "✳", codex: "⬡", opencode: "◈", copilot: "⌘", pi: "π", gemini: "✦",
  cursor: "▣", amp: "∿", droid: "◍", kimi: "✧", kiro: "◆", cline: "▸",
  devin: "⚡", agy: "✴", hermes: "☿", kilo: "⌖", qodercli: "◇", qwen: "✥",
  mastracode: "▤", grok: "✕", omp: "λ", maki: "◐", letta: "♧", muse: "♫",
};

const nameFor = (kind) => harnesses.find((entry) => entry.kind === kind)?.name || kind || "Relay";

function iconFor(kind, color = true) {
  const symbol = ICONS[kind] || "◆";
  const palette = COLORS[Math.max(0, harnesses.findIndex((entry) => entry.kind === kind)) % COLORS.length];
  return color && process.stdout.isTTY && !process.env.NO_COLOR ? `\u001b[38;5;${palette}m${symbol}${RESET}` : symbol;
}

function shortText(value, width) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (Array.from(text).length <= width) return text;
  return `${Array.from(text).slice(0, Math.max(1, width - 1)).join("")}…`;
}

function clockTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function stepTitle(key, state) {
  if (key === "intake") return "Plan and discuss the change";
  if (key === "design") return "Design review";
  if (key === "opinion") return "Second opinion";
  if (key === "design-revision") return "Revise plan after design review";
  if (key === "opinion-revision") return "Revise plan after second opinion";
  if (key === "approval") return "Approve revised plan with user";
  const match = /^(impl|review)-(\d+)-(\d+)$/.exec(key || "");
  if (!match) return key || "Relay step";
  const [, kind, taskIndex, round] = match;
  const task = state.tasks?.[Number(taskIndex)]?.title || `step ${Number(taskIndex) + 1}`;
  return `${kind === "impl" ? "Implement" : "Review"} · ${task} · round ${round}`;
}

function timelineRows(state) {
  const rows = (state.timeline || []).map((entry) => ({ ...entry, status: "done" }));
  if (state.pending && !rows.some((entry) => entry.key === state.pending.key)) {
    rows.push({
      key: state.pending.key,
      role: state.pending.role,
      harness: state.pending.harness,
      at: state.pending.startedAt,
      summary: state.pauseReason || "Working…",
      status: String(state.stage || "").startsWith("paused:") ? "paused" : "active",
    });
  }
  return rows;
}

function activityRow(entry, state, width) {
  const isActive = entry.status === "active";
  const paused = entry.status === "paused";
  const marker = isActive ? "●" : paused ? "!" : "✓";
  const icon = iconFor(entry.harness);
  const time = clockTime(entry.at);
  const label = `${marker} ${icon} ${nameFor(entry.harness)} · ${entry.role || "step"} · ${stepTitle(entry.key, state)}${time ? ` · ${time}` : ""}`;
  const summary = entry.summary ? `  ${entry.summary}` : "";
  return [shortText(label, width), ...(summary ? [shortText(summary, width)] : [])];
}

function podiumLines(state, width) {
  const runners = (state.harnessChain || []).map((kind) => `${iconFor(kind)} ${nameFor(kind)}`).join("  ·  ");
  return [
    "",
    "  🏆  TOKEN PODIUM · FEWEST TOKENS WINS",
    "      ┌──────────┐",
    "   ┌──┤  N / A   ├──┐",
    "   │  └──────────┘  │",
    " ┌─┴────┐      ┌────┴─┐",
    " │  N/A │      │ N/A  │",
    " └──────┘      └──────┘",
    "  Actual token totals are not exposed by the current Herdr agent data, so no ranking is shown.",
    `  Finishers: ${runners || "no harnesses recorded"}`,
  ].map((line) => shortText(line, width));
}

function previousCompletedLines(run, width) {
  if (!run) return [];
  const participants = (run.harnessChain || []).map((kind) => `${iconFor(kind)} ${nameFor(kind)}`).join(" · ");
  return [
    "",
    `  Last completed: ${run.title || "Relay change"}`,
    `  Finishers: ${participants || "unknown"}`,
    "  Token podium: unranked (token totals unavailable)",
  ].map((line) => shortText(line, width));
}

export function renderTimeline(state, { columns = 100, rows = 40, previousRun = null } = {}) {
  const width = Math.max(40, columns - 2);
  const approved = (state.tasks || []).filter((_, index) => state.done?.[`task-${index}`]).length;
  const total = state.tasks?.length || 0;
  const title = state.livestock?.parentTitle || state.title || path.basename(state.cwd || "Relay change");
  const sourceId = state.livestock?.parentSourceId;
  const heading = sourceId && !String(title).toLowerCase().startsWith(String(sourceId).toLowerCase()) ? `${sourceId}: ${title}` : title;
  const status = state.stage === "complete" ? "complete" : state.pauseReason ? "paused" : state.pending ? `${state.pending.role} · ${state.pending.harness}` : state.stage || "starting";
  const lines = [
    "  HERDR RELAY · ACTIVITY",
    `  ${shortText(heading, width - 2)}`,
    `  ${total ? `${approved}/${total} implementation steps approved` : "Planning in progress"} · ${status}`,
    `  Rotation: ${(state.harnessChain || []).map((kind) => `${iconFor(kind)} ${nameFor(kind)}`).join(" → ")}`,
    "",
  ];

  const entries = timelineRows(state);
  const activity = entries.flatMap((entry) => activityRow(entry, state, width));
  const footer = state.stage === "complete" ? podiumLines(state, width) : previousCompletedLines(previousRun, width);
  const activityBudget = Math.max(1, rows - lines.length - footer.length - 1);
  if (activity.length > activityBudget) {
    const hidden = activity.length - activityBudget + 1;
    lines.push(`  … ${hidden} earlier timeline lines hidden …`);
    lines.push(...activity.slice(-activityBudget));
  } else {
    lines.push(...activity);
  }
  lines.push(...footer);
  return lines.slice(0, Math.max(1, rows - 1)).join("\n");
}

async function latestCompletedRun(currentRunId) {
  const directory = path.join(process.env.HERDR_PLUGIN_STATE_DIR, "runs");
  let files;
  try { files = await readdir(directory); } catch { return null; }
  const candidates = [];
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    try {
      const filename = path.join(directory, file);
      const info = await stat(filename);
      candidates.push({ filename, mtimeMs: info.mtimeMs });
    } catch { /* The archive may be rotating while the panel refreshes. */ }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates) {
    try {
      const run = JSON.parse(await readFile(candidate.filename, "utf8"));
      if (run.runId !== currentRunId && run.cwd === process.cwd() && run.outcome === "complete") return run;
    } catch { /* Ignore an unreadable archive and keep looking. */ }
  }
  return null;
}

async function refresh() {
  const cwd = process.cwd();
  let state;
  try { state = await loadState(cwd); }
  catch (error) {
    process.stdout.write(`\u001b[2J\u001b[HRelay timeline could not read run state: ${error.message}\n`);
    return;
  }
  if (!state) {
    process.stdout.write("\u001b[2J\u001b[HRelay timeline is waiting for a run…\n");
    return;
  }
  const previousRun = state.stage === "complete" ? null : await latestCompletedRun(state.runId);
  const text = renderTimeline(state, {
    columns: process.stdout.columns || 100,
    rows: process.stdout.rows || 40,
    previousRun,
  });
  process.stdout.write(`\u001b[2J\u001b[H${text}\n\u001b[J`);
}

async function main() {
  if (!process.env.HERDR_PLUGIN_STATE_DIR) throw new Error("Herdr did not provide HERDR_PLUGIN_STATE_DIR.");
  process.stdout.write("\u001b[?25l");
  let lastSignature = "";
  const tick = async () => {
    try {
      const info = await stat(statePath(process.cwd()));
      const signature = `${info.ino}:${info.mtimeMs}:${info.size}:${process.stdout.columns}:${process.stdout.rows}`;
      if (signature !== lastSignature) {
        lastSignature = signature;
        await refresh();
      }
    } catch {
      if (lastSignature !== "missing") {
        lastSignature = "missing";
        await refresh();
      }
    }
  };
  const timer = setInterval(() => { void tick(); }, POLL_MS);
  await tick();
  process.stdout.on("resize", () => { lastSignature = ""; void tick(); });
  const close = () => {
    clearInterval(timer);
    process.stdout.write("\u001b[?25h\n");
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stdout.write(`\u001b[?25hRelay timeline stopped: ${error.message}\n`);
    process.exitCode = 1;
  });
}
