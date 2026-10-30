/**
 * The operator's side of mail threads: a seat's threads and one thread's
 * messages, read from the mailboxes through the shared derivation, the seats
 * a mention may name, and the operator's send into a thread.
 *
 * Operator mail is what the desktop and the phone already write: one row in
 * the browsed seat's mailbox through `workSystemMailboxNotify`, handed to
 * `messageDelivery`. A mention is the link in the text, kept nowhere else; a
 * mentioned seat is sent nothing, except in a git review's mail, where it
 * receives the row in the same thread (03 section 2, the review's side effect).
 *
 * Mail text never enters a refusal: every refusal here is fixed words and
 * typed ids, and a failed write is reported without the store's message.
 */
import { Effect, Option } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { ulid } from "ulid";
import { mailExtensionMetadata, type MailMessageId } from "@shared/crew";
import { mentionedOnce, mentionsOf } from "@shared/mention";
import { linesAnchorMetadata, type ResourceSubject } from "@shared/thread-subject";
import { reviewCandidates } from "@shared/review-candidates";
import { subjectNoticeId } from "@shared/subject-notice";
import { OpId } from "@shared/work-ids";
import { asNodeId, type Canvas } from "@shared/model";
import type { NodeId } from "@shared/physics/schema";
import { titleOf } from "@shared/model/title";
import { makeUserMessage } from "@shared/task";
import {
  mailAfter,
  seatMailThreadMessages,
  seatMailThreadMessagesPage,
  seatMailThreads,
  seatMailThreadsPage,
  threadEntriesOfMailbox,
  type MailReadPoint,
  type MailThreadsInput,
  type MentionableSeat,
  type OperatorThreadSendDecoded,
  type OperatorThreadSent,
  type ThreadGroup,
} from "@shared/mail-threads";
import type { MailThreadMessage } from "@shared/wire/mail-threads";
import type { Message } from "@shared/work-model";
import { operatorActorRef } from "@shared/work-reference";
import { ModelService } from "../model/service";
import type { ContentOwner } from "../content/manifest";
import type { ContentRef } from "@shared/wire/content-ref";
import { messageDelivery } from "./message-delivery";
import { writeMailCarryingText } from "../content/mail-text-file";
import { claimOperatorAttachments, operatorMailOwner } from "../content/operator-attachments";
import { ContentService } from "../content/service";
import { heldMailbox } from "./mailbox-cache";
import type { WorkRepositoryShape } from "./repository";
import { WorkRepository } from "./repository";
import { WorkService } from "./service";
import { postSubjectComment } from "./subject-comment";
import { subjectReplyOf } from "@shared/subject-comment";
import { subjectNamesAt, subjectPeopleAt } from "./subject-people";

/** One key per resource, whatever place on it a thread hangs. */
const subjectKey = (subject: ResourceSubject): string =>
  subject.kind === "task" ? `task:${subject.nodeId}:${subject.taskId}`
  : subject.kind === "artifact" ? `artifact:${subject.nodeId}:${subject.artifactId}`
  : subject.kind === "file" ? `file:${subject.nodeId}:${subject.path}`
  : `page:${subject.nodeId}`;

const agentSeatsOf = (canvas: Canvas) => [...canvas.nodes.values()].filter((node) => node.kind === "agent");

/** What one held mailbox contributes to the threads it is in. */
type MailboxThreads = {
  /** The held read it was derived from: another array means its mail moved. */
  readonly messages: ReadonlyArray<Message>;
  /** Its thread mail, by thread id, each thread oldest first. */
  readonly byThread: ReadonlyMap<string, ReadonlyArray<MailThreadMessage>>;
};

/** One thread's mail, as the mailboxes that hold it say it. */
type ThreadMail = {
  /** Each mailbox's rows in it, by mailbox. */
  readonly boxes: Map<string, ReadonlyArray<MailThreadMessage>>;
  /** All of them, oldest first. */
  entries: ReadonlyArray<MailThreadMessage>;
  /** The seats in it, as its mail names them. */
  seats: ReadonlyArray<string>;
  /** The resources its rows hang on, by key. */
  subjects: ReadonlyMap<string, ResourceSubject>;
};

