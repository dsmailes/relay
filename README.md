# Herdr Harness Relay

Harness Relay coordinates a coding change across multiple coding harnesses inside Herdr. You select which harnesses you use; Relay decides their rotation order. At every handoff, the next harness takes the next role, like passing a parcel. Roles belong to workflow steps; they are not permanently assigned to particular harnesses.

## Requirements

- Herdr `0.7.3` or newer.
- Node.js `20` or newer.
- At least two supported harnesses selected, installed, and authenticated.
- A Herdr workspace open at the project you want to change.

Harness Relay uses Herdr's plugin, workspace, pane, and agent CLI commands. It does not install coding harnesses or authenticate them for you.

## Install

Install the plugin from GitHub:

```sh
herdr plugin install dsmailes/relay
```

To work on a local checkout, link it instead:

```sh
herdr plugin link /absolute/path/to/relay
```

In an interactive terminal, Herdr's plugin installer previews the plugin source and commands before registration. Harness Relay has no build step or npm dependencies. Its commands run as your user and are not sandboxed; review the source before installing it.

To refresh a GitHub-installed copy, install the same source again. To remove it:

```sh
herdr plugin install dsmailes/relay
herdr plugin uninstall community.harness-relay
```

## Start a workflow

To launch a run:

1. Open Herdr and select the workspace for the project you want to change.
2. Open a terminal pane in that workspace.
3. Run this command in the pane:

```sh
herdr plugin action invoke community.harness-relay.open-relay
```

Herdr opens a small **Harness Relay coordinator** tab. Enter at least two different harness kinds, separated by commas (for example, `codex,claude,opencode`). Input order does not matter: Relay uses the order in its harness list and displays the resulting rotation. Relay remembers that selection for later changes and future sessions.

After setup, Relay opens the first harness in the focused worker tab. Start the change by talking to that harness; clarify and approve the plan in its pane. Relay watches for the approved plan handoff and then coordinates the remaining harnesses in rotation. Only the active harness pane stays open as the baton moves. When all tasks are reviewed and complete, Relay returns to the first harness for the next change.

The coordinator runs in the background while you interact with the focused harness pane. Relay records the approved plan and each implementation task as issues in the project's `.herdr-issues.json` file, which the Livestock plugin displays. Relay also saves workflow state separately so it can track handoffs and recover an interrupted intake. Livestock is optional; without it, Relay still runs and the JSON issue file remains available as project-local context. The planner decides whether design input or a second opinion is warranted; setup does not ask you to assign roles or enable those steps.

Installing the plugin registers the action; it does not open the coordinator. This version does not assign a keyboard shortcut, so use the command above to start it. To confirm the action is installed, run:

```sh
herdr plugin action list --plugin community.harness-relay
```

The required workflow steps are:

1. **Planner** breaks the request into small tasks with acceptance criteria. It must not edit files.
2. **Implementer** implements the current task.
3. **Reviewer** checks the diff against that task's acceptance criteria. It must not edit files.

The planner also decides whether the proposed change needs a design review or independent second opinion. When needed, Relay gives that role to the next harness in the rotation. The designer reviews the proposed plan and the planner then revises it; the second opinion can approve the plan or ask for one revision. These decisions happen automatically, with no extra role setup.

The harness selection is saved in Herdr's plugin config directory for your user. Later runs show the saved selection and automatic rotation; keep it or select a different set.

Harness kinds offered by the current setup are: Claude Code (`claude`), Codex (`codex`), OpenCode (`opencode`), GitHub Copilot CLI (`copilot`), Pi (`pi`), Gemini CLI (`gemini`), Cursor Agent (`cursor`), Amp (`amp`), Droid (`droid`), Kimi Code (`kimi`), Kiro CLI (`kiro`), Cline (`cline`), Devin CLI (`devin`), Antigravity CLI (`agy`), Hermes Agent (`hermes`), Kilo Code CLI (`kilo`), Qoder CLI (`qodercli`), Qwen Code (`qwen`), MastraCode (`mastracode`), Grok CLI (`grok`), OMP (`omp`), Maki (`maki`), Letta Code (`letta`), and Muse (`muse`). The installed Herdr version must recognize the selected kind, and its executable must be available on the machine.

## What happens during handoff

Relay starts the first harness in a focused worker tab and leaves its coordinator running in the background. On each handoff, it opens the next harness in a new worker tab, then closes the previous worker tab after startup succeeds. The active harness has the same project checkout; only one worker pane is kept open at a time. Relay advances the chain after every prompt:

```text
[first-harness discussion and plan]
  → [optional design review → planner revision]
  → [optional second opinion → optional plan revision]
  → [user approval when the plan changed] → implement ticket → review ticket
  → (implement requested changes → review again) → next task → complete
```

For the selected set **Codex, Claude Code, and OpenCode**, Relay chooses the rotation **Claude Code → Codex → OpenCode** from its harness list. The first change goes like this:

