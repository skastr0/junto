# 03 Mentions, threads, comments, associations

Proposed owner: product (component and composers), pty (delivery), cli
(resolution). Reviewers: canvas.

## Target

One mention system and one thread system. Every composer that names a seat,
task, artifact or page uses the same component, the same encoding, the same
availability rule and the same meaning. Every comment anywhere is a mail
thread with a subject.

## Today

Three mention copies, three regexes, three meanings
(research: `src/renderer/components/threads/ThreadComposer.tsx`,
`src/renderer/components/pad/pad-editor-model.ts:431-480`,
`src/shared/git-review.ts:236-270`):

| Composer | Candidates | Meaning |
|---|---|---|
| Seat threads | seats wired either way (`src/main/junto/work/operator-threads.ts:75-86`) | reference only, no copy |
| Pad pins | seats wired into the pad (`src/shared/board-actors.ts:57-73`) | wakes the seat (`src/main/junto/work/pad-rules.ts:22-36`) |
| Git review | seats in the anchor's regions (`src/shared/review-candidates.ts:12-40`) | recipient, one mail each |

No mentions in the needs-you composer (`SignalReply.tsx`), task comments or
chat. None use the design system `Combobox` (`src/renderer/components/ui/Combobox.tsx`).

Threads: keyed by `metadata.threadId` or the opening message id
(`src/shared/crew.ts:139-154`), derived from seat mailboxes only, participants
are operator or seat (`src/shared/mail-threads.ts:18-31,95-96`). A task comment
cannot join a thread (`src/main/junto/work/control.ts:2091-2094`). Pad pins and
board topics are separate thread-like stores.

## 1. Mention contract: `src/shared/mention.ts` (new)

```ts
type MentionRef =
  | { readonly kind: "seat"; readonly nodeId: NodeId }
  | { readonly kind: "task"; readonly nodeId: NodeId; readonly taskId: string }
  | { readonly kind: "artifact"; readonly nodeId: NodeId; readonly artifactId: string }
  | { readonly kind: "page"; readonly nodeId: NodeId };
```

**Encoding.** The text is the source of truth. A mention is written inline as
a markdown link to its node ref:
`[@product-feed](junto://canvas/factory?node=agent-01M...)`,
`[#42 fix tabs](junto://canvas/factory?node=task-...&item=...)`. Agents read
it as text and can pass the ref straight to the CLI. Two changes make that
true (cli-lead): `parseNodeRef` refuses any `&` today
(`src/shared/node-ref.ts:127`), so node refs gain an `item` parameter; and
target resolution accepts `junto://` refs (01). `#42` is the task's
per-canvas number (04); tasks have only opaque ids today
(`src/shared/work-model.ts:363-364`). `mentionsOf(text)`
parses the refs; nothing is stored beside the text that could disagree with
it (today `metadata.mentions` sits beside plain `@Name`, matched by name,
`src/renderer/lib/seat-threads.ts:561-573`).

**Writing from the CLI.** A seat writes `@product-feed` or `#42`; main (not
the CLI, which is a thin socket client) resolves each on send with the same
resolver as 01 and rewrites it to the link form, or refuses with the
candidates it could have meant, in the same refusal shape.

## 2. Three parts, composed per composer

Operator direction (2026-10-21): a combobox component, availability
components, and side effect hooks that each composer chooses. Nothing about
what a mention does is universal.

1. **`MentionCombobox`** (`src/renderer/components/ui/`), built on
   `Combobox`: the `@` and `#` query, the list, keyboard, inline chips, and
   writing the link form into the text. It knows nothing about who may be
   mentioned or what happens after.
2. **Availability sources**, one per rule, each a hook returning candidates
   for a context:
   - `useConnectedSeats(seat)`: seats wired to a seat by an edge.
   - `useSeatsInReach(resource)` and `useResourcesInReach(seatOrResource)`:
     region reach (01).
   - `useAutomationTargets(automation, author)`: below the node and within the author's reach (01, 07).
   A composer passes the sources it needs to the combobox. Main checks the
   same rule again when the text is sent; the shared rule lives in
   `src/shared/` so both sides read one function.
3. **Side effect hooks**, per composer: what sending with these mentions
   does. Each composer declares its own, for example:
   - Seat mail thread: today's behaviour, a reference with no copy.
   - Resource comment: mentioned seats receive the comment in the thread.
   - Needs-you reply: mentioned seats are copied on the answer.
   - Automation definition: no side effect; the mention is a target.
   The hook runs in main on send, so the effect holds for CLI writers too.

## 3. Availability by composer

