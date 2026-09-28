import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlError, SqlSchema } from "effect/unstable/sql";
import { ulid } from "ulid";
import {
  type AgentSignal,
  AgentSignalKind,
  AgentSignalState,
} from "@shared/agent-signals";
import { StateTransactionOperation } from "../state/service";

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
    /** Every open blocked or escalate signal, on every canvas: raised hands. */
    readonly listRaisedHands: Effect.Effect<
      ReadonlyArray<AgentSignal>,
      AgentSignalRepositoryError
    >;
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

const SignalRow = Schema.Struct({
  signal_id: Schema.String,
  canvas_name: Schema.String,
  node_id: Schema.String,
  kind: AgentSignalKind,
  text: Schema.String,
  detail: Schema.NullOr(Schema.String),
  created_at: Schema.Number,
  state: AgentSignalState,
  response_text: Schema.NullOr(Schema.String),
  response_at: Schema.NullOr(Schema.Number),
  closed_at: Schema.NullOr(Schema.Number),
});

const COLUMNS = `
  signal_id, canvas_name, node_id, kind, text, detail, created_at, state,
  response_text, response_at, closed_at
`;

const fromRow = (row: typeof SignalRow.Type): AgentSignal => ({
  signalId: row.signal_id,
  canvasName: row.canvas_name,
  nodeId: row.node_id,
  kind: row.kind,
  text: row.text,
  ...(row.detail === null ? {} : { detail: row.detail }),
  createdAt: Number(row.created_at),
  state: row.state,
  ...(row.response_text === null || row.response_at === null
    ? {}
    : { response: { text: row.response_text, at: Number(row.response_at) } }),
  ...(row.closed_at === null ? {} : { closedAt: Number(row.closed_at) }),
});

const notFound = (signalId: string, message: string) =>
  AgentSignalNotFound.make({ signalId, message });

const persistence = (operation: string) => (error: SqlError.SqlError | Schema.SchemaError | AgentSignalNotFound) =>
  error instanceof AgentSignalNotFound
    ? error
    : AgentSignalPersistenceError.make({
        operation,
        message: error.message,
        cause: error,
      });

export const AgentSignalRepositoryLive: Layer.Layer<
  AgentSignalRepository,
  never,
  SqlClient.SqlClient
> = Layer.effect(
  AgentSignalRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const changes = Schema.decodeUnknownEffect(Schema.Struct({ changes: Schema.Union([Schema.Number, Schema.BigInt]) }));
    const oneRow = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: SignalRow,
      execute: (signalId) => sql.unsafe(`SELECT ${COLUMNS} FROM agent_signals WHERE signal_id = ?`, [signalId]),
    });
    const readOne = Effect.fn("agent-signals.read-one")(function* (signalId: string) {
      const row = yield* oneRow(signalId);
      return row._tag === "None" ? undefined : fromRow(row.value);
    });
    const openSeatRows = SqlSchema.findAll({
      Request: Schema.Struct({ canvasName: Schema.String, nodeId: Schema.String }),
      Result: SignalRow,
      execute: (seat) => sql.unsafe(`SELECT ${COLUMNS} FROM agent_signals
        WHERE canvas_name = ? AND node_id = ? AND state = 'open'`, [seat.canvasName, seat.nodeId]),
    });
    // Open first (newest first), then the newest closed history per seat.
    const listRows = SqlSchema.findAll({
      Request: Schema.Tuple([Schema.String, Schema.Array(Schema.String)]),
      Result: SignalRow,
      execute: ([where, bindings]) => sql.unsafe(`
        SELECT ${COLUMNS} FROM (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY canvas_name, node_id, state = 'open'
            ORDER BY created_at DESC, signal_id DESC
          ) AS seat_rank
          FROM agent_signals WHERE ${where}
        )
        WHERE state = 'open' OR seat_rank <= ${AGENT_SIGNAL_CLOSED_HISTORY}
        ORDER BY state <> 'open', created_at DESC, signal_id DESC
      `, bindings),
    });
    const raisedHandsRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: SignalRow,
      execute: () => sql.unsafe(`SELECT ${COLUMNS} FROM agent_signals
        WHERE state = 'open' AND kind IN ('blocked', 'escalate')`),
    });

    const raise = Effect.fn("agent-signals.raise")(function* (input: RaiseAgentSignal) {
      const signalId = ulid();
      yield* sql`
        INSERT INTO agent_signals(signal_id, canvas_name, node_id, kind, text, detail, created_at, state)
        VALUES (${signalId}, ${input.canvasName}, ${input.nodeId}, ${input.kind}, ${input.text}, ${input.detail ?? null}, ${Date.now()}, 'open')
      `;
      return (yield* readOne(signalId))!;
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "agent-signals.raise"),
    Effect.mapError(persistence("raise")));

    const withdraw = Effect.fn("agent-signals.withdraw")(function* (seat: AgentSignalSeat, signalId?: string) {
      const ids = signalId === undefined
        ? (yield* openSeatRows(seat)).map((row) => row.signal_id)
        : [signalId];
      const now = Date.now();
      for (const id of ids) {
        const changed = yield* sql`
          UPDATE agent_signals SET state = 'withdrawn', closed_at = ${now}
          WHERE signal_id = ${id} AND canvas_name = ${seat.canvasName} AND node_id = ${seat.nodeId} AND state = 'open'
        `.raw.pipe(Effect.flatMap(changes));
        if (Number(changed.changes) === 0) {
          return yield* notFound(id, `signal ${id} is not an open signal of this seat`);
        }
      }
      return yield* Effect.forEach(ids, (id) => readOne(id).pipe(Effect.map((signal) => signal!)));
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "agent-signals.withdraw"),
    Effect.mapError(persistence("withdraw")));

    const listSeat = Effect.fn("agent-signals.list-seat")(function* (seat: AgentSignalSeat) {
      return (yield* listRows(["canvas_name = ? AND node_id = ?", [seat.canvasName, seat.nodeId]])).map(fromRow);
    }, Effect.mapError(persistence("list seat")));

    const listCanvas = Effect.fn("agent-signals.list-canvas")(function* (canvasName: string) {
      return (yield* listRows(["canvas_name = ?", [canvasName]])).map(fromRow);
    }, Effect.mapError(persistence("list canvas")));

    const listRaisedHands = Effect.fn("agent-signals.list-raised-hands")(function* () {
      return (yield* raisedHandsRows(undefined)).map(fromRow);
    }, Effect.mapError(persistence("list raised hands")))();

    const get = Effect.fn("agent-signals.get")(function* (signalId: string) {
      const signal = yield* readOne(signalId);
      if (!signal) return yield* notFound(signalId, `no signal ${signalId}`);
      return signal;
    }, Effect.mapError(persistence("get")));

    const close = Effect.fn("agent-signals.close")(function* (
      operation: string,
      signalId: string,
      query: string,
      bindings: ReadonlyArray<string | number>,
    ) {
      const changed = yield* sql.unsafe(query, bindings).raw.pipe(Effect.flatMap(changes));
      if (Number(changed.changes) === 0) {
        return yield* notFound(signalId, `signal ${signalId} is not open`);
      }
      return (yield* readOne(signalId))!;
    }, sql.withTransaction, (effect, operation) => effect.pipe(
      Effect.provideService(StateTransactionOperation, `agent-signals.${operation}`),
      Effect.mapError(persistence(operation)),
    ));

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
      listRaisedHands,
      listCanvas,
      get,
      answer,
      dismiss,
    });
  }),
);
