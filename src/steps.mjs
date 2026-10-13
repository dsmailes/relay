// Prompt text and answer validation for every workflow step. Everything here is
// pure so it can be tested without Herdr.
//
// Shapes use bare <placeholders> on purpose: they are NOT valid JSON, so if a
// terminal echoes Relay's own prompt back, the parser can never mistake the
// template for a real answer.

export class RelayPause extends Error {}
export class RelayBlocked extends RelayPause {}

const TASKS_SHAPE = '[{"title": <string>, "acceptanceCriteria": <string>}]';

export const shapes = {
  plan: `{"title": <short title>, "request": <self-contained brief>, "approvedByUser": true, "needsDesignReview": <true or false>, "needsSecondOpinion": <true or false>, "tasks": ${TASKS_SHAPE}}`,
  design: '{"recommendations": <string>}',
  revision: `{"tasks": ${TASKS_SHAPE}}`,
  opinion: '{"decision": <"approve" or "revise">, "findings": <string, required when revising>}',
  approval: `{"decision": "approve", "tasks": ${TASKS_SHAPE}}`,
  implementation: '{"status": <"complete" or "blocked">, "summary": <what changed, and which tests or build you ran>, "skillsUsed": [<installed skill names invoked>], "skillNote": <unavailable relevant skills, or empty string>}',
  review: '{"decision": <"approve" or "changes">, "findings": <specific actionable findings, required for changes>, "skillsUsed": [<installed skill names consulted>], "skillNote": <unavailable relevant skills, or empty string>}',
};

const FRESH_SESSION = "You are a fresh session in a multi-harness relay. You have not seen earlier conversation, so rely on the material below and on the project files.";
const SKILL_GUIDANCE = [
  "Before doing this step, read applicable project guidance (such as AGENTS.md and harness-specific instruction files). Discover relevant skills installed and available to this harness, then invoke them through the harness's native skill mechanism. Choose skills that fit this step; do not install skills. If no relevant skill is available or the skill catalog cannot be accessed, continue with the project guidance. When the handoff schema has skillsUsed and skillNote fields, fill them accurately; otherwise, apply the skill guidance without adding fields the schema does not allow.",
  "For The Composable Architecture (TCA) work, explicitly look for applicable Point-Free/pfw skills and invoke the ones relevant to this step. Examples include pfw-composable-architecture for reducers and feature architecture, pfw-dependencies for dependency clients, pfw-testing or pfw-snapshot-testing for tests, and pfw-modern-swiftui or pfw-swift-navigation for UI and navigation. Do not invoke unrelated skills.",
].join("\n\n");

function validateSkillUse(value) {
  const skillsUsed = value.skillsUsed ?? [];
  if (!Array.isArray(skillsUsed) || skillsUsed.some((name) => !isText(name))) {
    throw new Error('"skillsUsed" must be an array of skill-name strings.');
  }
  if (value.skillNote !== undefined && typeof value.skillNote !== "string") {
    throw new Error('"skillNote" must be a string when provided.');
  }
  return {
    skillsUsed: [...new Set(skillsUsed.map((name) => name.trim()))],
    skillNote: value.skillNote?.trim() || "",
  };
}

export function markerInstruction(marker, shape) {
  return [
    "When you are finished, end your reply with exactly one handoff line. Print it as plain text on its own row: no code block, no backticks, no bold, and the whole JSON on a single line. Format:",
    `${marker} ${shape}`,
    "Replace each <placeholder> with real JSON values. Relay reads this line to pass the baton to the next harness, so do not omit it.",
  ].join("\n");
}

export function formatTask(task, index) {
  return `${index + 1}. ${task.title}\nAcceptance criteria: ${task.acceptanceCriteria}`;
}

export function formatTasks(tasks) {
  return tasks.map(formatTask).join("\n\n");
}

const isText = (value) => typeof value === "string" && value.trim() !== "";

export function validateTasks(tasks, label) {
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > 20) {
    throw new Error(`${label} must contain between 1 and 20 tasks.`);
  }
  return tasks.map((task, index) => {
    if (!task || !isText(task.title) || !isText(task.acceptanceCriteria)) {
      throw new Error(`${label}: task ${index + 1} needs non-empty "title" and "acceptanceCriteria" strings.`);
    }
    return { title: task.title.trim(), acceptanceCriteria: task.acceptanceCriteria.trim() };
  });
}

