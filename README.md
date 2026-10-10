# Herdr Harness Relay

Harness Relay passes a coding change between several coding harnesses inside Herdr, like a baton. You describe the change to the first harness and approve its plan. Relay then has the next harness implement each task, the one after review it, and keeps rotating. Roles belong to workflow steps, not to particular harnesses.

## Quick start

You need Herdr `0.7.3` or newer, Node.js `20` or newer, and at least two supported harnesses (Claude Code, Codex, OpenCode and so on) that are installed and signed in.

```sh
herdr plugin install dsmailes/relay
```

Then, in a Herdr workspace opened at your project, run this in any terminal pane:

```sh
herdr plugin action invoke community.harness-relay.open-relay
```

A **Harness Relay** tab opens. On first run Relay lists the harnesses it found on your `PATH` and suggests a rotation. Press **Enter** to accept it (or type the kinds or numbers you want). Relay then opens the first harness in a focused tab. Talk to it, agree a plan, and approve it. That is the whole setup.

Next time, the only prompt is "Press Enter to start".

### Optional: a keyboard shortcut

Plugins cannot register their own keys, but you can bind one in Herdr's `config.toml`:

```toml
[[keys.command]]
key = "prefix+r"
type = "plugin_action"
command = "community.harness-relay.open-relay"
description = "Harness Relay"
```

## What happens

```text
you + first harness: discuss and approve the plan
  → [optional design review → planner revision]
  → [optional second opinion → optional plan revision]
  → [your approval, only if the plan changed]
  → for each task: implement → review → (changes requested → implement → review, up to 3 rounds)
  → next task → … → complete
```

Each handoff moves to the **next harness in the rotation**. With Claude Code, Codex and OpenCode selected, Claude Code plans, Codex implements task 1, OpenCode reviews it, Claude Code implements the next task or the fixes, and so on. After the last task the baton returns to the first harness for your next change.

Things Relay does for you:

- **Briefs each harness.** Every step starts a fresh harness session, so Relay passes everything it needs: the agreed brief, the task, the Livestock ticket history, and for reviewers the exact diff.
- **Shows reviewers only the task's diff.** Relay snapshots the working tree before and after each task (without touching your index, branch or HEAD) and gives the reviewer that diff. Your own uncommitted work and earlier tasks are excluded. The full diffs are kept in the plugin state directory.
- **Keeps checkpoints.** After each approved task Relay saves a commit under `refs/relay/<run>/task-N`. Your branch is never moved, and you can diff or restore from these at any time. Changes stay uncommitted in your working tree until you commit them.
- **Corrects bad handoffs.** If a harness answers in the wrong shape (or prints the plan handoff before you approved), Relay tells it what was wrong and asks again, up to three times.
- **Never gives up on a permission prompt.** If a harness is blocked on a permission or question, Relay notifies you and waits. If one stops without its handoff line, Relay reminds it once, and resends a prompt that never registered.
- **Keeps `.herdr-issues.json` out of your way.** The board is added to your local `.git/info/exclude`, so it does not show up in `git status` or in reviewers' diffs.

Only the active harness tab stays open; the previous one closes once the next harness has started.

## Progress, recovery and history

Relay records progress in three places, all written as it goes:

| Where | What | Use it for |
| --- | --- | --- |
| The coordinator tab | A live checklist: plan, each task (`✓` done, `▸` current, `·` waiting) and who Relay is waiting on | Seeing where you are |
| Livestock tickets (`.herdr-issues.json`) | A parent ticket and one per task, with status, every baton pass, implementation summaries and review findings, and a final timeline | Project-visible history |
| Plugin state directory (on macOS and Linux: `~/.config/herdr/plugins/state/community.harness-relay/`) | `<key>.json` current run; `<key>.events.jsonl` append-only log of every step, rejection, pause and error across all runs; `runs/<run>.json` final snapshot of each finished or abandoned run; `diffs/*.patch` what each reviewer saw. `<key>` is a short hash of the project path | Auditing and debugging |

**Resuming.** Every step's result is stored, so any interruption is recoverable: closing the tab, a crash, a pause. Start Relay again and press Enter to resume. Relay re-reads the waiting harness's pane instead of resending its prompt, and skips everything already finished. If the harness pane itself is gone, Relay starts a fresh one and resends.

