# 0.11.1 Automations with the operator in the loop

Owner: product-lead. Decided by the operator on 2026-10-29, in answer to
signal 01M62W9VNJ2VBR6DWGMBY7ZJGR. All of it ships in 0.11.1.

## Target

An automation can stop and ask the operator, the way a seat does, and act on
the answer. It raises the same kinds of signal a seat raises. Each firing
raises its own signal, and they are never merged. The run history shows each
signal with its answer. When the operator answers, the answer can start
another automation, go to a seat, or be written into an artifact under a
name the automation formats.

## Decisions

- **1. Run history shows the signal and its answer.** Built in 5de116937,
  04cfd5ba7 and 62af46ca6 ("Open run" on the feed card).
- **2. One signal per firing, never merged.** Ten firings raise ten
  signals. The operator says that is the least confusing. Nothing groups or
  replaces them. A test holds this.
- **3. Signals a seat can raise.** The signal action takes the seat kinds:
  `escalate` (a question, waiting on you), `blocked`, and `feedback` (asks
  for a review). Each lands in the feed section a seat's would, from the
  automation's name. `notice` stays for something only to read. `work` goes,
  because `escalate` with N1's forms (text, artifact, secret, proof) covers
  it. N2 shipped gated off in 0.11.0 (`automationSignals`), so no stored
  automation held `work` (the operator's database had none); any stored
  `work` is read as `escalate`. The gate is on in ship from 0.11.1, after
  the walks (15c9e388e). The secret form waits for the vault (0.12): until
  then a signal step asking for a secret is refused at save (6d22439c8).
- **3. An answer starts an automation.** There is a new change watch,
  "When a signal raised by [automation] is answered". It can narrow to one
  signal step or kind. Its values are:
  - `answer.text`, `answer.link` (the artifact handed in, if any),
    `answer.by` and `answer.at`;
  - `signal.title`, `signal.kind` and `signal.link`;
  - `raised.<name>`: every value of the firing that raised the signal, so
    the flow keeps its context (which task, which artifact).

  A secret answer is never a value; only its name is. An answer is the
  operator's act, so it fires, unlike an automation's own write. An
  automation has one trigger, so in the editor each signal step gets a
  "When answered…" control. It creates a new automation whose trigger names
  that step, and the two show as linked.
- **4. The answer goes to a target.** The signal action takes `answerTo?`,
  which is one of:
  - a seat in reach: it gets the answer as a prompt, with the signal's title
    and the answer, the way a seat hears the answer to its own signal;
  - an Artifacts node in reach with a `title`: the answer becomes a new
    document there;
  - an artifact: the answer is appended as a dated section.
- **4. Names are formatted.** Any value may carry formatting:
  - `{{fired.at|date:YYYY-MM-DD}}` (date patterns, in the automation's time
    zone);
  - `|slug`, `|lower`, `|upper` and `|trim`.

  The set is closed. An unknown format is refused at save with the list of
  formats. Formatting works everywhere a value does: a `create-artifact`
  title, a run's result written with `{{code.<field>}}`, and `answerTo`
  titles.

## H1 contract

Owner: automation-lead. The source of truth is `src/shared/automation.ts`;
this section says what it holds so H2, H3 and H4 can build on it.

**Signal kinds.** The signal action's `signal` is one of `notice`,
`escalate`, `blocked` or `feedback` (`SignalKind`). `escalate` and `blocked`
may carry a `form`; `notice` and `feedback` may not (the seat rule,
`signalKindTakesForm`). The action's `work` field (due time and urgency)
goes with the `work` kind. A stored action that still says `signal: "work"`
is read as `escalate`, and its `work` field is dropped
(`upgradeStoredAutomation`, run before every stored automation is decoded).
The operator's database held no automation at all on 2026-10-29 (checked on
a read-only copy), so nothing is mapped in practice.

**Step ids.** A signal action may carry `id`, a step id the automation
names it by: lower-case letters, digits and dashes, 1 to 32 characters,
starting with a letter or digit (`StepId`). Two signal steps of one
automation never share an id (refused at save). A step with `answerTo` and
no id is named at save, `step-<n>` by its place (`withStepIds`); the editor
and the CLI mint one when something else links to a step. An id survives a
reorder, which an index does not.

**One signal per firing.** A firing's signal step raises one signal, whose
id is derived from the firing and the step. A retried firing raises it once;
ten firings raise ten signals. Nothing groups or replaces them
(`tests/automation-signal-action.test.ts`).

**The answered watch.** A new change watch:

```ts
{ kind: "answered",
  automation: { node: NodeId, automationId: AutomationId }, // the raising one
  step?: StepId,                                            // that signal step only
  signal?: "escalate" | "blocked" | "feedback" }            // that kind only
```

