import assert from "node:assert/strict";
import test from "node:test";
import { extractMarker } from "../src/markers.mjs";

const M = "RELAY_REVIEW_1a2b3c4d:";

test("plain line", () => {
  assert.deepEqual(extractMarker(`done\n${M} {"decision":"approve"}\n`, M), { decision: "approve" });
});

test("bullets, box borders and backticks", () => {
  for (const line of [`⏺ ${M} {"decision":"approve"}`, `● ${M} {"decision":"approve"}`, `• ${M} {"decision":"approve"}`,
    `│ ${M} {"decision":"approve"} │`, `┃ ${M} {"decision":"approve"}`, `\`${M} {"decision":"approve"}\``, `  - ${M} {"decision":"approve"}`]) {
    assert.deepEqual(extractMarker(`text\n${line}\n`, M), { decision: "approve" }, line);
  }
});

test("echoed user input is never an answer", () => {
  assert.equal(extractMarker(`❯ ${M} {"decision":"approve"}\n› ${M} {"decision":"approve"}\n> ${M} {"decision":"approve"}`, M), null);
});

test("the prompt template is not valid JSON, so an echo cannot be read as an answer", () => {
  assert.equal(extractMarker(`${M} {"decision": <"approve" or "changes">, "findings": <string>}`, M), null);
});

test("the last marker wins and other markers are ignored", () => {
  const text = `${M} {"decision":"changes","findings":"x"}\nRELAY_REVIEW_ffffffff: {"decision":"approve"}\n${M} {"decision":"approve"}`;
  assert.deepEqual(extractMarker(text, M), { decision: "approve" });
});

test("JSON wrapped over several rows", () => {
  const text = `${M} {"decision":"changes","fin\n  dings":"fix the\n  parser"}\n✻ done`;
  assert.deepEqual(extractMarker(text, M), { decision: "changes", findings: "fix the parser" });
});

test("incomplete or non-object payloads return null", () => {
  assert.equal(extractMarker(`${M} {"decision":"appr`, M), null);
  assert.equal(extractMarker(`${M} [1,2]`, M), null);
  assert.equal(extractMarker("nothing here", M), null);
});

test("wrapping stops at the next message", () => {
  assert.equal(extractMarker(`${M} {"decision":\n⏺ later text "approve"}`, M), null);
});

test("a long brief that hard-wraps over 100 rows still parses (regression: plan was never picked up)", () => {
  const words = Array.from({ length: 1800 }, (_, i) => `word${i}`).join(" ");
  const json = JSON.stringify({ title: "T", request: words, approvedByUser: true, tasks: [{ title: "a", acceptanceCriteria: "b" }] });
  const wrapped = json.match(/.{1,95}(\s|$)/g).map((row) => `  ${row.trim()}`);
  wrapped[0] = `  ${M} ${wrapped[0].trim()}`;
  const value = extractMarker(["earlier chatter", ...wrapped, "", "✻ Baked for 13s", "❯ next"].join("\n"), M);
  assert.equal(value.request, words);
  assert.ok(wrapped.length > 100);
});
