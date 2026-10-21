# 08 Continuity (onboard and offboard)

Proposed owner: pty (seat sessions, offboard), cli (onboard output).
Reviewers: product.

## Target

A fresh session moves on from `junto onboard` alone: who it is, what it may
do, what others wait on from it, and what changed while it was gone. Onboard
stays small, keeps its stable part byte-identical between sessions for the
prompt cache, and cannot be degraded by a bad note. Depth comes from CLI
views the seat calls when it needs them.

## Today

- Onboard is assembled at `src/main/junto/work/control.ts:1285-1357`. A real
  briefing (product-lead, 2026-10-21) was 36 KB: `sessions` 11.9 KB,
  `co_members` 11.6 KB, `connected` 7.1 KB, region instruction 2.1 KB. No
  state since the last session exists in it.
- Automatic closes take no agent turn and write no notes, by design, to
  spare the cache (`src/main/junto/seat-sessions/offboard-close.ts:145-151`).
  Of this seat's last four Claude sessions, none left notes.
- A session record built at close was tried and reverted (4205c4357,
  a5f02d172, 57ee092a3). Its model was imported from outside Junto and
  bent the whole design around itself. This plan uses nothing but the rows
  Junto already writes, named by what they are.
- The field named `instructions` holds the commands for connected seats, not
  instructions. A briefing read error becomes "no briefing"
  (`src/main/junto/references/seat-reads.ts:66`).

## What goes in onboard

One test: **would leaving it out fail silently?** If the seat would not know
to ask, and missing it makes the seat act wrongly, it is in. If an error
would tell the seat, or the seat would look when it needs it, it is a CLI
view.

Order, most stable first, so the prompt cache holds across sessions:

1. **Guidance** (fixed lines), **app briefing**, **region instructions**
   outer to inner, **seat instructions**. Changes only when the operator
   edits them.
2. **Who and what**: seat, node, region path, connected seats (names and
   commands), resources in reach by kind with counts (01). No timestamps.
3. **Since your last session** (as of a stated time), each section capped at
   about 8 lines, each line one sentence and an id, overflow as a count and
   the command that lists it:
   - Mail threads where the last message is to you and you have not replied.
   - Mail threads where you wrote last and wait on a reply.
   - Your open signals.
   - Operator answers to your signals since your last session ended.
   - Mail held for you (mail-waiting facts).
   - After 04: your task and its state; reviews you owe.
4. **Last note**, if the previous session left one (below).

Removed from onboard: the full `co_members` records (names by region
instead), the past sessions list (the last one and a count instead), the
`tools` block where it repeats `guidance`.

## Contract

```ts
// src/shared/seat-since.ts (new, pure)
type SinceInput = {
  readonly seat: NodeId;
  readonly since: number;                         // previous session's ended_at
  readonly mail: ReadonlyArray<MailRow>;          // this seat's inbox and sent
  readonly signals: ReadonlyArray<AgentSignal>;
  readonly mailWaiting: ReadonlyArray<MailWaitingFact>;
};
type SinceLine = { readonly text: string; readonly ref: string };
type SinceSection = { readonly lines: ReadonlyArray<SinceLine>; readonly more: number; readonly command: string };
type Since = {
  readonly asOf: number;
  readonly owedReplies: SinceSection;
  readonly awaitingReplies: SinceSection;
  readonly openSignals: SinceSection;
  readonly answersSince: SinceSection;
  readonly heldMail: SinceSection;
};
seatSince(input: SinceInput, caps: { readonly perSection: number }): Since;
```

Computed at onboard from rows, never stored. The CLI view
`junto since [--all]` returns the same projection uncapped, so onboard and
the view cannot disagree.

## Notes

Optional, small, one generation, checked against records.

```ts
type HandoffNote = {
  readonly next?: string;                 // the next step
  readonly holding?: string;              // what the session believed and had not proven
  readonly avoid?: string;                // what not to do, and why
  readonly refs: ReadonlyArray<string>;   // thread, task, signal or commit ids
};                                        // 1.5 KB cap, refused over
```

- Shown to the next session only. A note never reaches the session after
  that; anything that must last goes into a record or into seat instructions
  by the operator.
- Shown under "since your last session", labelled as the previous session's
  belief.
- Each ref is resolved at onboard and printed with its current state (thread
  answered since, signal closed). A ref that resolves to nothing is shown as
  such.
- Automatic closes stay turnless. The "since" sections carry the state; a
  note is only what records cannot hold.

## Small fixes in the same pass

- Rename onboard `instructions` to `commands`.
- Say "briefing unreadable" instead of omitting it when the read fails.
- `signal list` returned exactly 20 answered signals for this seat
  (unverified whether that is a cap); page it.
- Past session `gist` and `notes` only for sessions that wrote them; say
  "closed by Junto, no notes" for automatic closes instead of an empty field.

## Kept, reshaped, deleted

| | |
|---|---|
| Kept | Automatic offboard and its cache rules, `seat_sessions`, transcript paths, `msg list` filters, mail-waiting facts |
| Reshaped | Onboard order and size, notes become `HandoffNote`, sessions list |
| Deleted | Inline notes for the last five sessions, full `co_members` records |
| New | `seat-since.ts`, `junto since`, ref resolution for notes |

## Questions

- **pty**: The previous session's `ended_at` as the "since" boundary: right
  for a session replaced at start (`replaced`) too?
- **pty**: Mail threads owed and awaited: compute from the seat's mailbox
  rows directly, or is there an index for this already?
- **cli**: Onboard as JSON with this order: does the CLI print it in field
  order, so the stable prefix stays byte-identical?
