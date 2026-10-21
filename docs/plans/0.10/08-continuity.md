# 08 Continuity (onboard and offboard)

Proposed owner: pty (seat sessions, offboard), cli (onboard output).
Reviewers: product.

## Target

A fresh session moves on from `junto onboard` alone: who it is, what it may
do, what others wait on from it, and what changed while it was gone. Onboard
stays small and cannot be degraded by a bad note. Depth comes from CLI views
the seat calls when it needs them.

**Cache, corrected (cli-lead).** Onboard is a tool result after the first
user turn, and that turn always carries per-session text (the mail headline
and `MAIL_ONBOARD_POINTER`, `src/shared/message-delivery.ts:114`, or the
injection line, `src/shared/managed-terminal-injection.ts:50`). A cache prefix
ends at the first differing byte, so no order of onboard shares a prefix with
the previous session. Within a session it is cached once written. The order
below is for reading. A cross-session cache win would need the stable part
delivered at launch, before any variable text: an open question for pty.

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

Order, most stable first:

1. **Guidance** (fixed lines), **app briefing**, **region instructions**
   outer to inner, **seat instructions**. Changes only when the operator
   edits them.
2. **Who and what**: seat, node, region path, connected seats (names and
   commands), resources in reach by kind with counts and their commands (01).
   `compileConnectionInstructions` (`control.ts:1341`) compiles commands from
   edge ports only; it takes the kinds in reach as a second input, and its
   lock `tests/seat-onboarding.test.ts:206` covers reach.
3. **Since your last session** (as of a stated time), each section capped at
   about 8 lines, each line one sentence and an id, overflow as a count and
   the command that lists it:
   - Mail threads where the last message is to you and you have not replied.
   - Mail threads where you wrote last and wait on a reply.
   - Your open signals.
   - Operator answers to your signals since your last session ended.
   - A count of unread mail.
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
  readonly mail: ReadonlyArray<MailRow>;            // every mailbox row this seat sent or received
  readonly signals: ReadonlyArray<AgentSignal>;
  readonly previousStartedAt: number;               // bounds silent signal answers only
};
type SinceLine = { readonly text: string; readonly ref: string };
type SinceSection = { readonly lines: ReadonlyArray<SinceLine>; readonly more: number; readonly command: string };
type Since = {
  readonly asOf: number;
  readonly owedReplies: SinceSection;
  readonly awaitingReplies: SinceSection;
  readonly openSignals: SinceSection;
  readonly answersSince: SinceSection;
  readonly unread: number;
};
seatSince(input: SinceInput, caps: { readonly perSection: number }): Since;
```

Computed at onboard from rows, never stored (pty-lead):

- **No time boundary for threads.** Owed and awaited threads are state: the
  last message's direction and its `deliveredAt` and `readAt`
  (`src/main/junto/work/repository.ts:2500-2505`). `ended_at` cannot bound
  them: a replaced session ends when the next one starts, so the window would
  be empty.
- **Derivation.** The existing `mail-threads.ts` derivation that the Threads
  popup and the phone use, filtered to this seat. Sent mail lives in each
  recipient's mailbox and the only index is `work_messages_inbox` by node, so
  it reads every mailbox on the canvas: fine at today's size, unmeasured.
- **Signal answers.** Mailed answers are mail. Silent answers have no receipt
  (`src/main/junto/signals/operator.ts:21-25`); bound those by the previous
  session's `started_at`.
- **Unread** is a count of unread rows in the seat's mailbox. Mail-waiting
  facts are an operator feed fact with no mail id or text
  (`src/shared/mail-waiting.ts:1-25`), so they are not a source here.

`junto since [--all]` returns the same projection uncapped, built on the
`msg list` filters (`src/shared/mail-list-filter.ts`) so the two never count
owed replies differently (cli-lead).

## Notes

Unchanged. Junto already has offboard notes and the continuation, the note
for the next session (`src/main/junto/seat-sessions/repository.ts:49-63`,
capped at 16,000 characters, `src/shared/seat-sessions.ts:126`). They stay
what they are and are shown as today. The draft's note template and
reference checking were dropped (pty-lead): a template for the seat's words
and a split between records and the seat's words is the same move as the
reverted session record. Automatic closes stay turnless.

## Small fixes in the same pass

- Rename onboard `instructions` to `commands`.
- Say "briefing unreadable" instead of omitting it when the read fails.
- `signal list` lists every open signal and the last 20 closed ones
  (`AGENT_SIGNAL_CLOSED_HISTORY`, `src/main/junto/signals/repository.ts:78,323`);
  page it with a since cursor, as `msg list` does.
- Rewrite the guidance line at `src/shared/seat-onboarding.ts:301` ("Edges are
  your permissions ... commands under `instructions`"): false after 01 and
  stale after the rename. Other readers: `tests/onboard-output.test.ts:190-211`,
  the comment at `src/cli/commands/seat-discovery.ts:151`.
- Past session `gist` and `notes` only for sessions that wrote them; say
  "closed by Junto, no notes" for automatic closes instead of an empty field.

## Kept, reshaped, deleted

| | |
|---|---|
| Kept | Automatic offboard and its cache rules, `seat_sessions`, transcript paths, `msg list` filters, mail-waiting facts |
| Reshaped | Onboard order and size, sessions list, guidance line, `compileConnectionInstructions` |
| Deleted | Full `co_members` records, the full past sessions list |
| New | `seat-since.ts`, `junto since`, signal list paging |

## Questions

- ~~**pty**: boundary and index~~ Answered above: no time boundary for
  threads, the existing thread derivation, no index.
- ~~**cli**: field order~~ Answered: printed in insertion order
  (`src/cli/core/output.ts:67`); no integer-like keys today.
- **pty**: Deliver the stable part (guidance, briefing, region and seat
  instructions) at launch, before any per-session text, so it can share a
  cache prefix across sessions? Worth it, or not?
