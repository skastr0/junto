/**
 * The phone's mail threads: `threads.list`, `thread.get`, `threads.read` and
 * `mail.send`, on the desktop's own thread reads, read points and operator
 * send (work/operator-threads.ts, work/mail-reads.ts). One read point per
 * thread, shared with the desktop: a thread read on either reads on both.
 *
 * A phone's mail goes to the seat it is written to and no one else; a
 * mention is the link in its text. The send runs under the main authoring gate as
 * `companion.mail-send`, as the phone's mail always has. Every refusal is a
 * fixed sentence (companion-threads.ts).
 */
import { Effect, Result, Schema } from "effect";
import { outcomeFail, outcomeOk, type CompanionBackend, type CompanionOutcome } from "@shared/companion-core";
import { companionSendRefusal, companionThreadPage, companionThreadRead, companionThreadsPage } from "@shared/companion-threads";
import { OperatorThreadSend, seatMailThreadEntries, type MailThreadsInput } from "@shared/mail-threads";
import { messageIdTimeMs } from "@shared/message-delivery";
import { asNodeId } from "@shared/model";
import { CompanionRuntime } from "./runtime";
import { mainAuthoringGate } from "../main-authoring-gate";
import { ModelService } from "../model/service";
import { markRead, readPoints } from "../work/mail-reads";
import { deliverOperatorThreadMail, seatThreadsInput, sendOperatorThreadMail } from "../work/operator-threads";

/** Undefined when the canvas holds this agent seat; otherwise the refusal. */
const seatMissing = (canvasName: string, nodeId: string): Promise<CompanionOutcome<never> | undefined> =>
  CompanionRuntime.runPromise(
    Effect.gen(function* () {
      const read = yield* Effect.result((yield* ModelService).canvas(canvasName));
      if (read._tag === "Failure") return outcomeFail("not-found", "No such canvas.");
      if (read.success.nodes.get(asNodeId(nodeId))?.kind !== "agent") return outcomeFail("not-found", "No such seat.");
      return undefined;
    }),
  );

/** A seat's threads with the operator's read points in them, so each summary counts its unread. */
const readThreadsInput = (canvasName: string, nodeId: string): Promise<MailThreadsInput> =>
  CompanionRuntime.runPromise(
    Effect.gen(function* () {
      const input = yield* seatThreadsInput(canvasName);
      const points = yield* readPoints(canvasName, nodeId);
      return { ...input, readPointOf: (threadId: string) => points.get(threadId) };
    }),
  );

export const companionThreadBackend: Pick<CompanionBackend, "threads" | "thread" | "threadRead" | "mailSend"> = {
  threads: async (canvasName, nodeId, page) => {
    const missing = await seatMissing(canvasName, nodeId);
    if (missing !== undefined) return missing;
    return outcomeOk(companionThreadsPage(await readThreadsInput(canvasName, nodeId), nodeId, page));
  },

  thread: async (canvasName, nodeId, threadId, page) => {
    const missing = await seatMissing(canvasName, nodeId);
    if (missing !== undefined) return missing;
    const thread = companionThreadPage(await CompanionRuntime.runPromise(seatThreadsInput(canvasName)), nodeId, threadId, page);
    if (thread === undefined) return outcomeFail("not-found", "That thread is not one of this seat's.");
    return outcomeOk(thread);
  },

  threadRead: async (canvasName, nodeId, threadId, through) => {
    const missing = await seatMissing(canvasName, nodeId);
    if (missing !== undefined) return missing;
    const messages = seatMailThreadEntries(await CompanionRuntime.runPromise(seatThreadsInput(canvasName)), nodeId).get(threadId);
    if (messages === undefined) return outcomeFail("not-found", "That thread is not one of this seat's.");
    if (through !== undefined && !messages.some((message) => message.messageId === through)) {
      return outcomeFail("invalid", "That mail is not in this thread.");
    }
    const point = await CompanionRuntime.runPromise(markRead(canvasName, nodeId, threadId, through));
    if (point === undefined) return outcomeFail("internal", "The thread could not be marked read.");
    const read = companionThreadRead(await readThreadsInput(canvasName, nodeId), nodeId, threadId);
    return read === undefined ? outcomeFail("not-found", "That thread is not one of this seat's.") : outcomeOk(read);
  },

  mailSend: async (canvasName, nodeId, text, thread = {}) => {
    const missing = await seatMissing(canvasName, nodeId);
    if (missing !== undefined) return missing;
    const decoded = Schema.decodeUnknownResult(OperatorThreadSend, { onExcessProperty: "error" })({
      canvasName,
      nodeId,
      text,
      ...thread,
    });
    if (Result.isFailure(decoded)) return outcomeFail("invalid", "That mail could not be read.");
    const written = await mainAuthoringGate
      .run("companion.mail-send", () => CompanionRuntime.runPromise(sendOperatorThreadMail(decoded.success)))
      .catch(() => ({ ok: false as const, reason: "failed" as const, message: "" }));
    const sent = await deliverOperatorThreadMail(canvasName, nodeId, written);
    if (!sent.ok) {
      return outcomeFail(sent.reason === "failed" ? "internal" : sent.reason, companionSendRefusal(sent.reason, sent.message));
    }
    return outcomeOk({
      messageId: sent.messageId,
      canvasName,
      nodeId,
      direction: "to_seat" as const,
      from: { kind: "operator" as const },
      text: text.trim(),
      at: messageIdTimeMs(sent.messageId) ?? Date.now(),
      delivery: sent.delivery,
      threadId: sent.threadId,
      ...(thread.inReplyTo === undefined ? {} : { inReplyTo: thread.inReplyTo }),
    });
  },
};
