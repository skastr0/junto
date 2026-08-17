/**
 * Terminal seat HOW.
 *
 * Occupancy is shared; placement selects either this-process PTY mechanics or
 * a station-forwarded Remote generation. Occupy is actor-only and never falls
 * back to geography creation.
 */
import { Context, Effect, Result } from "effect";
import type { HarnessId } from "@shared/managed-terminal-templates";
import {
  sessionActorMatches,
  type TerminalLaunch,
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

export type OccupySpec = {
  readonly bindingId: string;
  readonly hostId?: string;
  readonly launch?: TerminalLaunch;
  readonly cols?: number;
  readonly rows?: number;
  readonly canvasName?: string;
  readonly nodeId?: string;
  readonly label?: string;
  readonly title?: string;
  readonly harness: HarnessId;
  readonly agentKey: string;
  readonly firstTypedMessage?: string;
};

export type ActorActivateSpec = {
  readonly harness: HarnessId;
  readonly agentKey: string;
};

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

const ensureActorIdentity = (
  summary: TerminalSessionSummary,
  bindingId: string,
  actor: ActorActivateSpec,
): Effect.Effect<TerminalSessionSummary, Error> => {
  if (summary.bindingId !== bindingId) {
    return Effect.fail(bindingMismatchError(bindingId, summary.bindingId));
  }
  if (!sessionActorMatches(summary, actor)) {
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
) => ({
  bindingId,
  harness: spec.harness,
  agentKey: spec.agentKey,
  hostId: spec.hostId,
  launch: spec.launch,
  cols: spec.cols,
  rows: spec.rows,
  canvasName: spec.canvasName,
  nodeId: spec.nodeId,
  label: spec.label,
  title: spec.title,
  firstTypedMessage: spec.firstTypedMessage,
});

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
        if (sessionActorMatches(live, actor)) return live;
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
>;

/** Station term-control surface required by the Remote HOW. */
export type RemoteSeatProcessClient = {
  readonly get: (
    bindingId: string,
  ) => Promise<TerminalSessionSummary | undefined>;
  readonly createAgentSeat: (
    input: RemoteAgentSeatInput,
  ) => Promise<TerminalSessionSummary>;
};

const projectRemoteSummary = (
  requestedHostId: string,
  summary: TerminalSessionSummary,
): TerminalSessionSummary => ({ ...summary, hostId: requestedHostId });

const remoteSummaryOccupancy = (
  bindingId: string,
  summary: TerminalSessionSummary | undefined,
): SeatOccupancy => occupancyFromSummary(bindingId, summary, "remote");

const remoteAgentInput = (
  bindingId: string,
  spec: OccupySpec,
): RemoteAgentSeatInput => ({
  bindingId,
  harness: spec.harness,
  agentKey: spec.agentKey,
  launch: spec.launch,
  cols: spec.cols,
  rows: spec.rows,
  canvasName: spec.canvasName,
  nodeId: spec.nodeId,
  label: spec.label,
  firstTypedMessage: spec.firstTypedMessage,
});

export const makeRemoteSeatProcess = (
  requestedHostId: string,
  client: RemoteSeatProcessClient,
): Context.Service.Shape<typeof TerminalSeatProcess> => {
  const hostId = requestedHostId.trim();
  return TerminalSeatProcess.of({
    occupancy: (bindingId) =>
      Effect.tryPromise({
        try: () => client.get(bindingId),
        catch: asClientError,
      }).pipe(
        Effect.map((summary) =>
          remoteSummaryOccupancy(
            bindingId,
            summary
              ? projectRemoteSummary(hostId, summary)
              : undefined,
          ),
        ),
      ),
    occupy: (command, spec) =>
      Effect.gen(function* () {
        const bindingId = command.seat.bindingId;
        const summary = yield* Effect.tryPromise({
          try: () => client.get(bindingId),
          catch: asClientError,
        });
        const current = summary
          ? projectRemoteSummary(hostId, summary)
          : undefined;
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
        return yield* ensureActorIdentity(
          projectRemoteSummary(hostId, created),
          bindingId,
          spec,
        );
      }),
    activate: (command, actor) =>
      Effect.gen(function* () {
        const bindingId = command.seat.bindingId;
        const summary = yield* Effect.tryPromise({
          try: () => client.get(bindingId),
          catch: asClientError,
        });
        const live = summary
          ? projectRemoteSummary(hostId, summary)
          : undefined;
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
        if (sessionActorMatches(live, actor)) return live;
        if (live.harness !== undefined && live.harness !== actor.harness) {
          return yield* Effect.fail(
            harnessMismatchError(bindingId, live.harness),
          );
        }
        const adopted = yield* Effect.tryPromise({
          try: () =>
            client.createAgentSeat({
              bindingId,
              harness: actor.harness,
              agentKey: actor.agentKey,
            }),
          catch: asClientError,
        });
        const projected = projectRemoteSummary(hostId, adopted);
        yield* ensureCommandGeneration(command, projected.epoch);
        return yield* ensureActorIdentity(projected, bindingId, actor);
      }),
  });
};
