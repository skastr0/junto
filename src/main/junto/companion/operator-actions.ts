/**
 * What a paired phone may change, done exactly as the desktop does it:
 *
 * - answering a signal runs the same `answerAgentSignal` program (the answer
 *   becomes operator mail naming the signal, then the signal is answered),
 *   notes it in the raised-hands index, broadcasts it to the desktop, and
 *   types the mail into the seat through `messageDelivery`;
 * - dismissing runs `dismissAgentSignal` with the same bookkeeping;
 * - mail is operator mail appended with `workSystemMailboxNotify` and handed
 *   to `messageDelivery`, which starts a stopped seat on a playing canvas.
 *
 * Every write passes the main authoring gate under its own label, so quit
 * drains and refuses phone writes like any other.
 */

import { BrowserWindow } from "electron";
import { Effect } from "effect";
import type { AgentSignal } from "@shared/agent-signals";
import { actorDeliverySurfaceOf } from "@shared/actor-surface";
import { mailExtensionMetadata } from "@shared/crew";
import { IPC_CHANNELS } from "@shared/ipc";
import { makeUserMessage } from "@shared/task";
import { operatorActorRef } from "@shared/work-reference";
import { ulid } from "ulid";
import { AppRuntime } from "../../runtime";
import { CanvasesService } from "../canvases";
import { mainAuthoringGate } from "../main-authoring-gate";
import { SettingsService } from "../settings/service";
import { AgentSignalRepository } from "../signals/repository";
import { answerAgentSignal, dismissAgentSignal } from "../signals/operator";
import { raisedHands } from "../signals/raised-hands";
import { isTrustedMainWebContents } from "../trusted-main-webcontents";
import { messageDelivery } from "../work/message-delivery";
import { WorkService } from "../work/service";

export type OperatorActionResult<A> =
  | { readonly ok: true; readonly value: A }
  | {
      readonly ok: false;
      readonly reason: "not-found" | "conflict" | "invalid" | "failed";
      readonly message: string;
      readonly signal?: AgentSignal;
    };

const broadcastSignal = (signal: AgentSignal): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed() || !isTrustedMainWebContents(window.webContents)) continue;
    window.webContents.send(IPC_CHANNELS.agentSignal, signal);
  }
};

const currentSignal = (signalId: string): Promise<AgentSignal | undefined> =>
  AppRuntime.runPromise(
    Effect.flatMap(AgentSignalRepository, (signals) => signals.get(signalId)).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    ),
  );

/** Why a signal write was refused, in the protocol's terms. */
const refusal = async (signalId: string, message: string): Promise<OperatorActionResult<never>> => {
  const signal = await currentSignal(signalId);
  if (signal === undefined) return { ok: false, reason: "not-found", message: `No signal ${signalId}.` };
  if (signal.state !== "open") return { ok: false, reason: "conflict", message: `That signal is already ${signal.state}.`, signal };
  return { ok: false, reason: "failed", message };
};

export const answerSignalAsOperator = async (
  signalId: string,
  text: string,
): Promise<OperatorActionResult<AgentSignal>> => {
  const result = await mainAuthoringGate
    .run("companion.signal-answer", () => AppRuntime.runPromise(answerAgentSignal(signalId, text)))
    .catch((error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : "answer failed" }));
  if (!result.ok) return refusal(signalId, result.message);
  raisedHands.note(result.signal);
  broadcastSignal(result.signal);
  if (result.messageId !== undefined) {
    void messageDelivery.deliver(result.signal.canvasName, result.signal.nodeId, result.messageId).catch(() => undefined);
  }
  return { ok: true, value: result.signal };
};

export const dismissSignalAsOperator = async (signalId: string): Promise<OperatorActionResult<AgentSignal>> => {
  const before = await currentSignal(signalId);
  if (before === undefined) return { ok: false, reason: "not-found", message: `No signal ${signalId}.` };
  if (before.state !== "open") return { ok: false, reason: "conflict", message: `That signal is already ${before.state}.`, signal: before };
  const result = await mainAuthoringGate
    .run("companion.signal-dismiss", () => AppRuntime.runPromise(dismissAgentSignal(signalId)))
    .catch((error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : "dismiss failed" }));
  if (!result.ok) return refusal(signalId, result.message);
  raisedHands.note(result.signal);
  broadcastSignal(result.signal);
  return { ok: true, value: result.signal };
};

export type SentMail = {
  readonly messageId: string;
  readonly at: number;
  readonly delivery: "delivered" | "waiting_for_seat" | "failed";
};

/** Operator mail to one seat, through the desktop's delivery path. */
export const sendOperatorMail = async (
  canvasName: string,
  nodeId: string,
  text: string,
): Promise<OperatorActionResult<SentMail>> => {
  const body = text.trim();
  if (!body) return { ok: false, reason: "invalid", message: "Mail needs some text." };
  const sender = operatorActorRef(canvasName);
  const messageId = ulid();
  const message = makeUserMessage({
    messageId,
    text: body,
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
    },
  });
  type Appended =
    | { readonly ok: true; readonly messageId: string }
    | { readonly ok: false; readonly reason: "not-found" | "invalid" | "failed"; readonly message: string };
  const appended: Appended = await mainAuthoringGate
    .run("companion.mail-send", () =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const settings = yield* SettingsService;
          if ((yield* settings.get).station.role === "remote") {
            return { ok: false as const, reason: "invalid" as const, message: "Mail is sent from the Command Center." };
          }
          const canvases = yield* CanvasesService;
          const read = yield* Effect.result(canvases.read(canvasName));
          if (read._tag === "Failure") return { ok: false as const, reason: "not-found" as const, message: "No such canvas." };
          const node = read.success.doc.nodes.find((candidate) => candidate.id === nodeId);
          if (node === undefined || actorDeliverySurfaceOf(node) === undefined) {
            return { ok: false as const, reason: "not-found" as const, message: "No such seat." };
          }
          const work = yield* WorkService;
          const result = yield* work.workSystemMailboxNotify(canvasName, nodeId, message);
          return result.ok
            ? { ok: true as const, messageId: result.data.messageId }
            : { ok: false as const, reason: "failed" as const, message: result.message };
        }),
      ),
    )
    .catch((error: unknown) => ({
      ok: false as const,
      reason: "failed" as const,
      message: error instanceof Error ? error.message : "mail failed",
    }));
  if (!appended.ok) return appended;
  const state = await messageDelivery.deliver(canvasName, nodeId, appended.messageId).catch(() => "failed" as const);
  return {
    ok: true,
    value: {
      messageId: appended.messageId,
      at: Date.now(),
      delivery: state === "delivered" ? "delivered" : state === "failed" ? "failed" : "waiting_for_seat",
    },
  };
};
