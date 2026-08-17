/**
 * Actor seat WHEN. Local-vs-remote directory is legal here only.
 * TerminalSeatProcess is HOW — occupy always creates an actor seat.
 */
import { Context, Effect, Layer, Result } from "effect";
import type { HarnessId } from "@shared/managed-terminal-templates";
import type { TerminalSessionSummary } from "@shared/terminal";
import {
  occupyVacantSeat,
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
  readonly isLocalHostId: (hostId?: string) => boolean;
  readonly clientFor: (hostId: string) => Promise<{
    get: (id: string) => Promise<TerminalSessionSummary | undefined>;
    createAgentSeat: (input: ActorOccupySpec) => Promise<TerminalSessionSummary>;
  }>;
};

const asClientError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const howFor = (
  deps: ActorSeatOccupyDeps,
  hostId: string | undefined,
): Effect.Effect<Context.Service.Shape<typeof TerminalSeatProcess>, Error> =>
  Effect.gen(function* () {
    if (deps.isLocalHostId(hostId)) {
      return makeLocalSeatProcess(deps.local);
    }
    if (hostId === undefined || hostId === "") {
      return yield* Effect.fail(new Error("remote actor occupy requires hostId"));
    }
    const client = yield* Effect.tryPromise({
      try: () => deps.clientFor(hostId),
      catch: asClientError,
    });
    return makeRemoteSeatProcess(client);
  });

const provideHow = <A, E>(
  deps: ActorSeatOccupyDeps,
  hostId: string | undefined,
  program: Effect.Effect<A, E, TerminalSeatProcess>,
): Effect.Effect<A, E | Error> =>
  Effect.gen(function* () {
    const impl = yield* howFor(deps, hostId);
    return yield* program.pipe(
      Effect.provide(Layer.succeed(TerminalSeatProcess, impl)),
    );
  });

const occupyProgram = (
  spec: ActorOccupySpec,
): Effect.Effect<
  TerminalSessionSummary,
  SeatAlreadyOccupiedError | SeatVacantError | Error,
  TerminalSeatProcess
> =>
  Effect.gen(function* () {
    const seats = yield* TerminalSeatProcess;
    const occupancy = yield* seats.occupancy(spec.bindingId);
    const occupy = occupyVacantSeat(occupancy);
    if (Result.isFailure(occupy)) {
      return yield* occupy.failure;
    }
    return yield* seats.occupy(occupy.success, spec);
  });

const occupancyProgram = (
  bindingId: string,
): Effect.Effect<SeatOccupancy, never, TerminalSeatProcess> =>
  Effect.gen(function* () {
    const seats = yield* TerminalSeatProcess;
    return yield* seats.occupancy(bindingId);
  });

export const makeActorSeatOccupy = (
  deps: ActorSeatOccupyDeps,
): Context.Service.Shape<typeof ActorSeatOccupy> =>
  ActorSeatOccupy.of({
    occupy: (spec) => provideHow(deps, spec.hostId, occupyProgram(spec)),
    occupancy: (bindingId, hostId) =>
      provideHow(deps, hostId, occupancyProgram(bindingId)),
  });
