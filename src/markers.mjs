// Handoff markers are single lines a harness prints at the end of its reply:
//   RELAY_REVIEW_1a2b3c4d: {"decision":"approve"}
// Terminal UIs decorate and wrap those lines, so the parser tolerates bullets,
// box-drawing borders, backticks and JSON split across rows. It deliberately
// does NOT strip input-prompt glyphs (❯ › >): those mark echoed user input, and
// Relay's own prompt text must never be mistaken for an answer.

const BORDER_LEAD = /^[\s│┃┆┊║|▌▍▎]+/;
const BORDER_TRAIL = /[\s│┃┆┊║|▌▍▎]+$/;
const BULLET_LEAD = /^(?:[*•●◦⏺✦▪■‣·]+|-)\s*/;
const KNOWN_KEYS = new Set([
  "title", "request", "approvedByUser", "needsDesignReview", "needsSecondOpinion",
  "tasks", "acceptanceCriteria", "recommendations", "decision", "findings",
  "status", "summary", "testsRun",
]);
const STOP_ROW = /^(?:[*•●◦⏺✦▪■‣·✻❯›]|RELAY_[A-Z0-9_]+_[0-9a-f]{8}:|```)/;
const MAX_CONTINUATION_ROWS = 400; // a real brief plus tasks hard-wraps to 80+ rows

function cleanRow(line) {
  return line.replace(/\r/g, "").replace(BORDER_LEAD, "").replace(BORDER_TRAIL, "");
}

function parseWrappedJson(parts) {
  const candidates = [parts.join(" "), parts.join(""), parts.join("\n")];
  for (const candidate of candidates) {
    const normalized = candidate.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"(\s*):/g, (whole, key, colon) => {
      const compactKey = key.replace(/\s/g, "");
      return KNOWN_KEYS.has(compactKey) ? `"${compactKey}"${colon}:` : whole;
    });
    try {
      const value = JSON.parse(normalized);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch { /* The handoff may continue on the next wrapped row. */ }
  }
  return null;
}

/** Returns the parsed JSON object that follows `prefix`, or null. Searches from the bottom. */
export function extractMarker(text, prefix) {
  const lines = text.replace(/\r/g, "").split("\n");
  for (let start = lines.length - 1; start >= 0; start--) {
    const row = cleanRow(lines[start]).replace(BULLET_LEAD, "").replace(/^`+/, "");
    if (!row.startsWith(prefix)) continue;
    const parts = [row.slice(prefix.length).trim().replace(/`+$/, "")];
    let value = parseWrappedJson(parts);
    if (value !== null) return value;
    let used = 0;
    for (let next = start + 1; next < lines.length && used < MAX_CONTINUATION_ROWS; next++) {
      const continuation = cleanRow(lines[next]);
      if (!continuation) continue;
      if (STOP_ROW.test(continuation)) break;
      parts.push(continuation.replace(/`+$/, ""));
      used++;
      value = parseWrappedJson(parts);
      if (value !== null) return value;
    }
  }
  return null;
}
