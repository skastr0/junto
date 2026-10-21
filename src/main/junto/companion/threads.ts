/**
 * The phone's mail threads: `threads.list`, `thread.get` and `mail.send`, on
 * the desktop's own thread reads and operator send (work/operator-threads.ts).
 *
 * A phone's mail goes to the seat it is written to and no one else; a
 * mention is the link in its text. The send runs under the main authoring gate as
 * `companion.mail-send`, as the phone's mail always has. Every refusal is a
 * fixed sentence (companion-threads.ts).
 */
import { Effect, Result, Schema } from "effect";
import { outcomeFail, outcomeOk, type CompanionBackend, type CompanionOutcome } from "@shared/companion-core";
import { companionSendRefusal, companionThreadMessages, companionThreads } from "@shared/companion-threads";
import { OperatorThreadSend } from "@shared/mail-threads";
import { messageIdTimeMs } from "@shared/message-delivery";
import { asNodeId } from "@shared/model";
import { AppRuntime } from "../../runtime";
import { mainAuthoringGate } from "../main-authoring-gate";
import { ModelService } from "../model/service";
import { deliverOperatorThreadMail, seatThreadMessages, seatThreads, sendOperatorThreadMail } from "../work/operator-threads";

/** Undefined when the canvas holds this agent seat; otherwise the refusal. */
const seatMissing = (canvasName: string, nodeId: string): Promise<CompanionOutcome<never> | undefined> =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const read = yield* Effect.result((yield* ModelService).canvas(canvasName));
      if (read._tag === "Failure") return outcomeFail("not-found", "No such canvas.");
      if (read.success.nodes.get(asNodeId(nodeId))?.kind !== "agent") return outcomeFail("not-found", "No such seat.");
      return undefined;
    }),
  );

export const companionThreadBackend: Pick<CompanionBackend, "threads" | "thread" | "mailSend"> = {
  threads: async (canvasName, nodeId) => {
    const missing = await seatMissing(canvasName, nodeId);
    if (missing !== undefined) return missing;
    return outcomeOk(companionThreads(await AppRuntime.runPromise(seatThreads(canvasName, nodeId))));
  },

  thread: async (canvasName, nodeId, threadId) => {
    const missing = await seatMissing(canvasName, nodeId);
    if (missing !== undefined) return missing;
    const messages = await AppRuntime.runPromise(seatThreadMessages(canvasName, nodeId, threadId));
    if (messages.length === 0) return outcomeFail("not-found", "That thread is not one of this seat's.");
    return outcomeOk(companionThreadMessages(messages));
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
      .run("companion.mail-send", () => AppRuntime.runPromise(sendOperatorThreadMail(decoded.success)))
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
