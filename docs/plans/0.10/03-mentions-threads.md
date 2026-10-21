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
`[#T-42 fix tabs](junto://canvas/factory?node=task-...&task=...)`. Agents read
it as text and can pass the ref straight to the CLI. `mentionsOf(text)`
parses the refs; nothing is stored beside the text that could disagree with
it (today `metadata.mentions` sits beside plain `@Name`, matched by name,
`src/renderer/lib/seat-threads.ts:561-573`).

**Writing from the CLI.** A seat writes `@product-feed` or `#T-42`; the CLI
resolves each against availability at send time and rewrites it to the link
form, or refuses with the candidates it could have meant.

## 2. Availability: `mentionables(context)`

| Context | Seats | Tasks, artifacts, pages |
|---|---|---|
| A seat's mail thread | seats connected to that seat by an edge | in the seat's reach (01) |
| A resource's comments | seats in reach of the resource | in reach of the resource |
| The needs-you feed reply | seats connected to the signalling seat | in that seat's reach |
| An automation definition | seats in its region and below (07) | same |

Machine does not matter (02). Whether the seat's process runs does not
matter; delivery holds mail until it can type it.

## 3. Meaning

- **A seat mention means that seat is told.** It receives one mail in the
  thread with the mention, unless it is already a recipient. One rule
  everywhere. This changes operator mail threads, where a mention is a
  reference today. (Operator decision 3.)
- **A task, artifact or page mention is a reference.** Nobody is mailed. It
  renders as a chip that opens the resource, and the resource lists where it
  was mentioned (backlinks).

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

- Who receives a resource comment: the resource's people (task assignee and
  reviewers, artifact owner), everyone mentioned, and everyone who already
  posted in the thread. Delivery is the existing mail delivery.
- The refusal of `taskId` with `threadId` goes; a task comment is a thread.
- Pad pins become `artifact` threads with a `box` anchor (05). Git review
  line comments become `lines` anchors.
- Resource threads are universal facts (02); mailbox threads keep today's
  mail rows.

## 5. Component

`MentionInput` in `src/renderer/components/ui/`, built on `Combobox`:
providers per kind (seat, task, artifact, page), each given the context and
returning candidates; inline chips; keyboard identical to the house
combobox. Used by: seat thread composer, `SignalReply` (needs-you and seat
signals), task comments, artifact comments, page comments, automation
conditions. Each composer passes its context; none filters on its own.

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
| New | `mention.ts`, `ThreadSubject`, `Anchor`, `MentionInput`, task and artifact signal attachments |

## Questions

- **pty**: A seat mention delivers one mail into the thread. Does delivery
  need anything new for subject threads, or is it a plain `message.append`
  with metadata?
- **cli**: Name resolution for `@seat` and `#task` at send time, with a
  refusal listing candidates: where does it live, CLI or main?
- **canvas**: Backlinks (where a task was mentioned): computed on read, or a
  table?
