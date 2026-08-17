/**
 * Terminal seat HOW.
 *
 * Occupancy is shared; placement selects either this-process PTY mechanics or
 * a station-forwarded Remote generation. Occupy is actor-only and never falls
 * back to geography creation.
 */
import { Context, Effect, Result } from "effect";
import type { ManagedSpawnIntent } from "@shared/managed-terminal-launch";
import type { HarnessId } from "@shared/managed-terminal-templates";
import {
  sessionActorMatches,
  type TerminalSessionSummary,
} from "@shared/terminal";
import {
  activateOccupiedSeat,
  occupancyFromSummary,
  occupyVacantSeat,
  seatBindingMismatchError,
  seatGenerationConflictError,
  seatIdentityConflictError,
  SeatVacantError,
  type ActivateOccupiedSeat,
  type OccupyVacantSeat,
  type SeatAlreadyOccupiedError,
  type SeatBindingMismatchError,
  type SeatGenerationConflictError,
  type SeatIdentityConflictError,
  type SeatOccupancy,
} from "@shared/terminal-seat-occupancy";
import type { LocalSessionHost } from "./local-host";
import { launchForManagedSpawnIntent } from "./managed-spawn-plan";

export type OccupySpec = {
  readonly bindingId: string;
  readonly hostId?: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly canvasName: string;
  readonly nodeId: string;
  readonly label?: string;
  readonly title?: string;
  readonly harness: HarnessId;
  readonly agentKey: string;
  /** Pure intent; the selected process host owns resume/session finalization. */
  readonly spawnIntent: ManagedSpawnIntent;
};

export type ActorActivateSpec = Pick<
  OccupySpec,
  "harness" | "agentKey" | "canvasName" | "nodeId"
>;

export interface TerminalSeatProcessApi {
  readonly occupancy: (
    bindingId: string,
  ) => Effect.Effect<SeatOccupancy, Error>;
  readonly occupy: (
    command: OccupyVacantSeat,
    spec: OccupySpec,
  ) => Effect.Effect<
    TerminalSessionSummary,
    SeatAlreadyOccupiedError | SeatIdentityConflictError | Error
  >;
  readonly activate: (
    command: ActivateOccupiedSeat,
    spec: ActorActivateSpec,
  ) => Effect.Effect<
    TerminalSessionSummary,
    | SeatVacantError
    | SeatIdentityConflictError
    | SeatGenerationConflictError
    | Error
  >;
}

export class TerminalSeatProcess extends Context.Service<
  TerminalSeatProcess,
  TerminalSeatProcessApi
>()("@vellum/TerminalSeatProcess") {}

const asClientError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const occupantIdentityOf = (
  summary: TerminalSessionSummary | undefined,
): {
  harness?: string;
  agentKey?: string;
  canvasName?: string;
  nodeId?: string;
} => ({
  ...(summary?.harness === undefined ? {} : { harness: summary.harness }),
  ...(summary?.agentKey === undefined ? {} : { agentKey: summary.agentKey }),
  ...(summary?.canvasName === undefined
    ? {}
    : { canvasName: summary.canvasName }),
  ...(summary?.nodeId === undefined ? {} : { nodeId: summary.nodeId }),
});

const identityConflictError = (
  bindingId: string,
  actor: ActorActivateSpec,
  occupant: TerminalSessionSummary | undefined,
): SeatIdentityConflictError =>
  seatIdentityConflictError(
    bindingId,
    {
      harness: actor.harness,
      agentKey: actor.agentKey,
      canvasName: actor.canvasName,
      nodeId: actor.nodeId,
    },
    occupantIdentityOf(occupant),
  );

const ensureCommandGeneration = (
  command: ActivateOccupiedSeat,
  actualEpoch: string,
): Effect.Effect<void, SeatGenerationConflictError> =>
  actualEpoch === command.seat.epoch
    ? Effect.void
    : Effect.fail(
        seatGenerationConflictError(
          command.seat.bindingId,
          command.seat.epoch,
          actualEpoch,
        ),
      );

/**
 * Convergence may only settle on a generation that is actually alive. A
 * stopping or exited incumbent is being torn down — a station-side occupation
 * that failed fail-closed leaves exactly such a record indexed until its exit
 * witness settles, and returning it would launder that failure into a
 * successful occupation carrying a dying epoch.
 */