When something needs you, the coordinator shows a menu: **Enter** keeps waiting, `resend` sends the prompt again with a fresh marker, `stop` exits and keeps the state. After three rejected reviews of one task you can allow `more` rounds, `accept` the work as it is, or `stop`.

A project lock prevents two Relay coordinators on the same checkout. If a crash left a stale lock, Relay detects the dead process and clears it itself.

## Handoff lines

Harnesses finish each step with one line. The marker token is generated per prompt.

| Step | Line |
| --- | --- |
| Plan (first harness) | `RELAY_PLAN_<token>: {"title":…,"request":…,"approvedByUser":true,"needsDesignReview":…,"needsSecondOpinion":…,"tasks":[…]}` |
| Plan approval after revision | `RELAY_APPROVAL_<token>: {"decision":"approve","tasks":[…]}` |
| Revised plan | `RELAY_REVISED_PLAN_<token>: {"tasks":[…]}` |
| Design review | `RELAY_DESIGN_<token>: {"recommendations":…}` |
| Second opinion | `RELAY_OPINION_<token>: {"decision":"approve"}` or `{"decision":"revise","findings":…}` |
| Implementation | `RELAY_IMPLEMENTATION_<token>: {"status":"complete"\|"blocked","summary":…}` |
| Review | `RELAY_REVIEW_<token>: {"decision":"approve"}` or `{"decision":"changes","findings":…}` |

Relay tolerates terminal decoration (bullets, borders, backticks, wrapped lines). Prompt templates are deliberately not valid JSON, so an echoed prompt can never be read as an answer. A plan needs 1 to 20 tasks, each with `title` and `acceptanceCriteria`.

Because every harness starts fresh, the first harness is told to write `request` as a self-contained brief (goal, constraints, decisions, non-goals). The better that brief, the better later steps do.

## Supported harnesses

Claude Code (`claude`), Codex (`codex`), OpenCode (`opencode`), GitHub Copilot CLI (`copilot`), Pi (`pi`), Gemini CLI (`gemini`), Cursor Agent (`cursor`), Amp (`amp`), Droid (`droid`), Kimi Code (`kimi`), Kiro CLI (`kiro`), Cline (`cline`), Devin CLI (`devin`), Antigravity CLI (`agy`), Hermes Agent (`hermes`), Kilo Code CLI (`kilo`), Qoder CLI (`qodercli`), Qwen Code (`qwen`), MastraCode (`mastracode`), Grok CLI (`grok`), OMP (`omp`), Maki (`maki`), Letta Code (`letta`) and Muse (`muse`). Herdr must recognise the kind and the executable must be installed. Rotation follows this list's order.

Relay does not install or sign in harnesses. To change your selection later, type `change` at the start prompt.

## Troubleshooting

**The action is missing.** Run `herdr plugin list` and `herdr plugin action list --plugin community.harness-relay`. If it is absent, install again (`herdr plugin link /path/to/relay` for a local checkout).

**A harness does not start.** Check it runs in a normal terminal and is signed in. Relay waits up to three minutes for it to become ready (first-run dialogs can be slow), then offers the pause menu.

**A step seems stuck.** Look at the focused worker tab. If the harness is waiting on a permission or a question, answer it there; Relay continues. Otherwise use the menu options above.

**"Relay cannot resolve the project directory."** Invoke the action from the workspace you want to change.

## Development

Dependency-free Node.js. Layout:

- `src/relay-console.mjs`: the coordinator (step runner, pause menu, task loop).
- `src/steps.mjs`: prompts and answer validation for every step.
- `src/markers.mjs`: handoff-line parser.
- `src/gitdiff.mjs`: non-invasive snapshots, diffs and checkpoints.
- `src/board.mjs`: locked Livestock board updates.
- `src/store.mjs`: state, event log, run history, project lock.
- `src/harnesses.mjs`: harness list and PATH detection.
- `src/herdr.mjs`: Herdr CLI helpers.

```sh
npm test
```

The suite includes an end-to-end test that drives the real coordinator against a fake `herdr` binary (`test/fake-herdr.mjs`), including a kill and resume mid-review. It does not exercise real harnesses.