1. The user discusses the change and approves its plan with Claude Code.
2. Codex implements the first Livestock task ticket.
3. OpenCode reviews it.
4. If changes are requested, Claude Code implements the fixes and Codex reviews them.
5. After approval, OpenCode implements the next task ticket; the chain keeps rotating.

Relay wraps from the last harness back to the first. Optional design and second-opinion steps also take the next position in the same rotation. If those steps change the plan, the active harness presents the updated plan to the user for approval before implementation starts. Each task gets up to three implementation/review rounds. The workflow advances to the next task only after reviewer approval.

Harness Relay uses Herdr's `agent start`, `agent prompt`, `agent read`, and `agent get` commands. For automated handoffs, it waits for Herdr to observe the harness become active and settle, then checks the response for a fresh, per-prompt marker. During user intake, it monitors the first harness's output for the approved-plan marker. The marker token is generated for that handoff; the harness is instructed to copy the exact marker into its final response line.

| Role | Required final response line |
| --- | --- |
| First harness plan | `RELAY_PLAN_<token>: {"request":"...","needsDesignReview":false,"needsSecondOpinion":false,"tasks":[{"title":"...","acceptanceCriteria":"..."}]}` |
| User approval after plan revision | `RELAY_APPROVAL_<token>: {"decision":"approve","tasks":[{"title":"...","acceptanceCriteria":"..."}]}` |
| Planner revising after second opinion | `RELAY_REVISED_PLAN_<token>: {"tasks":[{"title":"...","acceptanceCriteria":"..."}]}` |
| Designer | `RELAY_DESIGN_<token>: {"recommendations":"..."}` |
| Second opinion | `RELAY_OPINION_<token>: {"decision":"approve"}` or `RELAY_OPINION_<token>: {"decision":"revise","findings":"..."}` |
| Implementer | `RELAY_IMPLEMENTATION_<token>: {"status":"complete","summary":"..."}` |
| Reviewer | `RELAY_REVIEW_<token>: {"decision":"approve"}` or `RELAY_REVIEW_<token>: {"decision":"changes","findings":"..."}` |

The planner must return between 1 and 20 tasks. Each task must have a `title` and `acceptanceCriteria` string.

## Run state and recovery

The plugin stores workflow state in Herdr's plugin state directory, keyed by the resolved project path. It records the request, automatic harness rotation, current chain position, active worker tab and agent, plan, Livestock ticket IDs, completed approvals, current stage, and latest handoff marker. The selected harnesses are stored separately in the plugin config directory.

A project lock prevents two Harness Relay controllers from running against the same checkout at once. Worker panes share the checkout, so do not start another agent workflow that may edit those files while Relay is working.

Relay saves its stage before sending every prompt. During intake, the coordinator monitors the first harness pane until it returns the approved-plan marker. If Herdr does not confirm a handoff, a harness becomes blocked, the expected marker is missing, the plan is invalid, or the review limit is reached, the workflow stops and reports the issue. Other interrupted prompts are not automatically replayed because they may already have reached the harness. Inspect the active worker pane and saved state before deciding what to do.

If the coordinator stops while waiting for the first harness's approved plan, starting Relay again resumes that intake without resending its prompt. For other unfinished stages, Relay shows the run ID and stage; inspect the active worker pane before deciding whether to abandon it. Moving the baton closes the previous harness tab after the next harness starts, so only one worker pane remains active. If the process was forcibly terminated and its project lock remains, confirm no Relay controller is still running before removing the stale `.lock` file from Herdr's plugin state directory.

## Troubleshooting

### The action is missing

Check that Herdr registered the plugin and action:

```sh
herdr plugin list
herdr plugin action list --plugin community.harness-relay
```

If it is not installed, run the install command above. For a linked development checkout, run `herdr plugin link /absolute/path/to/relay`.

### A harness does not start

Check that the harness is installed and authenticated in a regular terminal. Also confirm that the selected kind is supported by your Herdr version. Relay stops if Herdr cannot start the harness in its worker pane.

### A handoff pauses or has no marker

Inspect the role's worker pane and agent output. The harness must finish its current response with the exact marker shown in the prompt. Herdr's `blocked` state means the harness is waiting for a permission decision or answer; Relay does not approve those prompts on your behalf.

### Relay cannot resolve the project directory

Invoke the action from the intended Herdr workspace. Relay needs a workspace context so it can create worker panes in the correct project.

## Development

This is a dependency-free Node.js plugin. Herdr loads `herdr-plugin.toml`; the action opener is in `src/open-relay.mjs`, the workflow controller is in `src/relay-console.mjs`, and Herdr CLI helpers are in `src/herdr.mjs`.

To link a local checkout during development:

```sh
herdr plugin link /absolute/path/to/relay
herdr plugin action list --plugin community.harness-relay
```

The implementation currently has no automated test suite.