/**
 * A canvas's threads, derived from its mailboxes once and after that only as
 * each mailbox changes: a mail change re-derives the mailbox it landed in and
 * the threads that mailbox holds, never every mailbox on the canvas. Mail is
 * still held by `mailbox-cache`, so a mailbox that did not change costs
 * nothing at all.
 */
type CanvasThreads = {
  readonly boxes: Map<string, MailboxThreads>;
  /** The seats whose mail has been read, an empty mailbox included. */
  readonly known: Set<string>;
  readonly threads: Map<string, ThreadMail>;
  /** The threads each seat is in. */
  readonly ofSeat: Map<string, Set<string>>;
  /** The subjects held anywhere in it, and how many threads name each. */
  readonly subjects: Map<string, { readonly subject: ResourceSubject; count: number }>;
  /** The seats it was derived for and their names: a rename re-derives what names them. */
  signature: string;
  /** Mailboxes whose mail moved since their rows were derived. */
  readonly stale: Set<string>;
  /** Each seat's threads by id, built when asked and dropped when one of them moves. */
  readonly views: Map<string, ReadonlyMap<string, ReadonlyArray<MailThreadMessage>>>;
};

/** The shared order: oldest first, the message id breaking a tie. */
const byAge = (a: MailThreadMessage, b: MailThreadMessage): number => (mailAfter(a, b) ? 1 : mailAfter(b, a) ? -1 : 0);

const NO_MAIL: ReadonlyArray<Message> = [];

const seatsIn = (entries: ReadonlyArray<MailThreadMessage>): ReadonlyArray<string> => {
  const seats = new Set<string>();
  for (const entry of entries) {
    if (entry.from.kind === "seat") seats.add(entry.from.nodeId);
    for (const party of entry.to) if (party.kind === "seat") seats.add(party.nodeId);
  }
  return [...seats];
};

const subjectsIn = (entries: ReadonlyArray<MailThreadMessage>): ReadonlyMap<string, ResourceSubject> => {
  const subjects = new Map<string, ResourceSubject>();
  for (const entry of entries) if (entry.subject !== undefined) subjects.set(subjectKey(entry.subject), entry.subject);
  return subjects;
};

/** A thread's mailboxes merged into its mail, oldest first, with the seats and subjects they name. */
const settle = (index: CanvasThreads, threadId: string, mail: ThreadMail): void => {
  const wasSeats = mail.seats;
  // One mailbox's rows are already oldest first; several merge into one order.
  const parts = [...mail.boxes.values()];
  mail.entries = parts.length === 1 ? parts[0]! : parts.flat().sort(byAge);
  const seats = seatsIn(mail.entries);
  const subjects = subjectsIn(mail.entries);
  for (const seat of seats) {
    const held = index.ofSeat.get(seat);
    if (held === undefined) index.ofSeat.set(seat, new Set([threadId]));
    else held.add(threadId);
  }
  for (const seat of wasSeats) {
    if (seats.includes(seat)) continue;
    const held = index.ofSeat.get(seat);
    held?.delete(threadId);
    if (held?.size === 0) index.ofSeat.delete(seat);
  }
  for (const [key] of mail.subjects) {
    if (subjects.has(key)) continue;
    const held = index.subjects.get(key);
    if (held === undefined) continue;
    if (held.count <= 1) index.subjects.delete(key);
    else index.subjects.set(key, { subject: held.subject, count: held.count - 1 });
  }
  for (const [key, subject] of subjects) {
    if (mail.subjects.has(key)) continue;
    index.subjects.set(key, { subject, count: (index.subjects.get(key)?.count ?? 0) + 1 });
  }
  mail.seats = seats;
  mail.subjects = subjects;
  for (const seat of new Set([...wasSeats, ...seats])) index.views.delete(seat);
};

