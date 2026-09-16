/**
 * Actor seat WHEN.
 *
 * This service decides admission and placement only. Process mechanics stay in
 * TerminalSeatProcess, supplied for each call as the selected local or Remote
 * HOW. No process implementation belongs in a root layer here.
 */
import { Context, Effect, Layer, Schema } from "effect";
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

/**
 * Typed non-started admission verdict for a Remote-placed actor seat. The
 * destination has not acknowledged the projection this seat rides on, so the
 * actor is truthfully not started — the UI surfaces the message and the
 * kernel wake path treats it like any other occupy failure: retry later.
 */
export class ActorSeatProjectionPending extends Schema.TaggedError<ActorSeatProjectionPending>()(
  "ActorSeatProjectionPending",
  {
    hostId: Schema.String,
    bindingId: Schema.String,
    reason: Schema.Literals(["remote-unavailable", "not-acknowledged",
    "seat-not-projected",]),
    message: Schema.String,
  },
) {}

export interface ActorSeatOccupyApi {
  readonly occupy: (
    spec: ActorOccupySpec,
  ) => Effect.Effect<
    TerminalSessionSummary,
    | SeatAlreadyOccupiedError
    | SeatVacantError
    | ActorSeatProjectionPending
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

/** Exact projection identity the destination must acknowledge. */
export type ProjectionAdmissionRef = {
  readonly generation: string;
  readonly contentSha256: string;
};

export type ProjectionAdmissionOutcome =
  | { readonly ok: true; readonly acked: ProjectionAdmissionRef }
  | {
      readonly ok: false;
      readonly reason: "remote-unavailable" | "not-acknowledged";
      readonly message: string;
    };

/**
 * Narrow ports for the Remote admission barrier. The live layer wires the
 * fleet propagation plane in; the decision logic stays testable here.
 */
export type RemoteProjectionAdmissionPorts = {
  /** Only a configured Command Center authors projections to await. */
  readonly localRole: () => Effect.Effect<
    "command-center" | "remote" | undefined,
    Error
  >;
  /** Only enrolled fleet hosts have projection semantics; others pass. */
  readonly isFleetTarget: (hostId: string) => Effect.Effect<boolean, Error>;
  /** Compile the desired projection from committed authorial state only. */
  readonly compileDesired: (
    hostId: string,
  ) => Effect.Effect<ProjectionAdmissionRef, Error>;
  /** Await an acknowledgement covering exactly this desired reference. */
  readonly awaitApplied: (
    hostId: string,
    desired: ProjectionAdmissionRef,
  ) => Effect.Effect<ProjectionAdmissionOutcome, Error>;
  /** Whether the acknowledged generation projects this seat onto the host. */
  readonly seatProjected: (
    acked: ProjectionAdmissionRef,
    hostId: string,
    bindingId: string,
  ) => Effect.Effect<boolean, Error>;
};

export type RemoteProjectionAdmission = (input: {
  readonly hostId: string;
  readonly bindingId: string;
}) => Effect.Effect<void, ActorSeatProjectionPending | Error>;

/**
 * Admission barrier for occupying an actor seat placed on a Remote host:
 * the destination must have acknowledged a projection, compiled from the
 * committed authorial state, that contains this exact seat. An already
 * acknowledged covering projection short-circuits inside `awaitApplied`; a
 * destination that is offline or acknowledges only older generations yields
 * a typed pending verdict and the actor is never started early.
 */
export const makeRemoteProjectionAdmission = (
  ports: RemoteProjectionAdmissionPorts,
): RemoteProjectionAdmission =>
  ({ hostId, bindingId }) =>
    Effect.gen(function* () {
      if ((yield* ports.localRole()) !== "command-center") return;
      if (!(yield* ports.isFleetTarget(hostId))) return;
      const desired = yield* ports.compileDesired(hostId);
      const outcome = yield* ports.awaitApplied(hostId, desired);
      if (!outcome.ok) {
        return yield* ActorSeatProjectionPending.make({
          hostId,
          bindingId,
          reason: outcome.reason,
          message: outcome.message,
        });
      }
      if (!(yield* ports.seatProjected(outcome.acked, hostId, bindingId))) {
        return yield* ActorSeatProjectionPending.make({
          hostId,
          bindingId,
          reason: "seat-not-projected",
          message:
            "the acknowledged projection does not place this agent seat on the requested host",
        });
      }
    });

export type ActorSeatOccupyDeps = {
  readonly local: LocalSessionHost;
  /** Resolve this installation's durable identity at the time of each call. */
  readonly localHostId: () => Effect.Effect<string | undefined, Error>;
  /** Directory seam only. The returned client is the selected Remote HOW. */
  readonly clientForOccupy: (
    hostId: string,
  ) => Promise<RemoteSeatProcessClient>;
  /**
   * Causal gate ahead of Remote occupation. Local seats never pass through
   * it. Required so unplugging the barrier is a type error, never a silent
   * fail-open; a caller with no projection semantics passes an explicit
   * pass-through.
   */
  readonly remoteProjectionAdmission: RemoteProjectionAdmission;
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

export const makeActorSeatOccupy = (
  deps: ActorSeatOccupyDeps,
): Context.Service.Shape<typeof ActorSeatOccupy> =>
  ActorSeatOccupy.of({
    occupy: (spec) => {
      const targetHostId = normalizeTargetHostId(spec.hostId);
      return Effect.gen(function* () {
        const localHostId = normalizeDurableHostId(yield* deps.localHostId());
        const isLocal =
          targetHostId === "local" || targetHostId === localHostId;
        // Remote placement admits through the projection barrier before any
        // process transport opens; local seats never touch the barrier.
        if (!isLocal) {
          yield* deps.remoteProjectionAdmission({
            hostId: targetHostId,
            bindingId: spec.bindingId,
          });
        }
        const implementation = isLocal
          ? makeLocalSeatProcess(deps.local)
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
        );
      });
    },
    occupancy: (bindingId, hostId) => {
      const targetHostId = normalizeTargetHostId(hostId);
      return provideHow(deps, targetHostId, occupancyProgram(bindingId));
    },
  });
