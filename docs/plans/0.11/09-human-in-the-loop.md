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
  it. N2 shipped gated off (`automationSignals`), so no stored automation
  should hold `work`. automation-lead confirms that on a copy of the
  operator's database and maps any stored `work` to `escalate` when it is
  read. The gate turns on in ship after the walk.
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

## Steps

| Step | Who | What | Review |
|---|---|---|---|
| H1 | automation-lead | contract and runtime: seat kinds on the signal action, `work` mapped, one signal per firing (test), the answered watch with its values, `answerTo` (seat, node, artifact), value formats | product-feed, tech-lead |
| H2 | product-feed | feed: an automation's signal sits in its kind's section, from the automation; answering one feeds H1's event | automation-lead |
| H3 | product-automations | editor: the kind picker, "When answered…" making the linked automation, the `answerTo` picker, formats in "Insert value" | product-modals, product-accessibility, product-typography |
| H4 | cli-lead | CLI for H1's shapes | cli-protocol |
| H5 | product-verify | walk, dark and bright: an escalate from an automation answered in the feed starts a second automation that writes `Review {{fired.at\|date:YYYY-MM-DD}}` into an Artifacts node and prompts a seat; ten firings show ten signals | |
