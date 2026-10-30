/**
 * What a paired phone may change, done exactly as the desktop does it:
 *
 * - answering a signal runs the same `answerAgentSignal` program (the answer
 *   becomes operator mail naming the signal, then the signal is answered),
 *   notes it in the raised-hands index, broadcasts it to the desktop, and
 *   types the mail into the seat through `messageDelivery`; a quiet answer
 *   runs it silent, as the desktop quiet send does: no mail, the seat is not
 *   woken, and an empty one is recorded as an acknowledgement;
 * - dismissing runs `dismissAgentSignal` with the same bookkeeping;
 * - mail is operator mail appended with `workSystemMailboxNotify` and handed
 *   to `messageDelivery`, which starts a stopped seat on a playing canvas.
 *
 * Every write passes the main authoring gate under its own label, so quit
 * drains and refuses phone writes like any other.
 */

import { Effect } from "effect";
import type { AgentSignal } from "@shared/agent-signals";
import type { ContentRef } from "@shared/wire/content-ref";
import { asNodeId } from "@shared/model";
import { mailExtensionMetadata } from "@shared/crew";
import { makeUserMessage } from "@shared/task";
import { operatorActorRef } from "@shared/work-reference";
import { ulid } from "ulid";
import { CompanionRuntime, showCompanionSignal } from "./runtime";
import { ModelService } from "../model/service";
import { mainAuthoringGate } from "../main-authoring-gate";
import { AgentSignalRepository } from "../signals/repository";
import { answerAgentSignal, dismissAgentSignal, replyAgentSignal } from "../signals/operator";
import { raisedHands } from "../signals/raised-hands";
import { liveArtifactPorts } from "../work/artifact-control";
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

const broadcastSignal = showCompanionSignal;

const currentSignal = (signalId: string): Promise<AgentSignal | undefined> =>
  CompanionRuntime.runPromise(
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
  quiet = false,
  attachments: ReadonlyArray<ContentRef> = [],
): Promise<OperatorActionResult<AgentSignal>> => {
  const result = await mainAuthoringGate
    .run("companion.signal-answer", () =>
      CompanionRuntime.runPromise(answerAgentSignal(signalId, text, { silent: quiet, attachments })),
    )
    .catch((error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : "answer failed" }));
  if (!result.ok) return refusal(signalId, result.message);
  raisedHands.note(result.signal);
  broadcastSignal(result.signal);
  if (result.messageId !== undefined) {
    void messageDelivery.deliver(result.signal.canvasName, result.signal.nodeId, result.messageId).catch(() => undefined);
  }
  return { ok: true, value: result.signal };
};

/**
 * A document handed in on an artifact-form signal, as the desktop's own
 * `agentSignalReply`: the same `replyAgentSignal` rules `minWords`, makes the
 * document in the form's Artifacts node, and the reply's own id is the write's
 * op id, so a resent hand-in writes one document. Anything the ruler refuses
 * is `invalid` with its sentence; only a gone or closed signal reads as
 * not-found or conflict.
 */
export const replySignalArtifactAsOperator = async (
  signalId: string,
  markdown: string,
  replyId: string,
): Promise<OperatorActionResult<AgentSignal>> => {
  const before = await currentSignal(signalId);
  if (before === undefined) return { ok: false, reason: "not-found", message: `No signal ${signalId}.` };
  if (before.state !== "open") return { ok: false, reason: "conflict", message: `That signal is already ${before.state}.`, signal: before };
  const result = await mainAuthoringGate
    .run("companion.signal-reply", () =>
      CompanionRuntime.runPromise(
        replyAgentSignal(signalId, { kind: "artifact", markdown, replyId }, {
          topology: (canvasName: string) =>
            Effect.tryPromise({
              try: () => CompanionRuntime.runPromise(Effect.flatMap(WorkService, (work) => work.readTopology(canvasName))),
              catch: () => ({
                type: "InternalError" as const,
                message: `canvas ${canvasName} could not be read`,
                details: { retryable: true },
              }),
            }).pipe(Effect.map((read) => read.canvas)),
          artifacts: liveArtifactPorts,
        }),
      ),
    )
    .catch((error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : "reply failed" }));
  if (!result.ok) return { ok: false, reason: "invalid", message: result.message.slice(0, 500) };
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
    .run("companion.signal-dismiss", () => CompanionRuntime.runPromise(dismissAgentSignal(signalId)))
    .catch((error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : "dismiss failed" }));
  if (!result.ok) return refusal(signalId, result.message);
  raisedHands.note(result.signal);
  broadcastSignal(result.signal);
  return { ok: true, value: result.signal };
};