/** The same messages in the same order: a receipt restamped the rows, and no thread mail moved. */
const sameMail = (a: ReadonlyArray<Message>, b: ReadonlyArray<Message>): boolean => {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index]!.messageId !== b[index]!.messageId) return false;
  return true;
};

/**
 * One mailbox's rows replaced in the index: only the threads it is in are
 * rebuilt. `again` derives the same rows under other names (a rename).
 */
const placeMailbox = (
  index: CanvasThreads,
  nodeId: string,
  messages: ReadonlyArray<Message>,
  nameOf: (nodeId: string) => string | undefined,
  again = false,
): void => {
  const before = index.boxes.get(nodeId);
  if (!again && before !== undefined) {
    if (before.messages === messages) return;
    // A receipt restamps held rows and changes no thread mail: the box takes them, and nothing is derived.
    if (sameMail(before.messages, messages)) {
      index.boxes.set(nodeId, { ...before, messages });
      return;
    }
  }
  const next: MailboxThreads = { messages, byThread: threadEntriesOfMailbox({ nodeId, messages }, nameOf) };
  if (messages.length === 0) index.boxes.delete(nodeId);
  else index.boxes.set(nodeId, next);
  const touched = new Set<string>([...(before?.byThread.keys() ?? []), ...next.byThread.keys()]);
  for (const threadId of touched) {
    let mail = index.threads.get(threadId);
    const rows = next.byThread.get(threadId);
    if (mail === undefined && rows === undefined) continue;
    if (mail === undefined) {
      mail = { boxes: new Map(), entries: [], seats: [], subjects: new Map() };
      index.threads.set(threadId, mail);
    }
    if (rows === undefined) mail.boxes.delete(nodeId);
    else mail.boxes.set(nodeId, rows);
    settle(index, threadId, mail);
    if (mail.boxes.size === 0) index.threads.delete(threadId);
  }
};

/** One seat's threads by id, as held; built when first asked, dropped when one of them moves. */
const viewOf = (index: CanvasThreads, nodeId: string): ReadonlyMap<string, ReadonlyArray<MailThreadMessage>> => {
  const held = index.views.get(nodeId);
  if (held !== undefined) return held;
  const view = new Map<string, ReadonlyArray<MailThreadMessage>>();
  for (const threadId of index.ofSeat.get(nodeId) ?? []) {
    const mail = index.threads.get(threadId);
    if (mail !== undefined) view.set(threadId, mail.entries);
  }
  index.views.set(nodeId, view);
  return view;
};

/** One index per repository and canvas, subscribed as it is made: a mail change names the mailbox it landed in. */
const indexes = new WeakMap<object, Map<string, CanvasThreads>>();

const threadsOf = (repository: WorkRepositoryShape, canvasName: string): CanvasThreads => {
  let byCanvas = indexes.get(repository);
  if (byCanvas === undefined) {
    const held = new Map<string, CanvasThreads>();
    byCanvas = held;
    indexes.set(repository, held);
    repository.subscribeChanges((canvas, nodeId, kind) => {
      if (kind === "work") return;
      held.get(canvas)?.stale.add(nodeId);
    });
  }
  let index = byCanvas.get(canvasName);
  if (index === undefined) {
    index = {
      boxes: new Map(),
      known: new Set(),
      threads: new Map(),
      ofSeat: new Map(),
      subjects: new Map(),
      signature: "",
      stale: new Set(),
      views: new Map(),
    };
    byCanvas.set(canvasName, index);
  }
  return index;
};

