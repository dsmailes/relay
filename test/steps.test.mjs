import assert from "node:assert/strict";
import test from "node:test";
import {
  RelayPause, implementationStep, intakeStep, markerInstruction, opinionStep, reviewStep, shapes, validateTasks,
} from "../src/steps.mjs";

test("no handoff shape parses as JSON (echoed prompts must never look like answers)", () => {
  for (const [name, shape] of Object.entries(shapes)) assert.throws(() => JSON.parse(shape), undefined, name);
  const line = markerInstruction("RELAY_X_12345678:", shapes.review).split("\n").find((l) => l.startsWith("RELAY_X"));
  assert.throws(() => JSON.parse(line.slice("RELAY_X_12345678: ".length)));
});

const goodPlan = { title: "T", request: "do it", approvedByUser: true, needsDesignReview: false, needsSecondOpinion: true,
  tasks: [{ title: "a", acceptanceCriteria: "b" }] };

test("intake accepts a complete approved plan", () => {
  const plan = intakeStep.validate(goodPlan);
  assert.equal(plan.needsSecondOpinion, true);
  assert.equal(plan.tasks.length, 1);
});

test("intake rejects unapproved plans, string booleans, and bad tasks", () => {
  assert.throws(() => intakeStep.validate({ ...goodPlan, approvedByUser: false }), /approvedByUser/);
  assert.throws(() => intakeStep.validate({ ...goodPlan, needsDesignReview: "false" }), /booleans/);
  assert.throws(() => intakeStep.validate({ ...goodPlan, request: " " }), /request/);
  assert.throws(() => validateTasks([], "Plan"), /between 1 and 20/);
  assert.throws(() => validateTasks([{ title: "x" }], "Plan"), /acceptanceCriteria/);
  assert.throws(() => validateTasks(Array.from({ length: 21 }, () => ({ title: "a", acceptanceCriteria: "b" })), "Plan"), /between 1 and 20/);
});

test("intake derives a title from the request when missing", () => {
  assert.equal(intakeStep.validate({ ...goodPlan, title: undefined, request: "First line\nsecond" }).title, "First line");
});

test("review and opinion decisions need findings when they push back", () => {
  const review = reviewStep({ key: "r", index: 0, total: 1, task: { title: "a", acceptanceCriteria: "b" }, diff: null });
  assert.deepEqual(review.validate({ decision: "approve" }).decision, "approve");
  assert.throws(() => review.validate({ decision: "changes" }), /findings/);
  assert.throws(() => review.validate({ decision: "maybe" }), /decision/);
  const opinion = opinionStep({ request: "r", tasks: [{ title: "a", acceptanceCriteria: "b" }] });
  assert.throws(() => opinion.validate({ decision: "revise" }), /findings/);
});

test("a blocked implementer pauses the run instead of being treated as invalid output", () => {
  const step = implementationStep({ key: "i", index: 0, total: 1, task: { title: "a", acceptanceCriteria: "b" } });
  assert.throws(() => step.validate({ status: "blocked", summary: "need a key" }), RelayPause);
  assert.throws(() => step.validate({ status: "complete" }), /summary/);
  assert.equal(step.validate({ status: "complete", summary: "ok" }).status, "complete");
});

test("the reviewer prompt carries the task's diff", () => {
  const diff = { stat: "a.txt | 1 +", patch: "+hello", truncated: false };
  const text = reviewStep({ key: "r", index: 0, total: 1, task: { title: "a", acceptanceCriteria: "b" }, diff }).intro;
  assert.match(text, /\+hello/);
  assert.match(text, /a\.txt \| 1 \+/);
});
