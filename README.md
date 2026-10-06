# Herdr Harness Relay

Harness Relay is a Herdr plugin for a sequential cross-harness workflow. A planning harness proposes ordered tasks; you approve the plan; each task then passes through implementation and review. Review findings go back to the implementer, and the workflow advances only after explicit reviewer approval.

## Install and start

Install from this repository once it is published:

```sh
herdr plugin install <owner>/<repo>
```

From a Herdr workspace, invoke **Start Harness Relay**. On first use, the interactive tab asks which harnesses to assign to planning, implementation, and review, plus whether to add design or second-opinion slots. It saves those role assignments in the plugin config directory; later runs reuse them unless you choose to change them. It then asks for the change request, creates one worker pane per selected role in a separate tab, and does not steal focus.

The selected harnesses must be supported by the installed Herdr version and available on the machine. Startup errors are shown in the relay pane. Harness kinds currently offered: Claude Code, Codex, OpenCode, GitHub Copilot CLI, Pi, Gemini CLI, Cursor Agent, Amp, Droid, Kimi Code, Kiro CLI, Cline, Devin CLI, Antigravity CLI, Hermes Agent, Kilo Code CLI, Qoder CLI, Qwen Code, MastraCode, Grok CLI, OMP, Maki, Letta Code, and Muse.

## Handoff contract

The plugin uses Herdr's `agent start`, `agent prompt --wait`, and `agent read` commands. Each harness must end its response with a machine-readable marker:

- Planner: `RELAY_PLAN_<token>: {"tasks":[{"title":"...","acceptanceCriteria":"..."}]}`
- Implementer: `RELAY_IMPLEMENTATION_<token>: {"status":"complete","summary":"..."}`
- Reviewer: `RELAY_REVIEW_<token>: {"decision":"approve"}` or `RELAY_REVIEW_<token>: {"decision":"changes","findings":"..."}`

The controller persists its stage before sending each prompt, waits for Herdr's lifecycle signal, then requires the expected response marker. Missing markers, blocked agents, malformed plans, and review limits pause the run instead of advancing it. State is written under Herdr's plugin state directory, keyed by project path. Because a process can stop after delivering a prompt but before recording its result, the first version does not automatically replay an in-flight prompt: inspect the worker pane before retrying.

## Scope and limitations

- Plan approval is interactive. Implementation and review are sequential, and each task gets at most three review rounds.
- The design and second-opinion slots are optional. Design runs before planning and informs the task breakdown; second opinion checks the plan and can request one planner revision.
- Worker panes share the selected project checkout. Do not run concurrent relay jobs against the same checkout.
- The workflow requires all chosen harnesses to be recognized by Herdr. Unknown harnesses need a Herdr agent adapter before lifecycle-based handoff can be trusted.
- Herdr plugin commands run as the current user and are not sandboxed. Review the source before installing.