| Context | Seats | Tasks, artifacts, pages |
|---|---|---|
| A seat's mail thread | seats connected to that seat by an edge | in the seat's reach (01) |
| A resource's comments | seats in reach of the resource | in reach of the resource |
| The needs-you feed reply | seats connected to the signalling seat | in that seat's reach |
| An automation definition | seats in its region and below (07) | same |

Backlinks: a projection table written in the same transaction as the fact
that carries the text, rebuildable from facts, never read for authority
(canvas-lead).

Machine does not matter (02). Whether the seat's process runs does not
matter; delivery holds mail until it can type it.

Rendering is the same everywhere: a chip that opens the seat or resource.
Resources list where they were mentioned (backlinks).

## 4. Threads with subjects

A thread gains a subject. Comments on anything are mail rows in a thread.

```ts
type ThreadSubject =
  | { readonly kind: "mailbox"; readonly seat: NodeId }          // today's threads
  | { readonly kind: "task"; readonly nodeId: NodeId; readonly taskId: string }
  | { readonly kind: "artifact"; readonly nodeId: NodeId; readonly artifactId: string; readonly anchor?: Anchor }
  | { readonly kind: "page"; readonly nodeId: NodeId; readonly anchor?: Anchor };

type Anchor =
  | { readonly kind: "whole" }
  | { readonly kind: "box"; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly url?: string }
  | { readonly kind: "cells"; readonly range: string }
  | { readonly kind: "text"; readonly quote: string; readonly offset?: number }
  | { readonly kind: "lines"; readonly file: string; readonly from: number; readonly to: number };
```

- Delivery (pty-lead): one row in the mentioned or subscribed seat's
  mailbox, `threadId` and subject in metadata, message id derived from
  (comment id, seat) so a replay never mails twice, written once by the
  editing machine. Then delivery types it, hands it to the link, or starts
  the seat, as today. Two changes: the notice header's reply command targets
  the sender's node (`src/shared/message-delivery.ts:188`), so in a subject
  thread it must name the subject and reply to the subject; and
  `mail-threads.ts:93` drops every row with a `taskId`, which goes with the
  `control.ts:2091` refusal.
- Who receives a resource comment: the resource's people (task assignee and
  reviewers, artifact owner), everyone mentioned, and everyone who already
  posted in the thread. Delivery is the existing mail delivery.
- The refusal of `taskId` with `threadId` goes; a task comment is a thread.
- Pad pins become `artifact` threads with a `box` anchor (05). Git review
  line comments become `lines` anchors.
- Resource threads are universal facts (02); mailbox threads keep today's
  mail rows.

## 5. Where it is used

Seat thread composer, `SignalReply` (needs-you and seat signals), task
comments, artifact comments, page comments, automation definitions. Each
composes `MentionCombobox`, its availability sources and its side effect
hook (section 2).

## 6. Associations on signals, mail and tasks

- Signal attachments (`src/shared/wire/agent-signals.ts:64-113`) gain
  `{ kind: "task", ref }` and `{ kind: "artifact", ref }`. CLI flags `--task`
  and `--artifact` on escalate, blocked and feedback.
- The feed renders them like other attachments, as chips that open the
  resource. A stamp request (04) carries its task this way.
- Mail `refs` (`crew.ts:24-36`) keep their citation role; a mention in the
  text is how a resource is linked from prose.

## Kept, reshaped, deleted

| | |
|---|---|
| Kept | Thread keying, mail delivery and holds, `Combobox`, the feed attachment renderer |
| Reshaped | Mail rows carry a subject; operator threads read subjects; `SignalReply` gains mentions |
| Deleted | The three mention copies and their CSS; `metadata.mentions`; `BoardPost.tags`; the pad pin and post store (moved into threads); the taskId with threadId refusal |
| New | `mention.ts`, `ThreadSubject`, `Anchor`, `MentionCombobox`, availability sources, per composer side effect hooks, task and artifact signal attachments |

## Questions

- ~~**pty**: delivery~~ Answered above (section 4).
- ~~**cli**: where resolution lives~~ Answered: main, same resolver as 01.
- ~~**canvas**: backlinks~~ Answered: projection table (section 3).
- **cli + canvas**: the link form embeds the canvas name, but `canvas_name`
  is a mutable key (`ON UPDATE CASCADE`, `src/main/junto/model/state-schema.ts:3`),
  so a rename breaks every stored link (canvas-lead). Node ids are unique per
  canvas; the encoding should carry the node id and item and take the canvas
  from context. cli to settle the ref shape with the `item` parameter.
