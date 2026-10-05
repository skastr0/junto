import { Context, Effect, Schema } from "effect";

/**
 * State owner metadata and backup capability. Repositories use the SqlClient
 * published by the same Layer; the raw connection never escapes its owner.
 */
export class StateEngineError extends Schema.TaggedError<StateEngineError>()(
  "StateEngineError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

/** Attribution retained across an owning SQL transaction and its receipts. */
export const StateTransactionOperation = Context.Reference<string>(
  "@junto/StateTransactionOperation",
  { defaultValue: () => "sql.transaction" },
);

export type StateEngineInfo = {
  readonly path: string;
  readonly journalMode: string;
  readonly synchronous: number;
  readonly foreignKeys: boolean;
  readonly schemaSha256: string;
  readonly schemaVersion: number;
};

/**
 * Evidence for a coherent backup minted inside StateEngine's private state
 * directory. Callers can move or export this file through a separately
 * authorized product surface, but cannot choose where StateEngine writes.
 */
export type StateBackupReceipt = {
  readonly path: string;
  readonly schemaSha256: string;
  readonly schemaVersion: number;
};

/** Implementation shape for the sole product database owner. */
export type StateEngineShape = {
  readonly info: StateEngineInfo;
  /**
   * Create a coherent live backup at an engine-minted, owner-only path.
   * There is deliberately no caller-selected destination capability.
   */
  readonly backup: () => Effect.Effect<StateBackupReceipt, StateEngineError>;
};

/**
 * Sole product SQLite engine (junto.db).
 *
 * - Canonical id: `@junto/StateEngine` — single `Context.Service` definition.
 * - Layer: `StateEngineLive` / `makeStateEngineLive` (engine.ts).
 */
export class StateEngine extends Context.Service<StateEngine,
  StateEngineShape>()("@junto/StateEngine") {}
