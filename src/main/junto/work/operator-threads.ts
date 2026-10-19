/**
 * The operator's side of mail threads: a seat's threads and one thread's
 * messages, read from the mailboxes through the shared derivation, the seats
 * a mention may name, and the operator's send into a thread.
 *
 * Operator mail is what the desktop and the phone already write: one row in
 * each addressed seat's mailbox through `workSystemMailboxNotify`, handed to
 * `messageDelivery`. A send with mentions writes one row per seat, sharing a
 * `sendId` and the thread, so the derivation reads it as one mail.
 */
import { Effect } from "effect";
import { ulid } from "ulid";
import { mailExtensionMetadata } from "@shared/crew";
import { asNodeId, type Canvas } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { makeUserMessage } from "@shared/task";
import {
  seatMailThreadMessages,
  seatMailThreads,
  type MailThreadsInput,
  type MentionableSeat,
  type OperatorThreadSend,
  type OperatorThreadSent,
} from "@shared/mail-threads";
import { operatorActorRef } from "@shared/work-reference";
import { ModelService } from "../model/service";
import { messageDelivery } from "./message-delivery";
import { WorkService } from "./service";

const agentSeatsOf = (canvas: Canvas) => [...canvas.nodes.values()].filter((node) => node.kind === "agent");

/** Every agent seat's mailbox on the canvas, with seat names. */
const threadsInput = (canvasName: string) =>
  Effect.gen(function* () {
    const canvas = yield* (yield* ModelService).canvas(canvasName);
    const work = yield* WorkService;
    const seats = agentSeatsOf(canvas);
    const mailboxes = yield* Effect.forEach(seats, (seat) =>
      work.readMailbox(canvasName, seat.id).pipe(Effect.map((messages) => ({ nodeId: seat.id as string, messages }))),
    );
    const names = new Map(seats.map((seat) => [seat.id as string, titleOf(seat)]));
    const input: MailThreadsInput = { mailboxes, nameOf: (nodeId) => names.get(nodeId) };
    return { canvas, input };
  });

export const seatThreads = (canvasName: string, nodeId: string) =>
  Effect.map(threadsInput(canvasName), ({ input }) => seatMailThreads(input, nodeId));

export const seatThreadMessages = (canvasName: string, nodeId: string, threadId: string) =>
  Effect.map(threadsInput(canvasName), ({ input }) => seatMailThreadMessages(input, nodeId, threadId));

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

export const mentionableSeats = (canvasName: string, nodeId: string) =>
  Effect.map(Effect.flatMap(ModelService, (model) => model.canvas(canvasName)), (canvas) => mentionableIn(canvas, nodeId));

type Refused = Extract<OperatorThreadSent, { ok: false }>;
/** Rows written, before delivery. */
export type OperatorThreadWritten = {
  readonly leadId: string;
  readonly threadId: string;
  readonly written: ReadonlyArray<{ readonly nodeId: string; readonly messageId: string; readonly ok: boolean }>;
};
const refused = (reason: Refused["reason"], message: string): Refused => ({ ok: false, reason, message });

/**
 * Write the operator's mail into the seat's thread and to each mentioned
 * seat, then hand every row to delivery. Every check runs before any write.
 */
export const sendOperatorThreadMail = (send: OperatorThreadSend) =>
  Effect.gen(function* (): Effect.fn.Return<Refused | OperatorThreadWritten, unknown, ModelService | WorkService> {
    const { canvasName, nodeId } = send;
    const { canvas, input } = yield* threadsInput(canvasName);
    const seat = canvas.nodes.get(asNodeId(nodeId));
    if (seat?.kind !== "agent") return refused("not-found", "No such seat.");
    const text = send.text.trim();
    if (!text) return refused("invalid", "Mail needs some text.");

    const wired = mentionableIn(canvas, nodeId);
    const mentions = [...new Set(send.mentions ?? [])].filter((id) => id !== nodeId);
    for (const id of mentions) {
      if (!wired.some((peer) => peer.nodeId === id)) {
        const peer = canvas.nodes.get(asNodeId(id));
        const name = peer === undefined ? id : titleOf(peer);
        return refused("invalid", `${name} is not connected to ${titleOf(seat)}, so it cannot be mentioned here.`);
      }
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

    const sender = operatorActorRef(canvasName);
    const leadId = ulid();
    const thread = threadId ?? leadId;
    const work = yield* WorkService;
    const written: Array<{ nodeId: string; messageId: string; ok: boolean }> = [];
    for (const target of [nodeId, ...mentions]) {
      const messageId = target === nodeId ? leadId : ulid();
      const result = yield* work.workSystemMailboxNotify(
        canvasName,
        target,
        makeUserMessage({
          messageId,
          text,
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
            ...(messageId === thread ? {} : { threadId: thread }),
            ...(send.inReplyTo === undefined ? {} : { inReplyTo: send.inReplyTo }),
            ...(mentions.length === 0 ? {} : { sendId: leadId }),
          },
        }),
      );
      if (!result.ok && target === nodeId) return refused("failed", result.message);
      written.push({ nodeId: target, messageId: result.ok ? result.data.messageId : messageId, ok: result.ok });
    }
    return { leadId, threadId: thread, written };
  });

/** After the writes: delivery for each row, in the protocol's three words. */
export const deliverOperatorThreadMail = async (
  canvasName: string,
  sent: Refused | OperatorThreadWritten,
): Promise<OperatorThreadSent> => {
  if ("ok" in sent) return sent;
  const delivery = await Promise.all(
    sent.written.map(async ({ nodeId, messageId, ok }) => {
      if (!ok) return { nodeId, messageId, state: "failed" as const };
      const state = await messageDelivery.deliver(canvasName, nodeId, messageId).catch(() => "failed" as const);
      return {
        nodeId,
        messageId,
        state: state === "delivered" ? ("delivered" as const) : state === "failed" ? ("failed" as const) : ("waiting_for_seat" as const),
      };
    }),
  );
  return { ok: true, messageId: sent.leadId, threadId: sent.threadId, delivery };
};
