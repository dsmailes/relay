// A stand-in for the herdr CLI. Agents answer every prompt by finding the handoff
// line in it and replying with a canned, decorated answer. State lives in
// $FAKE_HERDR_DIR/state.json so separate invocations share it.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = process.env.FAKE_HERDR_DIR;
const file = path.join(dir, "state.json");
const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { tabs: 0, agents: {}, reviews: {}, plans: 0 });
const save = (s) => writeFileSync(file, JSON.stringify(s));
const log = (entry) => appendFileSync(path.join(dir, "calls.jsonl"), `${JSON.stringify(entry)}\n`);
const [cmd, sub, ...rest] = process.argv.slice(2);
const s = load();
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const fail = (code, message) => { process.stdout.write(JSON.stringify({ error: { code, message } })); process.exit(1); };
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };

const tasks = [{ title: "Add greeting", acceptanceCriteria: "greeting.txt exists" }, { title: "Add farewell", acceptanceCriteria: "farewell.txt exists" }];

function answer(name, marker, prompt) {
  const kind = marker.match(/^RELAY_([A-Z_]+)_[0-9a-f]{8}:$/)[1];
  const agent = s.agents[name];
  switch (kind) {
    case "PLAN":
      s.plans += 1;
      if (process.env.FAKE_BAD_PLAN && s.plans === 1) return { title: "T", request: "r", approvedByUser: false, needsDesignReview: false, needsSecondOpinion: false, tasks };
      return { title: "Greetings", request: "Add greeting and farewell files.", approvedByUser: true,
        needsDesignReview: Boolean(process.env.FAKE_DESIGN), needsSecondOpinion: false, tasks };
    case "DESIGN": return { recommendations: "keep it simple" };
    case "REVISED_PLAN": return { tasks: [...tasks, { title: "Add docs", acceptanceCriteria: "README mentions both" }] };
    case "APPROVAL": return { decision: "approve", tasks: [...tasks, { title: "Add docs", acceptanceCriteria: "README mentions both" }] };
    case "IMPLEMENTATION": {
      const n = (prompt.match(/task (\d+) of/) || [])[1];
      const target = ["greeting.txt", "farewell.txt", "README.md"][Number(n) - 1] || "extra.txt";
      appendFileSync(path.join(process.env.FAKE_CWD, target), `written by ${agent.kind}\n`);
      return { status: "complete", summary: `wrote ${target}; ran tests` };
    }
    case "REVIEW": {
      const n = (prompt.match(/task (\d+) of/) || [])[1];
      s.reviews[n] = (s.reviews[n] || 0) + 1;
      if (process.env.FAKE_REVIEW_CHANGES && n === "1" && s.reviews[n] === 1) return { decision: "changes", findings: "add a trailing newline" };
      if (!prompt.includes("written by")) return { decision: "changes", findings: "diff missing from the prompt" };
      return { decision: "approve" };
    }
  }
  throw new Error(`unknown marker ${marker}`);
}

if (cmd === "workspace") print({ result: { workspace: { cwd: process.env.FAKE_CWD } } });
else if (cmd === "tab" && sub === "create") { s.tabs += 1; save(s); print({ result: { tab: { tab_id: `t${s.tabs}` }, root_pane: { pane_id: `p${s.tabs}` } } }); }
else if (cmd === "tab" && sub === "close") { log({ closed: rest[0] }); }
else if (cmd === "notification") log({ notification: rest[0] });
else if (cmd === "agent" && sub === "start") {
  s.agents[rest[0]] = { kind: flag("--kind"), seq: 1, output: [], status: "idle", hold: null };
  save(s); log({ start: rest[0], kind: flag("--kind") });
} else if (cmd === "agent" && sub === "prompt") {
  const [name, text] = rest;
  const agent = s.agents[name];
  if (!agent) fail("agent_not_found", name);
  log({ prompt: name, kind: agent.kind, text });
  agent.output.push(...text.split("\n").map((line) => `❯ ${line}`));
  const match = text.match(/(RELAY_[A-Z_]+_[0-9a-f]{8}:) \{/);
  agent.seq += 2;
  if (match) {
    const value = answer(name, match[1], text);
    const style = Number(match[1].slice(-9, -1).charCodeAt(0)) % 3;
    const json = JSON.stringify(value);
    const reply = [`⏺ Done thinking about it.`, "", style === 0 ? `⏺ ${match[1]} ${json}` : style === 1 ? `│ ${match[1]} ${json} │` : `${match[1]} ${json}`, "✻ Worked for 3s", "❯ "];
    if (process.env.FAKE_HOLD && existsSync(process.env.FAKE_HOLD) && /REVIEW/.test(match[1])) agent.hold = reply;
    else agent.output.push(...reply);
  }
  save(s);
} else if (cmd === "agent" && sub === "read") {
  const agent = s.agents[rest[0]];
  if (agent?.hold && !existsSync(process.env.FAKE_HOLD)) { agent.output.push(...agent.hold); agent.hold = null; save(s); }
  process.stdout.write(agent ? agent.output.slice(-200).join("\n") : "");
} else if (cmd === "agent" && sub === "get") {
  const agent = s.agents[rest[0]];
  if (!agent) fail("agent_not_found", rest[0]);
  print({ result: { agent: { agent: agent.kind, agent_status: agent.status, state_change_seq: agent.seq } } });
} else { log({ unknown: process.argv.slice(2) }); }
