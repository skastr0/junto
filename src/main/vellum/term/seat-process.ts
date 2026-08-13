/**
 * One seat contract. Local PTY and Remote station are Layers.
 *
 * Occupancy law is shared. Placement selects the process implementation
 * (this-process PTY vs station-forwarded generation). macOS / Linux / Windows
 * spawn details stay inside the local Layer.
 */
import { Context, Effect, Result } from "effect";
import type { TerminalLaunch, TerminalSessionSummary } from "@shared/terminal";
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
import type { LocalHostAgentSeatInput, LocalSessionHost } from "./local-host";

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
  readonly harness?: LocalHostAgentSeatInput["harness"];
  readonly agentKey?: string;
  readonly firstTypedMessage?: string;
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

const summaryOccupancy = (
  host: LocalSessionHost,
  bindingId: string,
): SeatOccupancy => occupancyFromSummary(bindingId, host.get(bindingId), "local");

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
        if (spec.harness && spec.agentKey) {
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
        }
        return host.create({
          bindingId: spec.bindingId,
          hostId: spec.hostId,
          launch: spec.launch,
          cols: spec.cols,
          rows: spec.rows,
          canvasName: spec.canvasName,
          nodeId: spec.nodeId,
          label: spec.label,
          title: spec.title,
        });
      }),
    activate: (command) =>
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
        return live;
      }),
  });

/** Station term-control surface. `kill` is unused — occupy never replaces. */
export type RemoteSeatProcessClient = {
  readonly get: (bindingId: string) => Promise<TerminalSessionSummary | undefined>;
  readonly create: (
    input: Pick<
      OccupySpec,
      "bindingId" | "launch" | "cols" | "rows" | "canvasName" | "nodeId" | "label"
    >,
  ) => Promise<TerminalSessionSummary>;
  readonly kill?: (bindingId: string) => Promise<boolean>;
};

const asClientError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

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
            client.create({
              bindingId: spec.bindingId,
              launch: spec.launch,
              cols: spec.cols,
              rows: spec.rows,
              canvasName: spec.canvasName,
              nodeId: spec.nodeId,
              label: spec.label,
            }),
          catch: asClientError,
        });
      }),
    activate: (command) =>
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
        return summary;
      }),
  });
