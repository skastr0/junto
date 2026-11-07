/**
 * The core's handlers of the signals group (src/contract/core/signals.ts): a
 * canvas's signals, an answer typed into its seat, a handed-in reply, a
 * dismissal, and the value a secret form asks for. Each answer is plain
 * data; the window hears of a change through the store's own change, pushed
 * from one place, so these only answer the caller.
 *
 * The secret write runs its tool (`op`, `security`, `secret-tool`) on the
 * core's own process plane with the core's login PATH, as the region secret
 * store does.
 */
import { Effect, Schema } from "effect";
import { homedir } from "node:os";
import { resolveJuntoHome } from "@shared/junto-home";
import { SignalsRpcs, SignalsUnavailable } from "../../contract/core/signals";
import {
  answerAgentSignal,
  dismissAgentSignal,
  listCanvasAgentSignals,
  replyAgentSignal,
} from "../signals/operator";
import { putSignalSecret } from "../vault/secret-put";
import { liveArtifactPorts } from "../work/artifact-control";
import { messageDelivery } from "../work/message-delivery";
import { WorkService } from "../work/service";
import { resolvedSpawnEnv } from "../adapters/spawn-env";
import { runTool } from "../region-env/tool";

/** A delivery this process could not make; the mail waits in the mailbox either way. */
class SeatDeliveryLost extends Schema.TaggedError<SeatDeliveryLost>()("SeatDeliveryLost", {
  message: Schema.String,
}) {}

/** The store failed, in its own words, or its tag when it has none. */
const unavailable = (error: unknown): SignalsUnavailable => {
  const message = error instanceof Error ? error.message : String(error);
  const tag = typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "the signals could not be read";
  return new SignalsUnavailable({ message: message.length > 0 ? message : tag });
};

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

export const SignalsHandlers = SignalsRpcs.toLayer({
  SignalsList: ({ canvasName }) => listCanvasAgentSignals(canvasName).pipe(Effect.mapError(unavailable)),
  SignalsAnswer: ({ signalId, text, silent, attachments }) =>
    answerAgentSignal(signalId, text, { silent, attachments }).pipe(Effect.tap(deliverIntoSeat), Effect.mapError(unavailable)),
  SignalsReply: ({ signalId, reply }) =>
    Effect.flatMap(WorkService, (work) =>
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
    ).pipe(Effect.tap(deliverIntoSeat), Effect.mapError(unavailable)),
  SignalsDismiss: ({ signalId }) => dismissAgentSignal(signalId).pipe(Effect.mapError(unavailable)),
  SignalsSecretPut: ({ request }) =>
    putSignalSecret(request, {
      home: resolveJuntoHome(),
      userHome: homedir(),
      run: runTool,
      path: async () => (await resolvedSpawnEnv()).PATH,
    }).pipe(Effect.tap(deliverIntoSeat), Effect.mapError(unavailable)),
});
