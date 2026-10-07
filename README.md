# Herdr Harness Relay

Harness Relay coordinates a coding change across multiple coding harnesses inside Herdr. It turns a request into an ordered plan, then sends each task through implementation and review. A task advances only when its reviewer explicitly approves it.

## Requirements

- Herdr `0.7.3` or newer.
- Node.js `20` or newer.
- At least one supported harness installed and authenticated for each role you assign.
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

Open a Herdr workspace for the target project and invoke **Start Harness Relay** from that workspace's plugin actions. You can also invoke the action from a Herdr-managed terminal in that workspace:

```sh
herdr plugin action invoke community.harness-relay.open-relay
```

Installing the plugin registers its Herdr action; it does not open the setup console. The first time you invoke **Start Harness Relay**, the console asks you to choose harnesses for the required roles:

1. **Planner** breaks the request into small tasks with acceptance criteria. It must not edit files.
2. **Implementer** implements the current task.
3. **Reviewer** checks the diff against that task's acceptance criteria. It must not edit files.

You can also enable:

- **Designer**, which provides design guidance before planning and must not edit files.
- **Second opinion**, which reviews the proposed plan. It can approve the plan or ask the planner for one revision.

Role assignments and optional slots are saved in Herdr's plugin config directory for your user. Later runs show the saved assignments; choose whether to keep or change them. The console then asks for the change request.

Harness kinds offered by the current setup are: Claude Code (`claude`), Codex (`codex`), OpenCode (`opencode`), GitHub Copilot CLI (`copilot`), Pi (`pi`), Gemini CLI (`gemini`), Cursor Agent (`cursor`), Amp (`amp`), Droid (`droid`), Kimi Code (`kimi`), Kiro CLI (`kiro`), Cline (`cline`), Devin CLI (`devin`), Antigravity CLI (`agy`), Hermes Agent (`hermes`), Kilo Code CLI (`kilo`), Qoder CLI (`qodercli`), Qwen Code (`qwen`), MastraCode (`mastracode`), Grok CLI (`grok`), OMP (`omp`), Maki (`maki`), Letta Code (`letta`), and Muse (`muse`). The installed Herdr version must recognize the selected kind, and its executable must be available on the machine.

## What happens during handoff

The plugin creates a separate worker tab in the same Herdr workspace, with one pane for each selected role. It starts the configured harness in each pane, without changing the user's focus. The panes use the same project checkout, and the workflow runs one role at a time:

```text
optional design → planning → optional second opinion → plan approval
  → implement task → review task → (fix findings → review again)
  → next task → complete
```

You must type `yes` to approve the plan before implementation starts. Each task gets up to three implementation/review rounds. If the reviewer asks for changes, those findings are sent to the implementer before the next review. The workflow advances only after reviewer approval.

Harness Relay uses Herdr's `agent start`, `agent prompt --wait`, and `agent read` commands. It waits for Herdr to observe the harness become active and settle, then checks the harness's latest response for a fresh, per-prompt marker. The marker token is generated for that handoff; the harness is instructed to copy the exact marker into its final response line.

| Role | Required final response line |
| --- | --- |
| Planner | `RELAY_PLAN_<token>: {"tasks":[{"title":"...","acceptanceCriteria":"..."}]}` |
| Planner revising after second opinion | `RELAY_REVISED_PLAN_<token>: {"tasks":[{"title":"...","acceptanceCriteria":"..."}]}` |
| Designer | `RELAY_DESIGN_<token>: {"recommendations":"..."}` |
| Second opinion | `RELAY_OPINION_<token>: {"decision":"approve"}` or `RELAY_OPINION_<token>: {"decision":"revise","findings":"..."}` |
| Implementer | `RELAY_IMPLEMENTATION_<token>: {"status":"complete","summary":"..."}` |
| Reviewer | `RELAY_REVIEW_<token>: {"decision":"approve"}` or `RELAY_REVIEW_<token>: {"decision":"changes","findings":"..."}` |

The planner must return between 1 and 20 tasks. Each task must have a `title` and `acceptanceCriteria` string.

## Run state and recovery

The plugin stores workflow state in Herdr's plugin state directory, keyed by the resolved project path. It records the request, role assignments, worker pane and agent names, plan, completed approvals, current stage, and latest handoff marker. Harness role preferences are stored separately in the plugin config directory.

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