function decision(value, allowed, label) {
  if (!allowed.includes(value?.decision)) throw new Error(`${label}: "decision" must be ${allowed.map((d) => `"${d}"`).join(" or ")}.`);
  return value.decision;
}

export const intakeStep = {
  key: "intake", role: "planner", interactive: true, shape: shapes.plan,
  intro: [
    "You are the user's front-door coding harness in a multi-harness relay. The user will describe a code change directly to you in this pane.",
    SKILL_GUIDANCE,
    "Apply relevant skill guidance to the proposed plan. Include skill-derived constraints in the self-contained request and acceptance criteria when they matter to later harnesses.",
    "Discuss and clarify the request with the user. Draft an ordered plan of small tasks, each with acceptance criteria, and show it to the user. Do not edit files and do not start implementing.",
    "Other harnesses will carry out the plan and they will NOT see this conversation. So \"request\" must be a self-contained brief: the goal, constraints, decisions agreed with the user, and non-goals.",
    "Set needsDesignReview=true only for meaningful UI, architecture, data-model, API or interaction choices. Set needsSecondOpinion=true only when an independent plan review would materially reduce risk. Use between 1 and 20 tasks.",
    "Print the handoff line only after the user has explicitly approved the plan in a message. Printing it starts the implementation, so until then stay in conversation.",
  ].join("\n\n"),
  validate(value) {
    if (!isText(value.request)) throw new Error('"request" must be a non-empty brief.');
    if (value.approvedByUser !== true) throw new Error('"approvedByUser" must be true: print the handoff line only after the user approves the plan.');
    if (typeof value.needsDesignReview !== "boolean" || typeof value.needsSecondOpinion !== "boolean") {
      throw new Error('"needsDesignReview" and "needsSecondOpinion" must be JSON booleans.');
    }
    const request = value.request.trim();
    return {
      title: (isText(value.title) ? value.title : request.split("\n")[0]).trim().slice(0, 160),
      request,
      needsDesignReview: value.needsDesignReview,
      needsSecondOpinion: value.needsSecondOpinion,
      tasks: validateTasks(value.tasks, "Plan"),
    };
  },
};

export function designStep({ request, tasks }) {
  return {
    key: "design", role: "designer", shape: shapes.design,
    intro: [
      FRESH_SESSION,
      SKILL_GUIDANCE,
      "Review this plan for design, architecture, data-model, API and interaction choices. Do not edit files.",
      "Reply with specific decisions, tradeoffs and changes the planner should make.",
      `Change request:\n${request}`, `Proposed plan:\n${formatTasks(tasks)}`,
    ].join("\n\n"),
    validate(value) {
      if (!isText(value.recommendations)) throw new Error('"recommendations" must be a non-empty string.');
      return { recommendations: value.recommendations.trim() };
    },
  };
}

export function revisionStep({ key, label, request, tasks, feedbackTitle, feedback }) {
  return {
    key, role: "planner", shape: shapes.revision,
    intro: [
      FRESH_SESSION,
      SKILL_GUIDANCE,
      `You are taking over as planner to revise a plan using ${label}. Keep sound tasks; add or change tasks and acceptance criteria where the feedback requires. Do not edit files.`,
      `Change request:\n${request}`, `Current plan:\n${formatTasks(tasks)}`, `${feedbackTitle}:\n${feedback}`,
    ].join("\n\n"),
    validate: (value) => ({ tasks: validateTasks(value.tasks, "Revised plan") }),
  };
}

export function opinionStep({ request, tasks, designNote }) {
  return {
    key: "opinion", role: "second-opinion", shape: shapes.opinion,
    intro: [
      FRESH_SESSION,
      SKILL_GUIDANCE,
      "Give an independent second opinion on this implementation plan. Do not edit files. Approve it, or ask for one revision with specific risks or missing work.",
      `Change request:\n${request}`, `Plan:\n${formatTasks(tasks)}`,
      designNote ? `Design recommendations already applied:\n${designNote}` : "",
    ].filter(Boolean).join("\n\n"),
    validate(value) {
      const result = decision(value, ["approve", "revise"], "Second opinion");
      if (result === "revise" && !isText(value.findings)) throw new Error('"findings" is required when decision is "revise".');
      return { decision: result, findings: value.findings?.trim() };
    },
  };
}

