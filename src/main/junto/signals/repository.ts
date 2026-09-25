import { Context, Effect, Layer, Schema } from "effect";
import { ulid } from "ulid";
import type {
  AgentSignal,
  AgentSignalKind,
  AgentSignalState,
} from "@shared/agent-signals";
import {
  StateEngine,
  type StateEngineError,
  type StateReader,
  type StateRow,
} from "../state/service";

export class AgentSignalPersistenceError extends Schema.TaggedError<AgentSignalPersistenceError>()(
  "AgentSignalPersistenceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

/** The signal does not exist, or is not open, or is not this seat's. */
export class AgentSignalNotFound extends Schema.TaggedError<AgentSignalNotFound>()(
  "AgentSignalNotFound",
  {
    signalId: Schema.String,
    message: Schema.String,
  },
) {}

export type AgentSignalRepositoryError =
  | AgentSignalPersistenceError
  | AgentSignalNotFound;

export type AgentSignalSeat = {
  readonly canvasName: string;
  readonly nodeId: string;
};

export type RaiseAgentSignal = AgentSignalSeat & {
  readonly kind: AgentSignalKind;
  readonly text: string;
  readonly detail?: string;
};

/** Closed signals kept per seat in listings; open ones are always listed. */
export const AGENT_SIGNAL_CLOSED_HISTORY = 20;

/**
 * Durable agent signals (`agent_signals`). Seat-side writes take the caller's
 * own seat and never a foreign one; operator-side writes take a signal id.
 */
export class AgentSignalRepository extends Context.Service<AgentSignalRepository,
  {
    readonly raise: (
      input: RaiseAgentSignal,
    ) => Effect.Effect<AgentSignal, AgentSignalRepositoryError>;
    /**
     * The seat withdraws its own open signals: one by id, or all when no id.
     * An id that is not an open signal of this seat fails `AgentSignalNotFound`.
     */
    readonly withdraw: (
      seat: AgentSignalSeat,
      signalId?: string,
    ) => Effect.Effect<ReadonlyArray<AgentSignal>, AgentSignalRepositoryError>;
    readonly listSeat: (
      seat: AgentSignalSeat,
    ) => Effect.Effect<ReadonlyArray<AgentSignal>, AgentSignalRepositoryError>;
    /** Open signals plus recent history for every seat on a canvas. */
    readonly listCanvas: (
      canvasName: string,
    ) => Effect.Effect<ReadonlyArray<AgentSignal>, AgentSignalRepositoryError>;
    readonly get: (
      signalId: string,
    ) => Effect.Effect<AgentSignal, AgentSignalRepositoryError>;
    /** Operator answer: open to answered with the response recorded. */
    readonly answer: (
      signalId: string,
      text: string,
    ) => Effect.Effect<AgentSignal, AgentSignalRepositoryError>;
    readonly dismiss: (
      signalId: string,
    ) => Effect.Effect<AgentSignal, AgentSignalRepositoryError>;
  }>()("@junto/AgentSignalRepository") {}

type SignalRow = StateRow & {
  readonly signal_id: string;
  readonly canvas_name: string;
  readonly node_id: string;
  readonly kind: string;
  readonly text: string;
  readonly detail: string | null;
  readonly created_at: number;
  readonly state: string;
  readonly response_text: string | null;
  readonly response_at: number | null;
  readonly closed_at: number | null;
};

const COLUMNS = `
  signal_id, canvas_name, node_id, kind, text, detail, created_at, state,
  response_text, response_at, closed_at
`;

/**
 * Rows this process wrote, held to the domain by the table's CHECKs (kind,
 * state, bounds, and the open/answered pairing), so they map without a decode.
 */
const fromRow = (row: SignalRow): AgentSignal => ({
  signalId: row.signal_id,
  canvasName: row.canvas_name,
  nodeId: row.node_id,
  kind: row.kind as AgentSignalKind,
  text: row.text,
  ...(row.detail === null ? {} : { detail: row.detail }),
  createdAt: Number(row.created_at),
  state: row.state as AgentSignalState,
  ...(row.response_text === null || row.response_at === null
    ? {}
    : { response: { text: row.response_text, at: Number(row.response_at) } }),
  ...(row.closed_at === null ? {} : { closedAt: Number(row.closed_at) }),
});

const readOne = (reader: StateReader, signalId: string): AgentSignal | undefined => {
  const row = reader.get<SignalRow>(
    `SELECT ${COLUMNS} FROM agent_signals WHERE signal_id = ?`,
    [signalId],
  );
  return row === undefined ? undefined : fromRow(row);
};

/** Open first (newest first), then the newest closed history per seat. */
const listWhere = (
  reader: StateReader,
  where: string,
  bindings: ReadonlyArray<string>,
): ReadonlyArray<AgentSignal> =>
  reader
    .all<SignalRow>(
      `
        SELECT ${COLUMNS} FROM (
          SELECT *,
            ROW_NUMBER() OVER (
              PARTITION BY canvas_name, node_id, state = 'open'
              ORDER BY created_at DESC, signal_id DESC
            ) AS seat_rank
          FROM agent_signals
          WHERE ${where}
        )
        WHERE state = 'open' OR seat_rank <= ${AGENT_SIGNAL_CLOSED_HISTORY}
        ORDER BY state <> 'open', created_at DESC, signal_id DESC
      `,
      [...bindings],
    )
    .map(fromRow);

const notFound = (signalId: string, message: string) =>
  AgentSignalNotFound.make({ signalId, message });

const persistence = (operation: string) => (error: StateEngineError) =>
  error.cause instanceof AgentSignalNotFound
    ? error.cause
    : AgentSignalPersistenceError.make({
        operation,
        message: error.message,
        cause: error,
      });

export const AgentSignalRepositoryLive: Layer.Layer<
  AgentSignalRepository,
  never,
  StateEngine
> = Layer.effect(
  AgentSignalRepository,
  Effect.gen(function* () {
    const state = yield* StateEngine;

    const raise = (input: RaiseAgentSignal) =>
      state
        .transaction("agent-signals.raise", (writer) => {
          const signalId = ulid();
          writer.run(
            `
              INSERT INTO agent_signals(
                signal_id, canvas_name, node_id, kind, text, detail,
                created_at, state
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open')
            `,
            [
              signalId,
              input.canvasName,
              input.nodeId,
              input.kind,
              input.text,
              input.detail ?? null,
              Date.now(),
            ],
          );
          return readOne(writer, signalId)!;
        })
        .pipe(Effect.mapError(persistence("raise")));

    const withdraw = (seat: AgentSignalSeat, signalId?: string) =>
      state
        .transaction("agent-signals.withdraw", (writer) => {
          const ids = signalId === undefined
            ? writer
                .all<SignalRow>(
                  `
                    SELECT ${COLUMNS} FROM agent_signals
                    WHERE canvas_name = ? AND node_id = ? AND state = 'open'
                  `,
                  [seat.canvasName, seat.nodeId],
                )
                .map((row) => row.signal_id)
            : [signalId];
          const now = Date.now();
          for (const id of ids) {
            const changed = writer.run(
              `
                UPDATE agent_signals
                SET state = 'withdrawn', closed_at = ?
                WHERE signal_id = ? AND canvas_name = ? AND node_id = ?
                  AND state = 'open'
              `,
              [now, id, seat.canvasName, seat.nodeId],
            );
            if (Number(changed.changes) === 0) {
              throw notFound(id, `signal ${id} is not an open signal of this seat`);
            }
          }
          return ids.map((id) => readOne(writer, id)!);
        })
        .pipe(Effect.mapError(persistence("withdraw")));

    const listSeat = (seat: AgentSignalSeat) =>
      state
        .read("agent-signals.list-seat", (reader) =>
          listWhere(reader, "canvas_name = ? AND node_id = ?", [
            seat.canvasName,
            seat.nodeId,
          ]))
        .pipe(Effect.mapError(persistence("list seat")));

    const listCanvas = (canvasName: string) =>
      state
        .read("agent-signals.list-canvas", (reader) =>
          listWhere(reader, "canvas_name = ?", [canvasName]))
        .pipe(Effect.mapError(persistence("list canvas")));

    const get = (signalId: string) =>
      state
        .read("agent-signals.get", (reader) => {
          const signal = readOne(reader, signalId);
          if (!signal) throw notFound(signalId, `no signal ${signalId}`);
          return signal;
        })
        .pipe(Effect.mapError(persistence("get")));

    const close = (
      operation: string,
      signalId: string,
      sql: string,
      bindings: ReadonlyArray<string | number>,
    ) =>
      state
        .transaction(`agent-signals.${operation}`, (writer) => {
          const changed = writer.run(sql, [...bindings]);
          if (Number(changed.changes) === 0) {
            throw notFound(signalId, `signal ${signalId} is not open`);
          }
          return readOne(writer, signalId)!;
        })
        .pipe(Effect.mapError(persistence(operation)));

    const answer = (signalId: string, text: string) => {
      const now = Date.now();
      return close(
        "answer",
        signalId,
        `
          UPDATE agent_signals
          SET state = 'answered', response_text = ?, response_at = ?, closed_at = ?
          WHERE signal_id = ? AND state = 'open'
        `,
        [text, now, now, signalId],
      );
    };

    const dismiss = (signalId: string) =>
      close(
        "dismiss",
        signalId,
        `
          UPDATE agent_signals
          SET state = 'dismissed', closed_at = ?
          WHERE signal_id = ? AND state = 'open'
        `,
        [Date.now(), signalId],
      );

    return AgentSignalRepository.of({
      raise,
      withdraw,
      listSeat,
      listCanvas,
      get,
      answer,
      dismiss,
    });
  }),
);
