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
import { ulid } from "ulid";
import { mailExtensionMetadata, type MailMessageId } from "@shared/crew";
import { mentionedOnce, mentionsOf } from "@shared/mention";
import { linesAnchorMetadata, threadSubjectOf, type ResourceSubject } from "@shared/thread-subject";
import { reviewCandidates } from "@shared/review-candidates";
import { OpId } from "@shared/work-ids";
import { asNodeId, type Canvas } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { makeUserMessage } from "@shared/task";
import {
  seatMailThreadMessages,
  seatMailThreadMessagesPage,
  seatMailThreads,
  seatMailThreadsPage,
  type MailThreadsInput,
  type MentionableSeat,
  type OperatorThreadSendDecoded,
  type OperatorThreadSent,
} from "@shared/mail-threads";
import { operatorActorRef } from "@shared/work-reference";
import { ModelService } from "../model/service";
import type { ContentOwner } from "../content/manifest";
import type { ContentRef } from "@shared/wire/content-ref";
import { messageDelivery } from "./message-delivery";
import { writeMailCarryingText } from "../content/mail-text-file";
import { claimOperatorAttachments, operatorMailOwner } from "../content/operator-attachments";
import { ContentService } from "../content/service";
import { heldMailbox } from "./mailbox-cache";
import type { WorkRepository } from "./repository";
import { WorkService } from "./service";
import { postSubjectComment } from "./subject-comment";
import { subjectNameAt, subjectPeopleAt } from "./subject-people";

/** One key per resource, whatever place on it a thread hangs. */
const subjectKey = (subject: ResourceSubject): string =>
  subject.kind === "task" ? `task:${subject.nodeId}:${subject.taskId}`
  : subject.kind === "artifact" ? `artifact:${subject.nodeId}:${subject.artifactId}`
  : `page:${subject.nodeId}`;

const agentSeatsOf = (canvas: Canvas) => [...canvas.nodes.values()].filter((node) => node.kind === "agent");

/** Every agent seat's mailbox on the canvas, with seat names. */
const threadsInput = (canvasName: string) =>
  Effect.gen(function* () {
    const canvas = yield* (yield* ModelService).canvas(canvasName);
    const seats = agentSeatsOf(canvas);
    const mailboxes = yield* Effect.forEach(seats, (seat) =>
      heldMailbox(canvasName, seat.id).pipe(Effect.map((messages) => ({ nodeId: seat.id as string, messages }))),
    );
    const names = new Map(seats.map((seat) => [seat.id as string, titleOf(seat)]));
    // Each subject held is named once: a task thread is listed as the task.
    const subjects = new Map<string, ResourceSubject>();
    for (const mailbox of mailboxes) {
      for (const row of mailbox.messages) {
        const subject = threadSubjectOf(row);
        if (subject !== undefined) subjects.set(subjectKey(subject), subject);
      }
    }
    const subjectNames = new Map<string, string>();
    yield* Effect.forEach(subjects, ([key, subject]) =>
      Effect.map(subjectNameAt(canvas, canvasName, subject), (name) => {
        if (name !== undefined) subjectNames.set(key, name);
      }),
    );
    const input: MailThreadsInput = {
      mailboxes,
      nameOf: (nodeId) => names.get(nodeId),
      subjectNameOf: (subject) => subjectNames.get(subjectKey(subject)),
    };
    return { canvas, input };
  });

export const seatThreads = (canvasName: string, nodeId: string) =>
  Effect.map(threadsInput(canvasName), ({ input }) => seatMailThreads(input, nodeId));

export const seatThreadMessages = (canvasName: string, nodeId: string, threadId: string) =>
  Effect.map(threadsInput(canvasName), ({ input }) => seatMailThreadMessages(input, nodeId, threadId));

/** One page of the seat's threads: the desktop's list, never the whole of it. */
export const seatThreadsPage = (canvasName: string, nodeId: string, page: { limit?: number; after?: string }) =>
  Effect.map(threadsInput(canvasName), ({ input }) => seatMailThreadsPage(input, nodeId, page));

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
  Effect.gen(function* (): Effect.fn.Return<Refused | OperatorThreadWritten, unknown, ModelService | WorkService | WorkRepository> {
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
      const posted = yield* Effect.result(postSubjectComment(
        subject.kind === "task"
          ? { ...base, subject: { kind: "task", nodeId: subject.nodeId, taskId: subject.taskId } }
          : subject.kind === "artifact"
            ? { ...base, subject: { kind: "artifact", nodeId: subject.nodeId, artifactId: subject.artifactId } }
            : { ...base, subject: { kind: "page", nodeId: subject.nodeId } },
        context,
      ));
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
    // A review's mentioned seats receive the row in the same thread, each its own.
    const copies: Array<{ readonly nodeId: string; readonly messageId: string }> = [];
    if (review !== undefined) {
      for (const to of mentions) {
        const copyId = ulid();
        const copyOwner = operatorMailOwner(canvasName, to, copyId);
        const copied = yield* writeMailCarryingText(write(to, copyId, thread, result.data.messageId), { text, attachments: [], owner: copyOwner, filesText: THREAD_TEXT_FILE_NOTE });
        if (!copied.written.ok) return refused("failed", `The mail was written, but its copy to ${nameOf(to)} could not be.`);
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
