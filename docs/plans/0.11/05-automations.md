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

## Open: 24/7 automations and code steps (with the operator)

The operator wants most automations to run around the clock on the Mac mini
or a VPS, seats there working 24/7, and actions aimed at a seat on an
offline machine to wait. They also want code steps: a shell or TypeScript
file, or a Prism workflow, whose result decides whether the chain goes on.

What the rules say (`docs/machines.md`): one editing machine per canvas
(Rule 2) rules every write and runs every automation (0.10/07 Runner), so
with the editor asleep nothing fires and no task changes anywhere. Seats on
the mini already run 24/7. So the 24/7 machine must be the editor.

remote-lead's answer (mail 01M628012VMPZT17Y778N6Q2FD, 2026-10-28):

- **Editing from the MacBook is synchronous.** The window sends each write
  over the link to the mini's core, which applies it as the operator; with
  no link the window is read-only and says why. Rule 4 is unchanged. Large,
  medium risk: a new link channel granting operator authority per machine,
  a closed op set, refused from a seat environment.
- **The MacBook opens the link** (Rule 7 is symmetric; today only the editor
  opens links). Small to medium, low risk.
- **No live handover.** Create the 24/7 canvas on the mini (free), or move a
  canvas once while quiesced (medium to large). Live handover is extra large.
- **Forced product choices** with the mini as editor: browser pages need a
  window's Electron (Rule 10); Files nodes on the MacBook go dark there.
- **Offline targets.** Mail and prompts already wait (Rule 6). Seat start
  and stop become a held action on the runner, retried when the link opens,
  local to the editor. Small.
- **Code steps run on the editing machine only.** No remote-execution row
  pair; to work on another machine, a step prompts a seat there and the
  runner triggers on what it reports.
- **Security conditions for code steps:** (i) only the operator authors
  one, from the window or an owner command, never a seat or an overseer;
  (ii) the program is a path on the editor, never bytes that crossed;
  (iii) values never go into a shell string or argv, only structured input
  such as stdin JSON; (iv) secrets resolve on that machine only and argv,
  environment and output stay out of logs; (v) a timeout, a size bound and
  the loop rule.

Prism (`../prism`, read 2026-10-28): every workflow task is an agent run
(`src/workflows.ts:592`); `prism workflow run` prints JSON and exits non-zero
on a failed task, and has no input flag (`src/cli.ts:829`).