It fires once per signal (claim key `answered:<signalId>`) when a signal the
named automation raised becomes `answered`. A dismissed or withdrawn signal
fires nothing, and so does a notice. The raising automation sits on the
watch's own Automations node (refused at save otherwise): reach lists seats
and resources, never an Automations node. An answer is the operator's act,
so it always fires; it is never an automation's own write.

**Values of the answered watch** (`AUTOMATION_VALUES.answered`):

| Value | Says |
|---|---|
| `answer.text` | the answer's words; for a secret form only the name it set, never the value |
| `answer.link` | a link to the document an artifact form's reply made, or a proof's links, one a line |
| `answer.by` | who answered: `operator` |
| `answer.at` | when, as an ISO time |
| `signal.title` | the signal's title as raised |
| `signal.kind` | `escalate`, `blocked` or `feedback` |
| `signal.link` | a link to the raising automation's node, labelled with the title |
| `raised.<name>` | any value the raising firing carried when its signal step ran: `raised.fired.at`, `raised.task.title`, `raised.code.<field>` |

A `raised.<name>` the raising firing did not carry stays as written, as a
`{{code.<field>}}` does. The signal carries the step and the raising
firing's values on its source (`source.step: {index, id?, raised}`), so the
answer finds them on any machine, after any edit, and after the raising
firing is pruned from history. Each value is cut to 2,000 characters and
all of them to 32,000; one that does not fit is left off and stays as
written.

**answerTo.** The signal action takes `answerTo?`, one of:

```ts
{ kind: "seat", to: MentionRef }                       // a seat in reach
{ kind: "document", node: NodeId, title: string }      // a new document in that Artifacts node
{ kind: "append", to: MentionRef }                     // an artifact: a dated section at its end
```

`notice` takes none (refused at save). When the signal is answered, the
automation's machine delivers the answer, as the automation:

- **seat:** prompt mail from the Automations node, worded as a seat's own
  answer is: the signal's kind and title, then the answer and its link.
- **document:** a document titled `title`, its body the answer and its link.
- **append:** `## <answer.at as YYYY-MM-DD HH:mm>`, then the answer and its
  link, appended against the head it reads.

`title` may name the step's own values (its trigger's, earlier code steps')
and the answered values `answer.*` and `signal.*`, said at answer time. The
delivery is recorded as a firing of the raising automation with cause
`{kind: "change", key: "answer:<signalId>"}` and one ruling, at the signal
step's index; its ids derive from the signal, so a delivery heard twice
writes once. It is not held back by the automation being off or by its
limits, only by reach. Like every change firing it is at most once: a crash
between its claim and its delivery leaves it claimed and undelivered.

**Value formats.** A value token may carry formats, applied left to right:
`{{name|format|format}}`. The set is closed (`VALUE_FORMATS`):

| Format | Does |
|---|---|
| `date:<pattern>` | a time value written in `pattern`: `YYYY`, `YY`, `MM`, `M`, `DD`, `D`, `HH`, `H`, `mm`, `ss`, and any of ``- _ / . : , T`` and space as written. In the automation's time zone: its schedule's, else its machine's |
| `slug` | lower case, runs of anything but letters and digits as one `-`, none at the ends |
| `lower`, `upper` | case |
| `trim` | spaces off both ends |

A format that is not in the set, or a date pattern with anything else in it,
is refused at save: "`{{fired.at|dat:YYYY}}` names an unknown format", next
step listing the formats. `date` on a value that is not a time leaves it as
said. Formats work everywhere a value does, `answerTo` titles included.

**Answering (H2).** An automation's signal is answered without mail to the
Automations node. The runner hears the answered row through
`onAgentSignalChanged` on the automation's machine, as it hears a raise.

## Steps

| Step | Who | What | Review |
|---|---|---|---|
| H1 | automation-lead | contract and runtime: seat kinds on the signal action, `work` mapped, one signal per firing (test), the answered watch with its values, `answerTo` (seat, node, artifact), value formats | product-feed, tech-lead |
| H2 | product-feed | feed: an automation's signal sits in its kind's section, from the automation; answering one feeds H1's event | automation-lead |
| H3 | product-automations | editor: the kind picker, "When answered…" making the linked automation, the `answerTo` picker, formats in "Insert value" | product-modals, product-accessibility, product-typography |
| H4 | cli-lead | CLI for H1's shapes | cli-protocol |
| H5 | product-verify | walk, dark and bright: an escalate from an automation answered in the feed starts a second automation that writes `Review {{fired.at\|date:YYYY-MM-DD}}` into an Artifacts node and prompts a seat; ten firings show ten signals | |

## Known limit, lifted

Was: the raising firing is kept on its own machine, so an answered watch on
another machine would get no `raised.<name>` values. Lifted in H1 after
tech-lead's review: the step and the values ride the signal, which crosses
machines, so no firing is read and nothing is refused for its machine.