const isLiveIncumbent = (
  summary: Pick<TerminalSessionSummary, "status" | "stopping">,
): boolean =>
  summary.stopping !== true &&
  summary.status !== "exited" &&
  summary.status !== "missing";

const actorAnchorsMatch = (
  summary: TerminalSessionSummary,
  actor: ActorActivateSpec,
): boolean =>
  summary.canvasName === actor.canvasName && summary.nodeId === actor.nodeId;

const actorActivationMatches = (
  summary: TerminalSessionSummary,
  actor: ActorActivateSpec,
): boolean =>
  sessionActorMatches(summary, actor) && actorAnchorsMatch(summary, actor);

const ensureActorIdentity = (
  summary: TerminalSessionSummary,
  bindingId: string,
  actor: ActorActivateSpec,
): Effect.Effect<
  TerminalSessionSummary,
  SeatBindingMismatchError | SeatIdentityConflictError
> => {
  if (summary.bindingId !== bindingId) {
    return Effect.fail(seatBindingMismatchError(bindingId, summary.bindingId));
  }
  if (!actorActivationMatches(summary, actor)) {
    return Effect.fail(identityConflictError(bindingId, actor, summary));
  }
  return Effect.succeed(summary);
};

const localSummaryOccupancy = (
  bindingId: string,
  summary: TerminalSessionSummary | undefined,
): SeatOccupancy => occupancyFromSummary(bindingId, summary, "local");

const localAgentInput = (
  bindingId: string,
  spec: OccupySpec,
) => {
  const finalized = launchForManagedSpawnIntent(spec, spec.spawnIntent);
  return {
    bindingId,
    harness: spec.harness,
    agentKey: spec.agentKey,
    hostId: spec.hostId,
    launch: finalized.launch,
    resumeFallbackIntent: spec.spawnIntent,
    cols: spec.cols,
    rows: spec.rows,
    canvasName: spec.canvasName,
    nodeId: spec.nodeId,
    label: spec.label,
    title: spec.title,
    firstTypedMessage: finalized.plan?.firstTypedMessage,
  };
};

export const makeLocalSeatProcess = (
  host: LocalSessionHost,
): Context.Service.Shape<typeof TerminalSeatProcess> =>
  TerminalSeatProcess.of({
    occupancy: (bindingId) =>
      Effect.sync(() => localSummaryOccupancy(bindingId, host.get(bindingId))),
    occupy: (command, spec) =>
      Effect.gen(function* () {
        const bindingId = command.seat.bindingId;
        const live = host.get(bindingId);
        const occupy = occupyVacantSeat(localSummaryOccupancy(bindingId, live));
        if (Result.isFailure(occupy)) {
          // Losing an occupy race to the exact same actor is convergence, not
          // failure: both callers end on the one incumbent generation. Any
          // other occupant is a typed identity conflict.
          if (live !== undefined && actorActivationMatches(live, spec)) {
            if (isLiveIncumbent(live)) {
              return yield* ensureActorIdentity(live, bindingId, spec);
            }
            // Same identity on a stopping generation: the incumbent failed
            // fail-closed and has not vacated yet. Occupation stays refused.
            return yield* occupy.failure;
          }
          if (live !== undefined) {
            return yield* Effect.fail(
              identityConflictError(bindingId, spec, live),
            );
          }
          return yield* occupy.failure;
        }
        const created = yield* Effect.try({
          try: () => host.createAgentSeat(localAgentInput(bindingId, spec)),
          catch: asClientError,
        });
        // An already-resolved exit witness settles on the promise queue. Its
        // fail-open replacement must become the returned head, not the dead
        // resume generation that createAgentSeat initially handed us.
        yield* Effect.tryPromise({
          try: () => Promise.resolve(),
          catch: asClientError,
        });
        // Symmetric with the Remote HOW: occupation only returns a generation
        // that verifiably carries the requested actor identity.
        return yield* ensureActorIdentity(
          host.get(bindingId) ?? created,
          bindingId,
          spec,
        );
      }),
    activate: (command, actor) =>
      Effect.gen(function* () {
        const bindingId = command.seat.bindingId;
        const live = host.get(bindingId);
        const activate = activateOccupiedSeat(
          localSummaryOccupancy(bindingId, live),
        );
        if (Result.isFailure(activate)) {
          return yield* activate.failure;
        }
        yield* ensureCommandGeneration(command, activate.success.seat.epoch);
        if (!live) {
          return yield* SeatVacantError.make({
            bindingId,
            message: `seat ${bindingId} is vacant; activate requires an occupant`,
          });
        }
        // Actor identity is immutable for a live generation. Activation is
        // validate-only: an exact match returns the existing generation, any
        // other occupant is a typed conflict — never an in-place adoption.
        if (!actorActivationMatches(live, actor)) {
          return yield* Effect.fail(
            identityConflictError(bindingId, actor, live),
          );
        }
        return yield* ensureActorIdentity(live, bindingId, actor);
      }),
  });

