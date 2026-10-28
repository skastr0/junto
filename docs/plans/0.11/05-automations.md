# 0.11 Automations that know what fired them

Owner: product-lead. Asked by the operator 2026-10-28. Builds on
`docs/plans/0.10/07-automations.md`.

## Target

An automation reads like a sentence and can say what happened. "When a task
on Release becomes done, prompt product-verify: `{{task.title}}` is done,
check it." The trigger form says plainly what it watches, offers the task
and Artifacts nodes in reach to pick from, and every text an action writes
can name the thing that fired it.

## What is wrong today (receipts)

- **"This task" offers nothing.** The scope select offers "This task" then
  "Any task on <board>" (`AutomationEditor.tsx:197`). "This task" shows a
  task picker fed by `useAutomationTargets` (`:430`), which passes no items,
  and a task node offers no candidates without them
  (`mention-sources.ts:11`, `:76`). So the picker is always empty.
- **An artifact watch takes one artifact only**; there is no "any artifact
  in this Artifacts node" (`src/shared/automation.ts:147`).
- **An action never sees what fired it.** `ChangeEvent` carries the task,
  artifact, seat or signal (`src/main/junto/automation/plan.ts:146`), but
  `perform` is called without it (`runner.ts:122`) and actions write their
  stored text as typed (`live.ts:298`, `:313`, `:334`).
- **Action text is one line** (`AutomationEditor.tsx:330`, `:389`), too
  small for a prompt.
- **Mail lands as a notice**; nothing asks the seat to act on it.

## Decisions (product-lead)

- **The form is a sentence.** "When [a task / an artifact / a seat / a
  signal] in [node or one item] [becomes / is] [state]". The scope lists
  the task and Artifacts nodes in the automation's reach by name, then
  "one task" or "one artifact" with a picker that does list them. The
  words "This task" go.
- **Values, written `{{name}}`.** A text an action writes (mail, prompt,
  comment, a new task's title) may name values of the trigger. The set is
  closed and depends on the trigger: `task.title`, `task.state`,
  `task.link` (a mention a seat can open), `task.assignee`, `board.title`;
  `artifact.title`, `artifact.link`, `artifacts.title`; `seat.name`,
  `seat.state`; `signal.kind`, `signal.from`, `signal.text`;
  `fired.at` everywhere. Main resolves them at firing time from the rulings
  it already holds, never in the renderer. A name the trigger does not
  carry is refused when the automation is saved, with the names it does
  carry. Values are inserted as text: never run, never parsed again (a
  title holding `{{x}}` stays `{{x}}`).
- **The editor offers the values.** An "Insert value" control beside each
  text lists the values for the chosen trigger; text fields for mail,
  prompts and comments are multi-line.
- **A prompt action.** `{kind: "prompt", to: seat, text}` sends mail as a
  prompt, as `junto msg send --prompt` does: the seat is asked to act, not
  only told. Mail stays for notices.
- **Loop safety stays**: a write by an automation never fires one
  (`plan.ts:172`).

## Tracks

| Track | Owner | Reviewer |
|---|---|---|
| A1 the trigger form as a sentence; node scope for tasks and artifacts; the item pickers fed | product-automations | product-modals, product-accessibility, product-typography |
| A2 contract and runtime: `{node}` artifact watch, values resolved at firing, the `prompt` action, save-time refusal | automation-lead | product-feed, cli-lead |
| A3 the editor's action side: multi-line text, Insert value, the prompt action, schedule and poll fields read plainly | product-cron | product-automations, product-accessibility |
| A4 CLI: values and `prompt` in `junto automation` | cli-lead | cli-protocol |
| Verify: "task done prompts a seat with its title" end to end, dark and bright | product-verify | |

A1 and A3 build on a stand-in of A2's names and switch when it lands. The
empty picker is a bug: A1 fixes it first, on its own commit.

## Automations run on their own machine (operator, 2026-10-28)

**Decided by the operator; this overrides the editing-machine runner of
0.10/07 and wherever `docs/machines.md` says only the editor runs
automations.** One canvas spans any number of machines, and each machine
runs its own automations: a hundred machines on one canvas, each with its
own, must work. The unit is the automation, not the canvas. Most of the
operator's automations run 24/7 on the Mac mini, a VPS or another always-on
machine, beside seats on that machine that work around the clock.

- **An automation names its machine**, the way a seat does (Rule 3); the
  Automations node offers a default machine for new ones. That machine fires
  its schedules, hears its changes, performs its actions and runs its code
  steps, whether or not the editing machine is awake.
- **It acts like a seat on its machine.** Mail and prompts go out from its
  machine; a resource write is proposed from its machine and ruled as a
  seat's is.
- **An action aimed at a machine that is offline waits**, is shown waiting
  in the firing log, and goes when the machine is back. Mail and prompts do
  this already (Rule 6); seat start and stop join them.
- **Remote designs the mechanics** and owns the doctrine change: how a
  definition reaches its machine, which rows an automation may write and
  from where, and how a machine whose automations need task changes keeps
  working while the editing machine is asleep.

## Code steps (operator, 2026-10-28)

- **One step kind, `code`.** TypeScript first, with a small Junto SDK; a
  very basic shell second. No Prism integration yet: its workflow steps are
  agent runs, which is not what this is.
- **The code lives in Junto's store**, as content the automation refers to,
  not as a file on disk. It reaches the automation's machine as content does.
- **It runs on the automation's machine**, wherever that is.
- **Edited in the Automations node**: the operator browses and edits an
  automation's code in its modal with the code editor Files already uses
  (CodeMirror, F3).
- **Authors: the operator, and seats with overseer.** Overseer seats create
  automations and write their code from the CLI. Ordinary seats do not.
- **Input and result.** The code gets the trigger and its values as
  structured input (JSON on stdin and through the SDK), never pasted into a
  command line. It answers continue with an output (whose fields become
  values for the next steps), stop, or fail; with no SDK call, the exit
  code decides. A timeout and an output size bound; the loop rule holds.
- **Secrets** come from the region's environment on that machine, and never
  reach a log.

Remote's earlier conditions (i) "only the operator authors" and (ii) "a path
on the machine, never bytes that crossed" are replaced by the two decisions
above; remote designs how code authored elsewhere is trusted on the machine
that runs it.

| Track | Owner | Reviewer |
|---|---|---|
| K1 contract and runner: the `code` step, its content, input, result, values out, limits | automation-lead | tech-lead, product-feed |
| K2 running code on a machine: TypeScript and shell processes, the SDK package, timeouts and bounds, secrets, logs scrubbed | tech-lead | automation-lead, remote-lead |
| K3 the code editor in the Automations node | product-cron | product-automations, product-accessibility, product-typography |
| K4 CLI: overseer seats create automations and write their code | cli-lead | cli-protocol |
| K5 doctrine: code authored on one machine, run on another; overseer authorship | remote-lead | tech-lead |
| Verify: a code step on the mini, triggered from the MacBook's canvas | product-verify | |

Prism (`../prism`, read 2026-10-28): every workflow task is an agent run
(`src/workflows.ts:592`); `prism workflow run` prints JSON and exits non-zero
on a failed task, and has no input flag (`src/cli.ts:829`).
