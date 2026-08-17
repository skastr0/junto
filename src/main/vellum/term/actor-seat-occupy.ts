/**
 * Actor seat WHEN.
 *
 * This service decides admission and placement only. Process mechanics stay in
 * TerminalSeatProcess, supplied for each call as the selected local or Remote
 * HOW. No process implementation belongs in a root layer here.
 */
import { Context, Effect, Layer } from "effect";
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
  TerminalSeatProcess,
  type OccupySpec,
  type RemoteSeatProcessClient,
} from "./seat-process";

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
    SeatAlreadyOccupiedError | SeatVacantError | Error
  >;
  readonly occupancy: (
    bindingId: string,
    hostId?: string,
  ) => Effect.Effect<SeatOccupancy, Error>;
}

export class ActorSeatOccupy extends Context.Service<
  ActorSeatOccupy,
  ActorSeatOccupyApi
>()("@vellum/ActorSeatOccupy") {}

export type ActorSeatOccupyDeps = {
  readonly local: LocalSessionHost;
  /** Resolve this installation's durable identity at the time of each call. */
  readonly localHostId: () => Effect.Effect<string | undefined, Error>;
  /** Directory seam only. The returned client is the selected Remote HOW. */
  readonly clientForOccupy: (
    hostId: string,
  ) => Promise<RemoteSeatProcessClient>;
};

const asClientError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const normalizeTargetHostId = (hostId: string | undefined): string =>
  hostId?.trim() || "local";

const normalizeDurableHostId = (
  hostId: string | undefined,
): string | undefined => {
  const normalized = hostId?.trim();
  return normalized ? normalized : undefined;
};

const howFor = (
  deps: ActorSeatOccupyDeps,
  targetHostId: string,
): Effect.Effect<Context.Service.Shape<typeof TerminalSeatProcess>, Error> =>
  Effect.gen(function* () {
    const localHostId = normalizeDurableHostId(yield* deps.localHostId());
    if (targetHostId === "local" || targetHostId === localHostId) {
      return makeLocalSeatProcess(deps.local);
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
  program: Effect.Effect<A, E, TerminalSeatProcess>,
): Effect.Effect<A, E | Error> =>
  Effect.gen(function* () {
    const implementation = yield* howFor(deps, targetHostId);
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
        // Activation may adopt an occupied geography generation. Preserve the
        // node-derived anchors so the selected HOW can atomically rebind the
        // existing PID to this actor seat without replacing its epoch.
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

export const makeActorSeatOccupy = (
  deps: ActorSeatOccupyDeps,
): Context.Service.Shape<typeof ActorSeatOccupy> =>
  ActorSeatOccupy.of({
    occupy: (spec) => {
      const targetHostId = normalizeTargetHostId(spec.hostId);
      return provideHow(
        deps,
        targetHostId,
        occupyProgram({ ...spec, hostId: targetHostId }),
      );
    },
    occupancy: (bindingId, hostId) => {
      const targetHostId = normalizeTargetHostId(hostId);
      return provideHow(deps, targetHostId, occupancyProgram(bindingId));
    },
  });
