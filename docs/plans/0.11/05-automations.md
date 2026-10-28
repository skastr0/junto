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
  the task and Artifacts nodes in the automation's reach by name ("in
  Release"), then "named" with a picker that does list them ("When a task
  named #42 becomes done"). The
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

## Next: artifacts in automations (B1)

From the uses worked through with the operator: an artifact labelled
`publish` is edited, run the deploy; a weekly digest is written into an
artifact; a run's result is logged where people read it. Labels landed in
`03-artifact-labels.md`, so automations can use them.

- **Triggers:** an artifact in a node gains a label, or one carrying a
  label is edited ("When an artifact labelled publish in Specs is edited").
- **Actions:** create an artifact in a node (title and body may name
  values), append to an artifact (a document gets a dated section, the
  write names its base version as every edit does), set or remove labels on
  the artifact that fired.
- **Values:** `artifact.labels`, and `artifact.body` for code steps only
  (as structured input, never pasted into text).

**N2 contract (automation-lead, plan 0.11/07).** The action
`signal {signal: "notice"|"work", title, detail?, show?}` raises a signal in
the needs-you feed as the automation. Title (up to 280) and detail (up to
8000) may name values; `show` names one to eight artifacts it opens, refused
at save if any is not an artifact. The reply form follows N1's names. Until
N1's raise lands the action is refused `not_available`.

**B1 contract (automation-lead, agreed with product-automations and cli-lead).**
The artifact watch takes `event: "labelled"` and `label?`: with `labelled`,
the label gained (one under it counts, and an artifact created carrying it
has gained it); otherwise only an artifact carrying it. The actions are
`create-artifact {node, title, body?, labels?}` (a document),
`append-artifact {to, text}` (text at the end of a document as written,
against the head it read; a newer head is read again at most twice) and
`label-artifact {to, add?, remove?}` (the whole set written; a label in both
is refused at save). `to` is an artifact or `{fired: true}`, which only an
artifact trigger carries. `artifact.labels` is a value; a code step's input
gains `artifact {artifactId, nodeId, title, version, labels, body}`. An
artifact whose last ruling was an automation's fires nothing
(`artifact-writers.ts`). The writes are ruled where the canvas is ruled and
are not available elsewhere until artifact commands queue.

| Track | Owner | Reviewer |
|---|---|---|
| B1 contract and runtime | automation-lead | product-feed |
| B1 editor | product-automations | product-modals, product-accessibility |
| B1 CLI | cli-lead | cli-protocol |

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

remote-lead's design (mail 01M6286J00YZGMR9N766ACN5DQ), in this order:

| Slice | What | Owner | Reviewer |
|---|---|---|---|
| S1 placement | an automation names its machine; every machine folds automation rulings and runs only its own (`live.ts:590`); claims, cursors, history local | automation-lead | remote-lead |
| S5 links from any end | drop Rule 7's editor-only link opening | remote | remote-security |
| S2 writes from its machine | mail, prompts and `command.queued` with actor automation, valid from the automation's machine | remote | remote-security |
| S3 firing log | `automation.firing` rows to the editor: cause, skips, each action applied, refused or held | remote | automation-lead |
| S4 held seat control | `seat.control` start and stop, held as mail is | remote | remote-security |
| S6 | dropped: a board is data, never bound to a machine; one authority with fallbacks instead, `06-fleet-state.md` | | |

First-version limits: seat-state and signal triggers watch only seats on the
automation's own machine; a comment action off the editor is `not_available`
until threads cross. Doctrine edits land with each slice.

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
above. **No per-machine allowance** (operator, 2026-10-28, settled): a code
step runs on its automation's machine with no extra step on that machine;
overseer seats build automations and their code end to end.

| Track | Owner | Reviewer |
|---|---|---|
| K1 contract and runner: the `code` step, its content, input, result, values out, limits | automation-lead | tech-lead, product-feed |
| K2 running code on a machine: TypeScript and shell processes, the SDK package, timeouts and bounds, secrets, logs scrubbed | tech-lead | automation-lead, remote-lead |
| K3 the code editor in the Automations node | product-cron | product-automations, product-accessibility, product-typography |
| K4 CLI: overseer seats create automations and write their code | cli-lead | cli-protocol |
| K5 doctrine: code authored on one machine, run on another; overseer authorship | remote-lead | tech-lead |
| Verify: a code step on the mini, triggered from the MacBook's canvas | product-verify | |

### K1 contract (automation-lead)

- **The step.** A member of `then`: `{kind: "code", language: "typescript" | "shell", source: ContentRef, timeoutMs?}`, 1 s to 15 min, 60 s by default (`src/shared/automation.ts`). The window puts the program with `automationCodePut {text}` (at most 256 KiB) and reads it back with `automationCodeRead {ref}`, both as text.
- **Who wrote it.** `codeRuling {author, installation}` on the automation is the ruling that last set a code step's source, stamped by the ruler (`codeRulingAfter`, `automation-domain.ts`). An edit that keeps the code keeps it, whoever edits the rest; when new code joins an overseer's, the overseer's name stays. The runner's `author` and `rulingInstallation` come only from it.
- **The run.** The input is `{automation, firing, trigger, event, values}`, as JSON (`code-step.ts`). The answer is a ruling: `continued {output}` makes each field `{{code.<field>}}` for the later steps; `stopped {reason?}` and `failed {message, exitCode?, logTail?}` run no later step, and only a failure fails the firing. A run that is not admitted is `refused` (`not_permitted`, `not_available`). A code step runs on the automation's machine before S2, because it writes nothing another machine judges.
- **Open.** A code ref's bytes reaching the automation's machine (content entitlement, K5 and S2).

Prism (`../prism`, read 2026-10-28): every workflow task is an agent run
(`src/workflows.ts:592`); `prism workflow run` prints JSON and exits non-zero
on a failed task, and has no input flag (`src/cli.ts:829`).
