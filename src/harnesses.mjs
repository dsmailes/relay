import { accessSync, constants } from "node:fs";
import path from "node:path";

// Order here is Relay's rotation order. `bins` are executable names to look for
// on PATH when proposing a default selection.
export const harnesses = [
  { kind: "claude", name: "Claude Code", bins: ["claude"] },
  { kind: "codex", name: "Codex", bins: ["codex"] },
  { kind: "opencode", name: "OpenCode", bins: ["opencode"] },
  { kind: "copilot", name: "GitHub Copilot CLI", bins: ["copilot"] },
  { kind: "pi", name: "Pi", bins: ["pi"] },
  { kind: "gemini", name: "Gemini CLI", bins: ["gemini"] },
  { kind: "cursor", name: "Cursor Agent", bins: ["cursor-agent", "cursor"] },
  { kind: "amp", name: "Amp", bins: ["amp"] },
  { kind: "droid", name: "Droid", bins: ["droid"] },
  { kind: "kimi", name: "Kimi Code", bins: ["kimi"] },
  { kind: "kiro", name: "Kiro CLI", bins: ["kiro-cli", "kiro"] },
  { kind: "cline", name: "Cline", bins: ["cline"] },
  { kind: "devin", name: "Devin CLI", bins: ["devin"] },
  { kind: "agy", name: "Antigravity CLI", bins: ["agy"] },
  { kind: "hermes", name: "Hermes Agent", bins: ["hermes"] },
  { kind: "kilo", name: "Kilo Code CLI", bins: ["kilo"] },
  { kind: "qodercli", name: "Qoder CLI", bins: ["qodercli"] },
  { kind: "qwen", name: "Qwen Code", bins: ["qwen"] },
  { kind: "mastracode", name: "MastraCode", bins: ["mastracode"] },
  { kind: "grok", name: "Grok CLI", bins: ["grok"] },
  { kind: "omp", name: "OMP", bins: ["omp"] },
  { kind: "maki", name: "Maki", bins: ["maki"] },
  { kind: "letta", name: "Letta Code", bins: ["letta"] },
  { kind: "muse", name: "Muse", bins: ["muse"] },
];

const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];

function onPath(bin, searchPath) {
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      try { accessSync(path.join(dir, bin + extension), constants.X_OK); return true; }
      catch { /* try the next candidate */ }
    }
  }
  return false;
}

export function isKind(kind) {
  return harnesses.some((entry) => entry.kind === kind);
}

/** Kinds whose executable is on PATH, in rotation order. */
export function detectInstalled(searchPath = process.env.PATH || "") {
  return harnesses.filter((entry) => entry.bins.some((bin) => onPath(bin, searchPath))).map((entry) => entry.kind);
}

export function inRotationOrder(kinds) {
  return harnesses.map((entry) => entry.kind).filter((kind) => kinds.includes(kind));
}

/** Parses "1,3" or "claude, codex" into kinds, or returns null if anything is unrecognised. */
export function parseSelection(answer) {
  const parts = answer.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  const kinds = parts.map((part) => (/^\d+$/.test(part) ? harnesses[Number(part) - 1]?.kind : isKind(part) ? part : undefined));
  if (kinds.length < 2 || kinds.some((kind) => !kind) || new Set(kinds).size !== kinds.length) return null;
  return inRotationOrder(kinds);
}
