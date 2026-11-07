/**
 * The core's handlers for the work socket's overseer and overseer.live ops (`OverseerRpcs`). Owned by
 * cli-overseer. Each reads the seat its call was admitted as (`WorkSeat`), as
 * `src/core/work-control/msg.ts` does.
 *
 * The work server admits a call before it reaches here: an `overseer` call
 * comes from a human-enabled overseer seat and fits the request byte limit,
 * and an `overseer.live` call comes from the native Overseer seat, in a build
 * with Live conversation. The executors are main's, handed over on the seat.
 */
import { Effect, Result } from "effect";
import { LIVE_OVERSEER_ENABLED } from "@shared/features";
import { decodeOverseerArgs, isOverseerMutation, type OverseerResult } from "@shared/overseer-control";
import { type WorkErrorBody } from "@shared/work-control";
import { OverseerRpcs } from "../../contract/work/overseer";
import { workFailure } from "../../contract/work/failure";
import type { OverseerLiveExecutionConstraint } from "../overseer/live/execution";
import { WorkAdmission, WorkSeat } from "./seat";

export const OverseerServed = OverseerRpcs.middleware(WorkAdmission);

const overseerDispatchError = (error: unknown): WorkErrorBody => ({
  type: "InternalError",
  message: error instanceof Error ? error.message : String(error),
  details: { retryable: false },
});

/**
 * Drain the captured overseer Promise on interruption. Effect.tryPromise
 * aborts its signal without awaiting the underlying Promise, which would let
 * process revocation settle this dispatch while inner authoring-gate / native
 * cleanup is still in flight.
 */
const awaitOverseerPromise = (
  evaluate: (signal: AbortSignal) => Promise<OverseerResult>,
): Effect.Effect<OverseerResult, WorkErrorBody> =>
  Effect.callback<OverseerResult, WorkErrorBody>((resume, signal) => {
    let flight: Promise<OverseerResult>;
    try {
      flight = Promise.resolve(evaluate(signal));
    } catch (error) {
      resume(Effect.fail(overseerDispatchError(error)));
      return;
    }
    void flight.then(
      (value) => resume(Effect.succeed(value)),
      (error) => resume(Effect.fail(overseerDispatchError(error))),
    );
    // Keep the Effect pending until the captured Promise (including inner
    // lease / acquisition finalizers) actually settles. AbortSignal only
    // refuses later mutations; it cannot roll back work already in flight.
    return Effect.promise(() =>
      flight.then(
        () => undefined,
        () => undefined,
      ),
    );
  });

export const OverseerHandlers = OverseerServed.toLayer(
  OverseerServed.of({
    overseer: (request) =>
      Effect.gen(function* () {
        const { caller, overseer } = yield* WorkSeat;
        const argumentsResult = decodeOverseerArgs(request.operation, request.args);
        if (Result.isFailure(argumentsResult)) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "InputError", message: argumentsResult.failure.message,
            details: { retryable: false },
          });
        }
        const execute = overseer.execute;
        if (execute === undefined) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "RuntimeDown",
            message: "overseer administration is unavailable in this runtime",
            details: { retryable: false },
          });
        }
        let live: OverseerLiveExecutionConstraint | undefined;
        if (overseer.controller !== undefined || request.live !== undefined) {
          if (!LIVE_OVERSEER_ENABLED) return yield* Effect.fail<WorkErrorBody>({
            type: "ScopeError", message: "Live conversation is disabled in this Junto build",
          });
          const identity = overseer.controller;
          const validate = overseer.validateLive;
          if (identity === undefined || validate === undefined ||
            (isOverseerMutation(request.operation) && request.live === undefined)) {
            return yield* Effect.fail<WorkErrorBody>({ type: "AuthError", message: "native Overseer mutations require a current correlated Live request" });
          }
          if (request.live !== undefined) {
            live = yield* Effect.tryPromise({
              try: () => validate(request, identity),
              catch: (error): WorkErrorBody => ({ type: "AuthError", message: error instanceof Error ? error.message : "Live request is no longer current" }),
            });
          }
        }
        const result = yield* awaitOverseerPromise(
          (signal) => {
            live?.assertCurrent();
            return execute(request, { canvasName: caller.canvasName, nodeId: caller.nodeId }, signal, live);
          },
        );
        const settle = live?.settle;
        if (settle !== undefined) {
          // The answer stands whether or not its receipt was recorded.
          yield* Effect.tryPromise({
            try: () => settle(result),
            catch: (error): WorkErrorBody => ({ type: "InternalError", message: error instanceof Error ? error.message : "Live receipt could not be recorded" }),
          }).pipe(Effect.result);
        }
        return result;
      }).pipe(Effect.mapError(workFailure)),
    "overseer.live": (request) =>
      Effect.gen(function* () {
        const { overseer } = yield* WorkSeat;
        const bridge = overseer.live;
        const identity = overseer.controller;
        // The work server admits only the native seat here; a seat without its identity is never served.
        if (identity === undefined) return yield* Effect.fail<WorkErrorBody>({
          type: "AuthError", message: "the Live controller protocol belongs to the native Overseer seat",
        });
        if (bridge === undefined) return yield* Effect.fail<WorkErrorBody>({
          type: "RuntimeDown", message: "Live conversations are unavailable in this runtime",
        });
        return yield* Effect.tryPromise({
          try: (signal) => bridge(request, identity, signal),
          catch: (error): WorkErrorBody => ({
            type: "RuntimeDown", message: error instanceof Error ? error.message : "Live controller connection failed",
          }),
        });
      }).pipe(Effect.mapError(workFailure)),
  }),
);