/** Every seat's mail read once, and after that only the mailboxes the store said changed. */
const refreshThreads = (
  index: CanvasThreads,
  canvasName: string,
  names: ReadonlyMap<string, string>,
  signature: string,
) =>
  Effect.gen(function* () {
    const nameOf = (nodeId: string): string | undefined => names.get(nodeId);
    if (index.signature !== signature) {
      // A seat was named, added or removed: what names it is derived again, from the mail already held.
      for (const [nodeId, box] of [...index.boxes]) placeMailbox(index, nodeId, box.messages, nameOf, true);
      for (const nodeId of [...index.known]) {
        if (names.has(nodeId)) continue;
        index.known.delete(nodeId);
        placeMailbox(index, nodeId, NO_MAIL, nameOf, true);
      }
      index.signature = signature;
    }
    for (const nodeId of names.keys()) {
      if (index.known.has(nodeId)) continue;
      const messages = yield* heldMailbox(canvasName, nodeId);
      index.known.add(nodeId);
      placeMailbox(index, nodeId, messages, nameOf);
    }
    for (const nodeId of [...index.stale]) {
      // Dropped before the read: a change that lands during it marks this mailbox again.
      index.stale.delete(nodeId);
      if (!index.known.has(nodeId)) continue;
      const messages = yield* heldMailbox(canvasName, nodeId).pipe(
        // A read that failed is still owed: the next look tries this mailbox again.
        Effect.tapError(() => Effect.sync(() => index.stale.add(nodeId))),
      );
      placeMailbox(index, nodeId, messages, nameOf);
    }
  });

/** Every agent seat's mailbox on the canvas, held, with seat names and the name of each subject thread. */
const threadsInput = (canvasName: string) =>
  Effect.gen(function* () {
    const canvas = yield* (yield* ModelService).canvas(canvasName);
    const repository = yield* WorkRepository;
    const seats = agentSeatsOf(canvas);
    const names = new Map(seats.map((seat) => [seat.id as string, titleOf(seat)]));
    const signature = [...names].map(([nodeId, name]) => `${nodeId}\u0000${name}`).join("\u0001");
    const index = threadsOf(repository, canvasName);
    yield* refreshThreads(index, canvasName, names, signature);
    // Each subject held is named once: a task thread is listed as the task.
    const subjects = [...index.subjects.values()].map((held) => [subjectKey(held.subject), held.subject] as const);
    const subjectNames = yield* subjectNamesAt(canvas, canvasName, subjects);
    const input: MailThreadsInput = {
      mailboxes: [...index.boxes].map(([nodeId, box]) => ({ nodeId, messages: box.messages })),
      nameOf: (nodeId) => names.get(nodeId),
      subjectNameOf: (subject) => subjectNames.get(subjectKey(subject)),
      derivedFor: (nodeId) => viewOf(index, nodeId),
    };
    return { canvas, input };
  });

/** What the thread reads take for a canvas, for a reader that pages them itself (the phone's). */
export const seatThreadsInput = (canvasName: string) => Effect.map(threadsInput(canvasName), ({ input }) => input);

export const seatThreads = (canvasName: string, nodeId: string) =>
  Effect.map(threadsInput(canvasName), ({ input }) => seatMailThreads(input, nodeId));

export const seatThreadMessages = (canvasName: string, nodeId: string, threadId: string) =>
  Effect.map(threadsInput(canvasName), ({ input }) => seatMailThreadMessages(input, nodeId, threadId));

/**
 * The threads input with the operator's read points joined in by thread id, so
 * every summary says when it was last read and what came after (0.11.3).
 */
export const withReadPoints = (
  input: MailThreadsInput,
  points: ReadonlyMap<string, MailReadPoint>,
): MailThreadsInput => ({ ...input, readPointOf: (threadId) => points.get(threadId) });

/**
 * One page of the seat's threads: the desktop's list, never the whole of it.
 * `readPoints`, the operator's by thread id, make each summary say when it was
 * last read and what came after it; with none given, nothing is.
 */
export const seatThreadsPage = (
  canvasName: string,
  nodeId: string,
  page: { limit?: number; after?: string; group?: ThreadGroup },
  readPoints?: ReadonlyMap<string, MailReadPoint>,
) =>
  Effect.map(threadsInput(canvasName), ({ input }) =>
    seatMailThreadsPage(readPoints === undefined ? input : withReadPoints(input, readPoints), nodeId, page),
  );

