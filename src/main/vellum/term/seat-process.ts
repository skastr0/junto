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
  SeatVacantError,
  type ActivateOccupiedSeat,
  type OccupyVacantSeat,
  type SeatAlreadyOccupiedError,
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
  ) => Effect.Effect<TerminalSessionSummary, SeatAlreadyOccupiedError | Error>;
  readonly activate: (
    command: ActivateOccupiedSeat,
    spec: ActorActivateSpec,
  ) => Effect.Effect<TerminalSessionSummary, SeatVacantError | Error>;
}

export class TerminalSeatProcess extends Context.Service<
  TerminalSeatProcess,
  TerminalSeatProcessApi
>()("@vellum/TerminalSeatProcess") {}

const asClientError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const harnessMismatchError = (
  bindingId: string,
  harness: string,
): Error => new Error(`seat ${bindingId} already bound to ${harness}`);

const generationChangedError = (
  bindingId: string,
  expectedEpoch: string,
  actualEpoch: string,
): Error =>
  new Error(
    `seat ${bindingId} changed generation from ${expectedEpoch} to ${actualEpoch}`,
  );

const actorIdentityError = (bindingId: string): Error =>
  new Error(`seat ${bindingId} did not bind the requested actor identity`);

const bindingMismatchError = (
  bindingId: string,
  returnedBindingId: string,
): Error =>
  new Error(
    `seat ${bindingId} returned a different binding ${returnedBindingId}`,
  );

const ensureCommandGeneration = (
  command: ActivateOccupiedSeat,
  actualEpoch: string,
): Effect.Effect<void, Error> =>
  actualEpoch === command.seat.epoch
    ? Effect.void
    : Effect.fail(
        generationChangedError(
          command.seat.bindingId,
          command.seat.epoch,
          actualEpoch,
        ),
      );

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
): Effect.Effect<TerminalSessionSummary, Error> => {
  if (summary.bindingId !== bindingId) {
    return Effect.fail(bindingMismatchError(bindingId, summary.bindingId));
  }
  if (!actorActivationMatches(summary, actor)) {
    return Effect.fail(actorIdentityError(bindingId));
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
        const current = localSummaryOccupancy(bindingId, host.get(bindingId));
        const occupy = occupyVacantSeat(current);
        if (Result.isFailure(occupy)) {
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
        return host.get(bindingId) ?? created;
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
        if (actorActivationMatches(live, actor)) {
          return yield* ensureActorIdentity(live, bindingId, actor);
        }
        if (live.harness !== undefined && live.harness !== actor.harness) {
          return yield* Effect.fail(
            harnessMismatchError(bindingId, live.harness),
          );
        }
        const adopted = yield* Effect.try({
          try: () => host.adoptAgentSeat(bindingId, actor),
          catch: asClientError,
        });
        if (!adopted) {
          return yield* SeatVacantError.make({
            bindingId,
            message: `seat ${bindingId} is vacant; activate requires an occupant`,
          });
        }
        yield* ensureCommandGeneration(command, adopted.epoch);
        return yield* ensureActorIdentity(adopted, bindingId, actor);
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
): Effect.Effect<TerminalSessionSummary | undefined, Error> => {
  if (summary && summary.bindingId !== bindingId) {
    return Effect.fail(bindingMismatchError(bindingId, summary.bindingId));
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
          return yield* occupy.failure;
        }
        const created = yield* Effect.tryPromise({
          try: () => client.createAgentSeat(remoteAgentInput(bindingId, spec)),
          catch: asClientError,
        });
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
        if (live.harness !== undefined && live.harness !== actor.harness) {
          return yield* Effect.fail(
            harnessMismatchError(bindingId, live.harness),
          );
        }
        // Every activation reaches the spawn host so the epoch check and any
        // geography adoption happen against one synchronous host snapshot.
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