export function approvalStep({ request, original, tasks, designNote, findings }) {
  return {
    key: "approval", role: "plan-approval", interactive: true, shape: shapes.approval,
    intro: [
      "The plan changed during design or second-opinion review. You are the current harness in a multi-harness relay. Present the revised plan to the user, explain what changed and why, and discuss any changes they want. Do not edit files.",
      "Print the handoff line only after the user explicitly approves the final plan. If they ask for changes, revise the plan and ask again.",
      `Agreed change request:\n${request}`,
      `Plan before review:\n${formatTasks(original)}`,
      `Revised plan to approve:\n${formatTasks(tasks)}`,
      designNote ? `Design recommendations:\n${designNote}` : "",
      findings ? `Second-opinion findings:\n${findings}` : "",
    ].filter(Boolean).join("\n\n"),
    validate(value) {
      decision(value, ["approve"], "Plan approval");
      return { tasks: validateTasks(value.tasks, "Approved plan") };
    },
  };
}

export function implementationStep({ key, ticket, parent, index, total, task, findings, hasGit }) {
  return {
    key, role: "implementer", shape: shapes.implementation, ticketId: ticket?.id,
    intro: [
      FRESH_SESSION,
      SKILL_GUIDANCE,
      parent ? `User-facing work item: ${parent.label}. This is implementation step ${index + 1} of ${total} within that work item.` : `Implement task ${index + 1} of ${total}.`,
      "Work only on this step's acceptance criteria. It is one part of the larger requested work item; do not describe the parent work item as complete. In your summary, say this implementation step is complete and awaiting review.",
      formatTask(task, index),
      findings ? `A reviewer asked for these changes in the previous round. Address them:\n${findings}` : "",
      "Run the project's relevant tests or build if it has them, and fix what you break. Leave your changes uncommitted in the working tree" +
        (hasGit ? " (Relay snapshots the tree and shows the reviewer the diff)." : "."),
      "Do not edit .herdr-issues.json; Relay maintains it.",
      "If you cannot finish, use status \"blocked\" and explain why in the summary.",
    ].filter(Boolean).join("\n\n"),
    validate(value) {
      if (!["complete", "blocked"].includes(value.status)) throw new Error('"status" must be "complete" or "blocked".');
      if (!isText(value.summary)) throw new Error('"summary" must say what changed and which tests ran.');
      if (value.status === "blocked") throw new RelayBlocked(`The implementer is blocked: ${value.summary}`);
      return { status: "complete", summary: value.summary.trim() };
    },
  };
}

export function reviewStep({ key, ticket, parent, index, total, task, summary, diff }) {
  const diffText = !diff
    ? "Relay could not compute a diff (the project is not a git repository). Inspect the working tree."
    : [
      "Diff of everything changed for this task since it started (earlier review rounds included; other tasks excluded):",
      diff.stat ? `Summary:\n${diff.stat}` : "",
      `${diff.patch}${diff.truncated ? "\n[diff truncated; inspect the working tree for the rest]" : ""}`,
    ].filter(Boolean).join("\n\n");
  return {
    key, role: "reviewer", shape: shapes.review, ticketId: ticket?.id,
    intro: [
      FRESH_SESSION,
      SKILL_GUIDANCE,
      parent ? `Review implementation step ${index + 1} of ${total} for ${parent.label}. The parent work item is not complete until every step is approved.` : `Review task ${index + 1} of ${total}.`, formatTask(task, index),
      summary ? `The implementer reports:\n${summary}` : "",
      diffText,
      "Check correctness, the acceptance criteria and obvious regressions. You may read any file and run tests, but do not edit files. Approve only if every acceptance criterion is met.",
    ].filter(Boolean).join("\n\n"),
    validate(value) {
      const result = decision(value, ["approve", "changes"], "Review");
      if (result === "changes" && !isText(value.findings)) throw new Error('"findings" is required when decision is "changes".');
      return { decision: result, findings: value.findings?.trim() };
    },
  };
}