/** One page of a thread's messages, the newest unless a cursor says otherwise. */
export const seatThreadMessagesPage = (
  canvasName: string,
  nodeId: string,
  threadId: string,
  page: { limit?: number; before?: string },
) => Effect.map(threadsInput(canvasName), ({ input }) => seatMailThreadMessagesPage(input, nodeId, threadId, page));

/** Agent seats wired to this seat by an edge, either way. */
const mentionableIn = (canvas: Canvas, nodeId: string): ReadonlyArray<MentionableSeat> => {
  const wired = new Set<string>();
  for (const wire of canvas.wires.values()) {
    if (wire.from === nodeId) wired.add(wire.to);
    if (wire.to === nodeId) wired.add(wire.from);
  }
  wired.delete(nodeId);
  return agentSeatsOf(canvas)
    .filter((seat) => wired.has(seat.id))
    .map((seat) => ({ nodeId: seat.id as string, name: titleOf(seat) }));
};

/** What a thread mail says when its text went as a file. */
const THREAD_TEXT_FILE_NOTE = "The text is attached as message.md";

/** A mail that was not written lets go of the files it had claimed. */
const releaseMailFiles = (owner: ContentOwner) =>
  Effect.flatMap(Effect.serviceOption(ContentService), (content) =>
    Option.isNone(content) ? Effect.void : content.value.releaseOwner(owner).pipe(Effect.ignore),
  );

export const mentionableSeats = (canvasName: string, nodeId: string) =>
  Effect.map(Effect.flatMap(ModelService, (model) => model.canvas(canvasName)), (canvas) => mentionableIn(canvas, nodeId));

type Refused = Extract<OperatorThreadSent, { ok: false }>;
/**
 * A review copy's id, derived from (row, seat) as an answer's copy is: the
 * same row copies a seat under one id, so a retried copy is the same row.
 */
export const reviewCopyId = (rowMessageId: string, seat: NodeId): MailMessageId =>
  subjectNoticeId({ installationId: "", sourceId: rowMessageId as MailMessageId, kind: "mention", recipient: seat });

/** The row written, before delivery. */
export type OperatorThreadWritten = {
  readonly messageId: string;
  readonly threadId: string;
  /** A review's copies: the row each mentioned seat received in the thread, by seat. */
  readonly copies?: ReadonlyArray<{ readonly nodeId: string; readonly messageId: string }>;
  /** A comment on the thread's subject: held at the resource, its notices already handed to delivery. */
  readonly comment?: true;
};
const refused = (reason: Refused["reason"], message: string): Refused => ({ ok: false, reason, message });

/**
 * Write the operator's mail into the seat's thread, to that seat alone. Every
 * check runs before the write.
 */
