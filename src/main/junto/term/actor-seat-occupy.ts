/** Seat admission selects the process implementation for its machine. */
import { randomUUID } from "node:crypto";
import { Cause, Context, Effect, Layer } from "effect";
import { isThisMachine } from "@shared/machine-name";
import type { HarnessId } from "@shared/managed-terminal-templates";
import type { TerminalSessionSummary } from "@shared/terminal";
import {
  seatAdmission,
  type SeatAlreadyOccupiedError,
  type SeatOccupancy,
  type SeatVacantError,
} from "@shared/terminal-seat-occupancy";
import type { LocalSessionHost } from "./local-host";
import {
  makeLocalSeatProcess,
  makeRemoteSeatProcess,
  type SeatEnvironmentResolver,
  TerminalSeatProcess,
  type OccupySpec,
  type RemoteSeatProcessClient,
} from "./seat-process";
import { asCanvasName, asNodeId } from "@shared/model";
import { clipText, SeatSpawnFailed } from "./seats-failure";

export type ActorOccupySpec = OccupySpec & {
  readonly harness: HarnessId;
  readonly agentKey: string;
  readonly hostId?: string;
};

export interface ActorSeatOccupyApi {
  readonly occupy: (
    spec: ActorOccupySpec,
  ) => Effect.Effect<
    TerminalSessionSummary,
    | SeatAlreadyOccupiedError
    | SeatVacantError
    | Error
  >;
  readonly occupancy: (
    bindingId: string,
    hostId?: string,
  ) => Effect.Effect<SeatOccupancy, Error>;
}

export class ActorSeatOccupy extends Context.Service<
  ActorSeatOccupy,
  ActorSeatOccupyApi
>()("@junto/ActorSeatOccupy") {}

export type ActorSeatOccupyDeps = {
  readonly local: LocalSessionHost;
  /** Resolve this installation's durable identity at the time of each call. */
  readonly localHostId: () => Effect.Effect<string, Error>;
  /** The process client on the selected machine. */
  readonly clientForOccupy: (
    hostId: string,
  ) => Promise<RemoteSeatProcessClient>;
  /** Resolve the seat environment on its machine at launch. */
  readonly seatEnvironment: SeatEnvironmentResolver;
};

const asClientError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const normalizeTargetHostId = (hostId: string | undefined, machineName: string): string =>
  hostId?.trim() || machineName;

const howFor = (
  deps: ActorSeatOccupyDeps,
  targetHostId: string,
  machineName: string,
): Effect.Effect<Context.Service.Shape<typeof TerminalSeatProcess>, Error> =>
  Effect.gen(function* () {
    if (isThisMachine(targetHostId, machineName)) {
      return makeLocalSeatProcess(deps.local, deps.seatEnvironment);
    }
    const client = yield* Effect.tryPromise({
      try: () => deps.clientForOccupy(targetHostId),
      catch: asClientError,
    });
    return makeRemoteSeatProcess(targetHostId, client);
  });

const provideHow = <A, E>(
  deps: ActorSeatOccupyDeps,
  targetHostId: string,
  machineName: string,
  program: Effect.Effect<A, E, TerminalSeatProcess>,
): Effect.Effect<A, E | Error> =>
  Effect.gen(function* () {
    const implementation = yield* howFor(deps, targetHostId, machineName);
    return yield* program.pipe(
      Effect.provide(
        Layer.succeed(TerminalSeatProcess, implementation),
      ),
    );
  });

const assertNever = (value: never): never => value;

/** One exhaustive WHEN program for both local and Remote occupation. */
const occupyProgram = (
  spec: ActorOccupySpec,
): Effect.Effect<
  TerminalSessionSummary,
  SeatAlreadyOccupiedError | SeatVacantError | Error,
  TerminalSeatProcess
> =>
  Effect.gen(function* () {
    const seats = yield* TerminalSeatProcess;
    const admission = seatAdmission(yield* seats.occupancy(spec.bindingId));
    switch (admission._tag) {
      case "OccupyVacantSeat":
        return yield* seats.occupy(admission, spec);
      case "ActivateOccupiedSeat":
        // Activation is validate-only: it succeeds only on an exact identity
        // match with the live generation and otherwise fails with a typed
        // conflict. It never rebinds an occupied generation to a new actor.
        return yield* seats.activate(admission, spec);
      default:
        return assertNever(admission);
    }
  });

const occupancyProgram = (
  bindingId: string,
): Effect.Effect<SeatOccupancy, Error, TerminalSeatProcess> =>
  Effect.gen(function* () {
    const seats = yield* TerminalSeatProcess;
    return yield* seats.occupancy(bindingId);
  });

/**
 * A harness that never started still returns its exited generation, so the
 * card reads exitMessage from it; the log row records it as the failure.
 */
const logStartOutcome = (
  spec: ActorOccupySpec,
  machine: string,
  live: TerminalSessionSummary,
): Effect.Effect<void> =>
  live.status === "exited" && live.exitReason !== undefined
    ? Effect.logError("seat start failed", Cause.fail(new SeatSpawnFailed({
        machine, canvas: asCanvasName(spec.canvasName), seatId: asNodeId(spec.nodeId),
        bindingId: spec.bindingId, harness: spec.harness, epoch: live.epoch, exitReason: live.exitReason,
        exitMessage: clipText(live.exitMessage ?? live.exitReason),
        message: clipText(live.exitMessage ?? live.exitReason),
      })))
    : Effect.logInfo(`seat start ${live.status}`);

export const makeActorSeatOccupy = (
  deps: ActorSeatOccupyDeps,
): Context.Service.Shape<typeof ActorSeatOccupy> =>
  ActorSeatOccupy.of({
    occupy: (spec) => {
      return Effect.gen(function* () {
        const localHostId = yield* deps.localHostId();
        const targetHostId = normalizeTargetHostId(spec.hostId, localHostId);
        const isLocal =
          isThisMachine(targetHostId, localHostId);
        const implementation = isLocal
          ? makeLocalSeatProcess(deps.local, deps.seatEnvironment)
          : makeRemoteSeatProcess(
              targetHostId,
              yield* Effect.tryPromise({
                try: () => deps.clientForOccupy(targetHostId),
                catch: asClientError,
              }),
            );
        return yield* occupyProgram({ ...spec, hostId: targetHostId }).pipe(
          Effect.provide(
            Layer.succeed(TerminalSeatProcess, implementation),
          ),
          Effect.tap((live) => logStartOutcome(spec, targetHostId, live)),
          Effect.tapCause((cause) => Effect.logError("seat start failed", cause)),
          Effect.annotateLogs({ machine_target: targetHostId }),
        );
      }).pipe(
        Effect.annotateLogs({
          area: "seats", operationId: randomUUID(), seat: spec.nodeId,
          canvas: spec.canvasName, harness: spec.harness,
        }),
        Effect.withSpan("ActorSeatOccupy.occupy"),
      );
    },
    occupancy: (bindingId, hostId) =>
      Effect.gen(function* () {
        const machineName = yield* deps.localHostId();
        const targetHostId = normalizeTargetHostId(hostId, machineName);
        return yield* provideHow(deps, targetHostId, machineName, occupancyProgram(bindingId));
      }),
  });
