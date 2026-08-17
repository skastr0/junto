/**
 * One seat contract. Local PTY and Remote station are Layers.
 *
 * Occupancy law is shared. Placement selects the process implementation
 * (this-process PTY vs station-forwarded generation). macOS / Linux / Windows
 * spawn details stay inside the local Layer.
 *
 * Occupy is actor-only: harness and agentKey are required. Geography create
 * is not a fallback on this layer.
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
  type SeatOccupancy,
  type SeatAlreadyOccupiedError,
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
  ) => Effect.Effect<SeatOccupancy>;
  readonly occupy: (
    command: OccupyVacantSeat,
    spec: OccupySpec,
  ) => Effect.Effect<
    TerminalSessionSummary,
    SeatAlreadyOccupiedError | Error
  >;
  readonly activate: (
    command: ActivateOccupiedSeat,
    spec?: ActorActivateSpec,
  ) => Effect.Effect<TerminalSessionSummary, SeatVacantError | Error>;
}

/**
 * V4 migration map (same bridge as TerminalSessions):
 *
 *   Context.Service<TerminalSeatProcess, TerminalSeatProcessApi>()(
 *     "@vellum/TerminalSeatProcess",
 *   )
 */
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

const summaryOccupancy = (
  host: LocalSessionHost,
  bindingId: string,
): SeatOccupancy => occupancyFromSummary(bindingId, host.get(bindingId), "local");

const adoptIfGeography = (
  live: TerminalSessionSummary,
  spec: ActorActivateSpec | undefined,
  adopt: () => TerminalSessionSummary | undefined,
): Effect.Effect<TerminalSessionSummary, Error> => {
  if (spec === undefined) return Effect.succeed(live);
  if (sessionActorMatches(live, spec)) return Effect.succeed(live);
  if (live.harness !== undefined && live.harness !== spec.harness) {
    return Effect.fail(harnessMismatchError(live.bindingId, live.harness));
  }
  if (live.status === "running" && live.harness === undefined) {
    return Effect.try({
      try: () => {
        const adopted = adopt();
        if (!adopted) {
          throw new Error(
            `seat ${live.bindingId} is vacant; activate requires an occupant`,
          );
        }
        return adopted;
      },
      catch: asClientError,
    });
  }
  return Effect.succeed(live);
};

export const makeLocalSeatProcess = (
  host: LocalSessionHost,
): Context.Service.Shape<typeof TerminalSeatProcess> =>
  TerminalSeatProcess.of({
    occupancy: (bindingId) => Effect.sync(() => summaryOccupancy(host, bindingId)),
    occupy: (command, spec) =>
      Effect.gen(function* () {
        const current = summaryOccupancy(host, command.seat.bindingId);
        const occupy = occupyVacantSeat(current);
        if (Result.isFailure(occupy)) {
          return yield* occupy.failure;
        }
        return host.createAgentSeat({
          bindingId: spec.bindingId,
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
      }),
    activate: (command, spec) =>
      Effect.gen(function* () {
        const current = summaryOccupancy(host, command.seat.bindingId);
        const activate = activateOccupiedSeat(current);
        if (Result.isFailure(activate)) {
          return yield* activate.failure;
        }
        const live = host.get(command.seat.bindingId);
        if (!live) {
          return yield* SeatVacantError.make({
            bindingId: command.seat.bindingId,
            message: `seat ${command.seat.bindingId} is vacant; activate requires an occupant`,
          });
        }
        if (spec === undefined) return live;
        return yield* adoptIfGeography(live, spec, () =>
          host.adoptAgentSeat(command.seat.bindingId, spec),
        );
      }),
  });

/** Station term-control surface. `kill` is unused — occupy never replaces. */
export type RemoteSeatProcessClient = {
  readonly get: (bindingId: string) => Promise<TerminalSessionSummary | undefined>;
  readonly createAgentSeat: (input: OccupySpec) => Promise<TerminalSessionSummary>;
  readonly kill?: (bindingId: string) => Promise<boolean>;
};

const remoteSummaryOccupancy = (
  bindingId: string,
  summary: TerminalSessionSummary | undefined,
): SeatOccupancy => occupancyFromSummary(bindingId, summary, "remote");

export const makeRemoteSeatProcess = (
  client: RemoteSeatProcessClient,
): Context.Service.Shape<typeof TerminalSeatProcess> =>
  TerminalSeatProcess.of({
    occupancy: (bindingId) =>
      Effect.promise(() => client.get(bindingId)).pipe(
        Effect.map((summary) => remoteSummaryOccupancy(bindingId, summary)),
      ),
    occupy: (command, spec) =>
      Effect.gen(function* () {
        const summary = yield* Effect.tryPromise({
          try: () => client.get(command.seat.bindingId),
          catch: asClientError,
        });
        const occupy = occupyVacantSeat(
          remoteSummaryOccupancy(command.seat.bindingId, summary),
        );
        if (Result.isFailure(occupy)) {
          return yield* occupy.failure;
        }
        return yield* Effect.tryPromise({
          try: () =>
            client.createAgentSeat({
              bindingId: spec.bindingId,
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
            }),
          catch: asClientError,
        });
      }),
    activate: (command, spec) =>
      Effect.gen(function* () {
        const summary = yield* Effect.tryPromise({
          try: () => client.get(command.seat.bindingId),
          catch: asClientError,
        });
        const activate = activateOccupiedSeat(
          remoteSummaryOccupancy(command.seat.bindingId, summary),
        );
        if (Result.isFailure(activate)) {
          return yield* activate.failure;
        }
        if (!summary) {
          return yield* SeatVacantError.make({
            bindingId: command.seat.bindingId,
            message: `seat ${command.seat.bindingId} is vacant; activate requires an occupant`,
          });
        }
        return yield* adoptIfGeography(summary, spec, () => summary);
      }),
  });