export const sendOperatorThreadMail = (send: OperatorThreadSendDecoded) =>
  Effect.gen(function* (): Effect.fn.Return<Refused | OperatorThreadWritten, unknown, ModelService | WorkService | WorkRepository | SqlClient.SqlClient> {
    const { canvasName, nodeId } = send;
    const { canvas, input } = yield* threadsInput(canvasName);
    const seat = canvas.nodes.get(asNodeId(nodeId));
    if (seat?.kind !== "agent") return refused("not-found", "No such seat.");
    const text = send.text.trim();
    const files = send.attachments ?? [];
    if (!text && files.length === 0) return refused("invalid", "Mail needs some text or a file.");

    const mentions = mentionedOnce(mentionsOf(text, (id) => canvas.nodes.get(id)?.kind))
      .flatMap((ref) => (ref.kind === "seat" && ref.nodeId !== nodeId ? [ref.nodeId as string] : []));
    const nameOf = (id: string): string => {
      const peer = canvas.nodes.get(asNodeId(id));
      return peer === undefined ? id : titleOf(peer);
    };
    const { review } = send;
    if (review !== undefined) {
      // A named anchor that is gone is refused, never read as the open field: that would widen reach to every agent.
      if (review.anchorNodeId !== undefined && !canvas.nodes.has(asNodeId(review.anchorNodeId))) {
        return refused("invalid", "The place this review was opened from is no longer on the canvas.");
      }
      // A review goes to, and copies, only the seats it can go to from where it was opened.
      const reachable = new Set(reviewCandidates(canvas, review.anchorNodeId).map((candidate) => candidate.nodeId));
      for (const id of [nodeId, ...mentions]) {
        if (!reachable.has(id)) return refused("invalid", `${nameOf(id)} cannot receive this review.`);
      }
      if (files.length > 0) return refused("invalid", "A review takes no files.");
    }

    // The thread: the parent's, the one named, or a new one rooted here.
    const threads = seatMailThreads(input, nodeId);
    let threadId: string | undefined;
    if (send.inReplyTo !== undefined) {
      const parent = threads
        .flatMap((thread) => seatMailThreadMessages(input, nodeId, thread.threadId))
        .find((message) => message.messageId === send.inReplyTo);
      if (parent === undefined) return refused("not-found", "That mail is not in this seat's threads.");
      if (send.threadId !== undefined && send.threadId !== parent.threadId) {
        return refused("invalid", "That mail is in another thread.");
      }
      threadId = parent.threadId;
    } else if (send.threadId !== undefined) {
      if (!threads.some((thread) => thread.threadId === send.threadId)) {
        return refused("not-found", "That thread is not one of this seat's.");
      }
      threadId = send.threadId;
    }

    // A reply in a subject thread is the operator's comment on the subject,
    // on the one comment path: held at the resource, its people told.
    const subject = threadId === undefined
      ? undefined
      : seatMailThreadMessages(input, nodeId, threadId).find((message) => message.subject !== undefined)?.subject;
    if (subject !== undefined && threadId !== undefined) {
      if (review !== undefined) return refused("invalid", "A review is not a comment on a resource.");
      if (files.length > 0) return refused("invalid", "A comment takes no files yet.");
      const base = {
        text,
        actor: { kind: "operator" as const },
        opId: OpId.make(ulid()),
        threadId: threadId as MailMessageId,
        ...(send.inReplyTo === undefined ? {} : { inReplyTo: send.inReplyTo as MailMessageId }),
      };
      // The seat whose thread the operator wrote in is told, beside the resource's people.
      // A task the board no longer holds takes no comment.
      const people = yield* Effect.result(subjectPeopleAt(canvas, canvasName, subject));
      if (people._tag === "Failure") return refused("not-found", "That task is no longer on its board.");
      const context = { canvas, canvasName, people: [asNodeId(nodeId), ...people.success] };
      const posted = yield* Effect.result(postSubjectComment(subjectReplyOf(subject, base), context));
      if (posted._tag === "Failure") {
        return refused(posted.failure.type === "ScopeError" ? "invalid" : "failed", posted.failure.type === "ScopeError" ? "A seat mentioned here cannot reach this resource." : "The comment could not be written.");
      }
      return { messageId: posted.success.messageId, threadId: posted.success.threadId, comment: true as const };
    }

    // Mail, not a comment: a seat the text links must be wired to this seat,
    // as the composer offers. A comment's mentions are the seats in reach of
    // its resource, checked on the comment path (03 section 3).
    if (review === undefined) {
      const wired = mentionableIn(canvas, nodeId);
      for (const id of mentions) {
        if (!wired.some((peer) => peer.nodeId === id)) {
          return refused("invalid", `${nameOf(id)} is not connected to ${titleOf(seat)}, so it cannot be mentioned here.`);
        }
      }
    }

    const sender = operatorActorRef(canvasName);
    const messageId = ulid();

    // The files the operator staged are claimed for this mail, and the mail
    // names them as main recorded them, never as the caller spelled them.
    const owner = operatorMailOwner(canvasName, nodeId, messageId);
    let claimedFiles: ReadonlyArray<ContentRef> = [];
    if (files.length > 0) {
      const content = yield* Effect.serviceOption(ContentService);
      if (Option.isNone(content)) return refused("failed", "The content store is unavailable.");
      const claimed = yield* Effect.result(claimOperatorAttachments(content.value, canvasName, files, owner));
      if (claimed._tag === "Failure") return refused("invalid", claimed.failure.message);
      claimedFiles = claimed.success;
    }
    const work = yield* WorkService;
    const write = (to: string, id: string, root: string | undefined, copyOf?: string) => (said: string, attachments: ReadonlyArray<ContentRef>) => work.workSystemMailboxNotify(
      canvasName,
      to,
      makeUserMessage({
        messageId: id,
        text: said,
        contextId: canvasName,
        metadata: {
          factoryMail: true,
          ...mailExtensionMetadata({
            mailKind: "prompt",
            fromSeat: sender.seatId,
            senderNodeId: sender.nodeId,
            senderName: "operator",
            senderGeneration: "operator",
            senderHarness: "unknown",
          }),
          // A new thread's root carries no threadId; its id is the thread.
          ...(root === undefined ? {} : { threadId: root }),
          ...(send.inReplyTo === undefined ? {} : { inReplyTo: send.inReplyTo }),
          ...(attachments.length === 0 ? {} : { attachments }),
          ...(review?.anchor === undefined ? {} : linesAnchorMetadata(review.anchor)),
          // A copy names the row it copies, so a mention in it counts once (backlinks).
          ...(copyOf === undefined ? {} : { copyOf }),
        },
      }),
    );
    // A row main will not write goes again with the text as a file.
    const mailed = yield* writeMailCarryingText(write(nodeId, messageId, threadId), { text, attachments: claimedFiles, owner, filesText: THREAD_TEXT_FILE_NOTE });
    const result = mailed.written;
    // The store's message is not passed on: it is not the operator's to read,
    // and nothing may carry the mail's text out of the mailbox.
    if (!result.ok) {
      if (mailed.attachments.length > 0) yield* releaseMailFiles(owner);
      return refused("failed", "The mail could not be written.");
    }
    const thread = threadId ?? result.data.messageId;
    // A review's mentioned seats receive the row in the same thread, each its
    // own. Each copy stands alone: the row went, so a copy that cannot be
    // written is logged and the send still answers for what landed.
    const copies: Array<{ readonly nodeId: string; readonly messageId: string }> = [];
    if (review !== undefined) {
      for (const to of mentions) {
        const copyId = reviewCopyId(result.data.messageId, asNodeId(to));
        const copyOwner = operatorMailOwner(canvasName, to, copyId);
        const copied = yield* writeMailCarryingText(write(to, copyId, thread, result.data.messageId), { text, attachments: [], owner: copyOwner, filesText: THREAD_TEXT_FILE_NOTE });
        if (!copied.written.ok) {
          yield* Effect.logWarning("a review row's copy was not written", { canvasName, row: result.data.messageId, seat: to });
          continue;
        }
        copies.push({ nodeId: to, messageId: copied.written.data.messageId });
      }
    }
    return { messageId: result.data.messageId, threadId: thread, ...(copies.length === 0 ? {} : { copies }) };
  });

/** After the write: delivery, in the protocol's three words. */
export const deliverOperatorThreadMail = async (
  canvasName: string,
  nodeId: string,
  sent: Refused | OperatorThreadWritten,
): Promise<OperatorThreadSent> => {
  if ("ok" in sent) return sent;
  // A comment is held at its resource; each seat it tells has its notice in delivery already.
  const state = sent.comment === true
    ? ("delivered" as const)
    : await messageDelivery.deliver(canvasName, nodeId, sent.messageId).catch(() => "failed" as const);
  // A review's copies go on their own; the send answers for the seat it was written to.
  for (const copy of sent.copies ?? []) {
    await messageDelivery.deliver(canvasName, copy.nodeId, copy.messageId).catch(() => "failed" as const);
  }
  return {
    ok: true,
    messageId: sent.messageId,
    threadId: sent.threadId,
    delivery: state === "delivered" ? "delivered" : state === "failed" ? "failed" : "waiting_for_seat",
  };
};