export type RemoteAgentSeatInput = Omit<
  OccupySpec,
  "hostId" | "title"
> & {
  readonly admission: "occupy";
};

export type RemoteAgentSeatActivationInput = ActorActivateSpec & {
  readonly admission: "activate";
  readonly bindingId: string;
  readonly expectedEpoch: string;
};

export type RemoteAgentSeatCommand =
  | RemoteAgentSeatInput
  | RemoteAgentSeatActivationInput;

/** Station term-control surface required by the Remote HOW. */
export type RemoteSeatProcessClient = {
  readonly get: (
    bindingId: string,
  ) => Promise<TerminalSessionSummary | undefined>;
  readonly createAgentSeat: (
    input: RemoteAgentSeatCommand,
  ) => Promise<TerminalSessionSummary>;
};

const projectRemoteSummary = (
  requestedHostId: string,
  summary: TerminalSessionSummary,
): TerminalSessionSummary => ({ ...summary, hostId: requestedHostId });

const checkedRemoteSummary = (
  requestedHostId: string,
  bindingId: string,
  summary: TerminalSessionSummary | undefined,
): Effect.Effect<TerminalSessionSummary | undefined, SeatBindingMismatchError> => {
  if (summary && summary.bindingId !== bindingId) {
    return Effect.fail(seatBindingMismatchError(bindingId, summary.bindingId));
  }
  return Effect.succeed(
    summary ? projectRemoteSummary(requestedHostId, summary) : undefined,
  );
};

const remoteSummaryOccupancy = (
  bindingId: string,
  summary: TerminalSessionSummary | undefined,
): SeatOccupancy => occupancyFromSummary(bindingId, summary, "remote");

const remoteAgentInput = (
  bindingId: string,
  spec: OccupySpec,
): RemoteAgentSeatInput => ({
  admission: "occupy",
  bindingId,
  harness: spec.harness,
  agentKey: spec.agentKey,
  spawnIntent: spec.spawnIntent,
  cols: spec.cols,
  rows: spec.rows,
  canvasName: spec.canvasName,
  nodeId: spec.nodeId,
  label: spec.label,
});

