import { Context, Effect, Schema } from "effect";

/**
 * Pure StateEngine contract. Keep this module free of `node:sqlite` so
 * projection-only callers can import service types without loading a database
 * driver in runtimes (notably Bun) that do not provide that built-in.
 */
export type StateInputValue =
  | null
  | number
  | bigint
  | string
  | Uint8Array;
export type StateOutputValue = StateInputValue;

export type StateRow = Record<string, StateOutputValue>;
export type StateBindings =
  | ReadonlyArray<StateInputValue>
  | Readonly<Record<string, StateInputValue>>;

export type StateRunResult = {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
};

export class StateEngineError extends Schema.TaggedError<StateEngineError>()(
  "StateEngineError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}

/**
 * Read-only SQL surface. Statements are cached by exact SQL text for the
 * lifetime of the engine, so repositories can keep SQL local without each
 * building its own prepare cache.
 */
export interface StateReader {
  readonly get: <Row extends StateRow = StateRow>(
    sql: string,
    bindings?: StateBindings,
  ) => Row | undefined;
  readonly all: <Row extends StateRow = StateRow>(
    sql: string,
    bindings?: StateBindings,
  ) => ReadonlyArray<Row>;
}

/** A writer exists only inside StateEngine.transaction / chunkedWrite. */
export interface StateWriter extends StateReader {
  readonly run: (
    sql: string,
    bindings?: StateBindings,
  ) => StateRunResult;
}

export type StateEngineInfo = {
  readonly path: string;
  readonly journalMode: string;
  readonly synchronous: number;
  readonly foreignKeys: boolean;
  readonly schemaSha256: string;
};

export class StateEngine extends Context.Tag("@vellum/StateEngine")<
  StateEngine,
  {
    readonly info: StateEngineInfo;
    readonly read: <A>(
      operation: string,
      body: (reader: StateReader) => A,
    ) => Effect.Effect<A, StateEngineError>;
    /**
     * One synchronous BEGIN IMMEDIATE transaction. The callback cannot yield,
     * so no other fiber can observe a half-applied domain transition.
     */
    readonly transaction: <A>(
      operation: string,
      body: (writer: StateWriter) => A,
    ) => Effect.Effect<A, StateEngineError>;
    /**
     * Large imports are intentionally several small transactions with a real
     * event-loop turn between chunks. Atomicity is per chunk; callers use this
     * only for resumable/idempotent bulk work, never one domain transition.
     */
    readonly chunkedWrite: <A>(
      operation: string,
      rows: ReadonlyArray<A>,
      body: (writer: StateWriter, chunk: ReadonlyArray<A>) => void,
      options?: { readonly chunkRows?: number },
    ) => Effect.Effect<void, StateEngineError>;
    /**
     * Create a coherent live backup. SQLite refuses an existing destination,
     * so this operation never silently overwrites an operator file.
     */
    readonly backup: (
      destination: string,
    ) => Effect.Effect<{ readonly path: string }, StateEngineError>;
  }
>() {}
