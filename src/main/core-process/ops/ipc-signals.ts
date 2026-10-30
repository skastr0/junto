/**
 * The operator's signals (junto/ipc.ts): a canvas's signals, an answer typed
 * into its seat, a handed-in reply, a dismissal, and the value a secret form
 * asks for. Each answer is plain data; the window hears of a change through
 * the store's own change, pushed from one place, so these only answer the
 * caller.
 *
 * `op` and the login shell are main's, so the secret write asks main for the
 * two it cannot do here (a tool run and the login PATH); the value never
 * crosses that call, only the tool call does.
 */
import { Effect, Schema } from "effect";
import { homedir } from "node:os";
import type { AgentSignal } from "@shared/agent-signals";
import { resolveJuntoHome } from "@shared/junto-home";
import type { ContentRef } from "@shared/wire/content-ref";
import type { SignalReply } from "@shared/signal-reply";
import type { SignalSecretPutRequest, SignalSecretPutResult } from "@shared/vault";
import { AgentSignalRepository } from "../../junto/signals/repository";
import {
  answerAgentSignal,
  dismissAgentSignal,
  listCanvasAgentSignals,
  replyAgentSignal,
  type SignalOperatorResult,
} from "../../junto/signals/operator";
import { putSignalSecret } from "../../junto/vault/secret-put";
import { liveArtifactPorts } from "../../junto/work/artifact-control";
import { messageDelivery } from "../../junto/work/message-delivery";
import { WorkService } from "../../junto/work/service";
import { host } from "../host-ops";
import { coreOps, type CoreOp } from "../ops";

declare module "../ops" {
  interface CoreOps {
    "ipc.signals.list": CoreOp<{ readonly canvasName: string }, ReadonlyArray<AgentSignal>>;
    "ipc.signals.answer": CoreOp<
      {
        readonly signalId: string;
        readonly text: string;
        readonly silent: boolean;
        readonly attachments: ReadonlyArray<ContentRef>;
      },
      SignalOperatorResult
    >;
    "ipc.signals.reply": CoreOp<
      { readonly signalId: string; readonly reply: SignalReply },
      SignalOperatorResult
    >;
    "ipc.signals.dismiss": CoreOp<{ readonly signalId: string }, SignalOperatorResult>;
    "ipc.signals.secretPut": CoreOp<
      { readonly request: SignalSecretPutRequest },
      SignalSecretPutResult
    >;
  }
}

/** A delivery this process could not make; the mail waits in the mailbox either way. */
class SeatDeliveryLost extends Schema.TaggedError<SeatDeliveryLost>()("SeatDeliveryLost", {
  message: Schema.String,
}) {}

/**
 * Type an answer's mail into its seat here, where delivery is configured
 * (core-runtime.ts). Main has no transport, so its call returned waiting; a
 * delivery that cannot land now is left to the boot scan and the seat-live
 * events, as every other held line is.
 */
const deliverIntoSeat = (answer: {
  readonly ok: boolean;
  readonly signal?: { readonly canvasName: string; readonly nodeId: string };
  readonly messageId?: string;
}): Effect.Effect<void> => {
  if (!answer.ok || answer.signal === undefined || answer.messageId === undefined) return Effect.void;
  const { canvasName, nodeId } = answer.signal;
  const messageId = answer.messageId;
  return Effect.tryPromise({
    try: () => messageDelivery.deliver(canvasName, nodeId, messageId),
    catch: (cause) => new SeatDeliveryLost({ message: cause instanceof Error ? cause.message : String(cause) }),
  }).pipe(Effect.ignore);
};

coreOps({
  "ipc.signals.list": ({ canvasName }) => listCanvasAgentSignals(canvasName),
  "ipc.signals.answer": ({ signalId, text, silent, attachments }) =>
    Effect.tap(answerAgentSignal(signalId, text, { silent, attachments }), deliverIntoSeat),
  "ipc.signals.reply": ({ signalId, reply }) =>
    Effect.tap(Effect.flatMap(WorkService, (work) =>
      replyAgentSignal(signalId, reply, {
        topology: (canvasName) =>
          work.readTopology(canvasName).pipe(
            Effect.map((read) => read.canvas),
            Effect.mapError(() => ({
              type: "InternalError" as const,
              message: `canvas ${canvasName} could not be read`,
              details: { retryable: true },
            })),
          ),
        artifacts: liveArtifactPorts,
      }),
    ), deliverIntoSeat),
  "ipc.signals.dismiss": ({ signalId }) => dismissAgentSignal(signalId),
  "ipc.signals.secretPut": ({ request }) =>
    Effect.tap(putSignalSecret(request, {
      home: resolveJuntoHome(),
      userHome: homedir(),
      run: (call) => host.call("signals.tool.run", { call }),
      path: () => host.call("signals.tool.path", {}),
    }), deliverIntoSeat),
});
