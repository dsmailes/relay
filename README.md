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

Herdr opens a new **Harness Relay** tab. Enter at least two different harness kinds, separated by commas (for example, `codex,claude,opencode`). Input order does not matter: Relay uses the order in its harness list and displays the resulting rotation. Then describe the change. Relay creates a separate worker tab with one pane for each selected harness. The planner decides whether design input or a second opinion is warranted; setup does not ask you to assign roles or enable those steps.

Installing the plugin registers the action; it does not open the setup console. This version does not assign a keyboard shortcut, so use the command above to start it. To confirm the action is installed, run:

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

The plugin creates a separate worker tab in the same Herdr workspace, with one pane for each harness in the chain. It starts each harness in its own pane, without changing the user's focus. The panes use the same project checkout, and only one harness receives a workflow prompt at a time. Relay advances the chain after every prompt:

```text
[planning → optional design review → planner revision]
  → [optional second opinion → optional plan revision]
  → your plan approval → implement task → review task
  → (implement requested changes → review again) → next task → complete
```

For the selected set **Codex, Claude Code, and OpenCode**, Relay chooses the rotation **Claude Code → Codex → OpenCode** from its harness list. The first task goes like this:

1. Claude Code plans the change.
2. Codex implements the first task.
3. OpenCode reviews it.
4. If changes are requested, Claude Code implements the fixes and Codex reviews them.
5. After approval, OpenCode implements the next task; the chain keeps rotating.

Relay wraps from the last harness back to the first. Optional design and second-opinion steps also take the next position in the same rotation. You must type `yes` to approve the plan before implementation starts. Each task gets up to three implementation/review rounds. The workflow advances to the next task only after reviewer approval.

Harness Relay uses Herdr's `agent start`, `agent prompt --wait`, and `agent read` commands. It waits for Herdr to observe the harness become active and settle, then checks the harness's latest response for a fresh, per-prompt marker. The marker token is generated for that handoff; the harness is instructed to copy the exact marker into its final response line.

| Role | Required final response line |
| --- | --- |
| Planner | `RELAY_PLAN_<token>: {"needsDesignReview":false,"needsSecondOpinion":false,"tasks":[{"title":"...","acceptanceCriteria":"..."}]}` |
| Planner revising after second opinion | `RELAY_REVISED_PLAN_<token>: {"tasks":[{"title":"...","acceptanceCriteria":"..."}]}` |
| Designer | `RELAY_DESIGN_<token>: {"recommendations":"..."}` |
| Second opinion | `RELAY_OPINION_<token>: {"decision":"approve"}` or `RELAY_OPINION_<token>: {"decision":"revise","findings":"..."}` |
| Implementer | `RELAY_IMPLEMENTATION_<token>: {"status":"complete","summary":"..."}` |
| Reviewer | `RELAY_REVIEW_<token>: {"decision":"approve"}` or `RELAY_REVIEW_<token>: {"decision":"changes","findings":"..."}` |

The planner must return between 1 and 20 tasks. Each task must have a `title` and `acceptanceCriteria` string.

## Run state and recovery

The plugin stores workflow state in Herdr's plugin state directory, keyed by the resolved project path. It records the request, automatic harness rotation, current chain position, worker pane and agent names, plan, completed approvals, current stage, and latest handoff marker. The selected harnesses are stored separately in the plugin config directory.

A project lock prevents two Harness Relay controllers from running against the same checkout at once. Worker panes share the checkout, so do not start another agent workflow that may edit those files while Relay is working.

Relay saves its stage before sending every prompt. If Herdr does not confirm a handoff, a harness becomes blocked, the expected marker is missing, the plan is invalid, or the review limit is reached, the workflow stops and reports the issue. It does not automatically replay an interrupted prompt: a prompt may have reached the harness before the controller stopped. Inspect the recorded worker pane and saved state before deciding what to do.

When a new run starts for a project with an unfinished saved run, Relay shows its run ID and stage. Inspect the worker panes first. Type `new` only if you intend to abandon that saved run and start another; this does not close or clean up its worker panes. If the process was forcibly terminated and its project lock remains, confirm no Relay controller is still running before removing the stale `.lock` file from Herdr's plugin state directory.

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