export const makeRemoteSeatProcess = (
  requestedHostId: string,
  client: RemoteSeatProcessClient,
): Context.Service.Shape<typeof TerminalSeatProcess> => {
  const hostId = requestedHostId.trim();
  return TerminalSeatProcess.of({
    occupancy: (bindingId) =>
      Effect.gen(function* () {
        const summary = yield* Effect.tryPromise({
          try: () => client.get(bindingId),
          catch: asClientError,
        });
        const current = yield* checkedRemoteSummary(
          hostId,
          bindingId,
          summary,
        );
        return remoteSummaryOccupancy(bindingId, current);
      }),
    occupy: (command, spec) =>
      Effect.gen(function* () {
        const bindingId = command.seat.bindingId;
        const summary = yield* Effect.tryPromise({
          try: () => client.get(bindingId),
          catch: asClientError,
        });
        const current = yield* checkedRemoteSummary(
          hostId,
          bindingId,
          summary,
        );
        const occupy = occupyVacantSeat(
          remoteSummaryOccupancy(bindingId, current),
        );
        if (Result.isFailure(occupy)) {
          // Losing an occupy race to the exact same actor is convergence, not
          // failure. Any other occupant is a typed identity conflict.
          if (current !== undefined && actorActivationMatches(current, spec)) {
            if (isLiveIncumbent(current)) {
              return yield* ensureActorIdentity(current, bindingId, spec);
            }
            // Same identity on a stopping generation: refuse, never return a
            // generation that is being torn down.
            return yield* occupy.failure;
          }
          if (current !== undefined) {
            return yield* Effect.fail(
              identityConflictError(bindingId, spec, current),
            );
          }
          return yield* occupy.failure;
        }
        const created = yield* Effect.tryPromise({
          try: () => client.createAgentSeat(remoteAgentInput(bindingId, spec)),
          catch: asClientError,
        }).pipe(
          Effect.catch((failure) =>
            Effect.gen(function* () {
              // The wire loses error typing, so the losing racer re-reads the
              // authoritative seat: the exact requested identity converges on
              // the winner's generation; any other occupant is a typed
              // conflict; a vacant seat preserves the original failure.
              const raced = yield* Effect.tryPromise({
                try: () => client.get(bindingId),
                catch: () => failure,
              });
              const incumbent = yield* checkedRemoteSummary(
                hostId,
                bindingId,
                raced,
              );
              if (
                incumbent !== undefined &&
                actorActivationMatches(incumbent, spec)
              ) {
                if (isLiveIncumbent(incumbent)) {
                  return incumbent;
                }
                // The station occupied this identity and then tore it down
                // fail-closed; the still-indexed stopping record is not a
                // winner to converge on. Preserve the original failure.
                return yield* Effect.fail(failure);
              }
              if (incumbent !== undefined) {
                return yield* Effect.fail(
                  identityConflictError(bindingId, spec, incumbent),
                );
              }
              return yield* Effect.fail(failure);
            }),
          ),
        );
        // A proven resume can die and fail-open on the host's promise queue.
        // Re-read so occupation returns that replacement head, not its dead seed.
        const head = yield* Effect.tryPromise({
          try: () => client.get(bindingId),
          catch: asClientError,
        });
        const projectedHead = yield* checkedRemoteSummary(
          hostId,
          bindingId,
          head ?? created,
        );
        if (!projectedHead) {
          return yield* Effect.fail(
            new Error(`seat ${bindingId} disappeared after actor occupation`),
          );
        }
        return yield* ensureActorIdentity(projectedHead, bindingId, spec);
      }),
    activate: (command, actor) =>
      Effect.gen(function* () {
        const bindingId = command.seat.bindingId;
        const summary = yield* Effect.tryPromise({
          try: () => client.get(bindingId),
          catch: asClientError,
        });
        const live = yield* checkedRemoteSummary(
          hostId,
          bindingId,
          summary,
        );
        const activate = activateOccupiedSeat(
          remoteSummaryOccupancy(bindingId, live),
        );
        if (Result.isFailure(activate)) {
          return yield* activate.failure;
        }
        yield* ensureCommandGeneration(command, activate.success.seat.epoch);
        if (!live) {
          return yield* SeatVacantError.make({
            bindingId,
            message: `seat ${bindingId} is vacant; activate requires an occupant`,
          });
        }
        // Actor identity is immutable for a live generation. Any occupant that
        // is not the exact requested actor (geography included) is a typed
        // conflict; nothing is asked of the Remote for a mismatch.
        if (!actorActivationMatches(live, actor)) {
          return yield* Effect.fail(
            identityConflictError(bindingId, actor, live),
          );
        }
        // Every activation still reaches the spawn host so the epoch and
        // identity checks happen against one synchronous host snapshot.
        const activated = yield* Effect.tryPromise({
          try: () =>
            client.createAgentSeat({
              admission: "activate",
              bindingId,
              expectedEpoch: command.seat.epoch,
              harness: actor.harness,
              agentKey: actor.agentKey,
              canvasName: actor.canvasName,
              nodeId: actor.nodeId,
            }),
          catch: asClientError,
        });
        const projected = yield* checkedRemoteSummary(
          hostId,
          bindingId,
          activated,
        );
        if (!projected) {
          return yield* SeatVacantError.make({
            bindingId,
            message: `seat ${bindingId} is vacant; activate requires an occupant`,
          });
        }
        yield* ensureCommandGeneration(command, projected.epoch);
        return yield* ensureActorIdentity(projected, bindingId, actor);
      }),
  });
};
