import {
  chmodSync,
  lstatSync,
  mkdirSync,
} from "node:fs";
import { resolveJuntoHome } from "@shared/junto-home";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Context, Effect, Layer, Option, Semaphore } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient, SqlError } from "effect/unstable/sql";
import { OverseerLiveExecution } from "../overseer/live/execution";
import {
  StateEngine,
  StateEngineError,
  StateTransactionOperation,
  type StateBackupReceipt,
  type StateEngineInfo,
  type StateEngineShape,
} from "./service";
import {
  admitWorkStatement,
  WorkMutationContext,
  type WorkMutationScope,
} from "../work/mutation-seam";
import { demoStateDatabasePath } from "../demo/runtime-isolation";
import {
  createVerifiedStateBackup,
  reconcilePendingStateBackups,
} from "./backup";
import {
  migrateStateSchema,
  stateSchemaAdvanceRequired,
} from "./migrations";
import { makeSqliteClient } from "./sqlite-client";
import { installSqlCommitCallbacks } from "./sql-commit";

export {
  StateEngine,
  StateEngineError,
  type StateBackupReceipt,
  type StateEngineInfo,
} from "./service";

const STATE_DIRECTORY_MODE = 0o700;
const STATE_FILE_MODE = 0o600;
const STATE_BUSY_TIMEOUT_MS = 5_000;

const stateEngineError = (
  operation: string,
  cause: unknown,
): StateEngineError =>
  cause instanceof StateEngineError
    ? cause
    : StateEngineError.make({
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });

/**
 * Resolve the sole product database. Demo mode receives only a process-minted
 * ephemeral database; no environment variable can redirect product authority.
 * Tests that exercise a StateEngine directly inject a path into
 * makeStateEngineLive instead of creating a second runtime convention.
 */
export const stateDatabasePath = (): string =>
  resolve(
    demoStateDatabasePath() ??
      join(resolveJuntoHome(), ".junto", "state", "junto.db"),
  );

const assertRealDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: STATE_DIRECTORY_MODE });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`state path is not a real directory: ${path}`);
  }
  chmodSync(path, STATE_DIRECTORY_MODE);
};

const assertRegularOrMissing = (path: string): boolean => {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`state database is not a regular file: ${path}`);
    }
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
};

type OpenStateEngine = {
  readonly service: StateEngineShape;
  readonly client: Effect.Effect<SqlClient.SqlClient, never, Reactivity.Reactivity>;
  readonly close: () => void;
};

const openStateEngine = (
  configuredPath?: string,
): Effect.Effect<OpenStateEngine, StateEngineError> =>
  Effect.try({
    try: () => {
      const path = resolve(configuredPath ?? stateDatabasePath());
      const directory = dirname(path);
      assertRealDirectory(directory);
      assertRegularOrMissing(path);

      const database = new DatabaseSync(path, {
        open: true,
        readOnly: false,
        allowExtension: false,
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
        allowBareNamedParameters: false,
        allowUnknownNamedParameters: false,
        timeout: STATE_BUSY_TIMEOUT_MS,
      });
      let closed = false;
      const semaphore = Semaphore.makeUnsafe(1);

      const schemaState = (() => {
        try {
          chmodSync(path, STATE_FILE_MODE);
          database.exec(`
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = ${STATE_BUSY_TIMEOUT_MS};
            PRAGMA trusted_schema = OFF;
          `);
          if (stateSchemaAdvanceRequired(database)) {
            createVerifiedStateBackup(database, directory);
          }
          const migrated = migrateStateSchema(database);
          reconcilePendingStateBackups(directory);
          // journal_mode persists in the database. Apply it only after schema
          // admission so an older binary rejects a newer database without
          // changing it.
          database.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
          `);
          return migrated;
        } catch (error) {
          database.close();
          throw error;
        }
      })();

      const requireOpen = (): void => {
        if (closed) throw new Error("state engine is closed");
      };

      const backup = (): Effect.Effect<
        StateBackupReceipt,
        StateEngineError
      > =>
        Effect.try({
          try: () => {
            requireOpen();
            return createVerifiedStateBackup(database, directory);
          },
          catch: (error) => stateEngineError("backup", error),
        }).pipe(semaphore.withPermit, Effect.withSpan("state.backup"));

      const journalMode = database.prepare("PRAGMA journal_mode").get()?.journal_mode;
      const synchronous = database.prepare("PRAGMA synchronous").get()?.synchronous;
      const foreignKeys = database.prepare("PRAGMA foreign_keys").get()?.foreign_keys;

      const info: StateEngineInfo = {
        path,
        journalMode: String(journalMode ?? ""),
        synchronous: Number(synchronous ?? -1),
        foreignKeys: Number(foreignKeys ?? 0) === 1,
        schemaSha256: schemaState.actualSchemaSha256,
        schemaVersion: schemaState.schemaVersion,
      };

      return {
        service: StateEngine.of({
          info,
          backup,
        }),
        client: Effect.gen(function* () {
          const sql = yield* makeSqliteClient(database, semaphore, (query, params, context) => {
            admitWorkStatement(query, params, Context.get(context, WorkMutationContext));
          });
          const withTransaction = sql.withTransaction;
          const guardedTransaction: SqlClient.SqlClient["withTransaction"] = Effect.fn("state.sql.transaction")(function*<A, E, R>(body: Effect.Effect<A, E, R>) {
            const operation = yield* StateTransactionOperation;
            const nested = yield* Effect.serviceOption(sql.transactionService);
            const parent = Option.isSome(nested) ? yield* WorkMutationContext : null;
            const live = yield* Effect.serviceOption(OverseerLiveExecution);
            const hookError = (cause: unknown) => new SqlError.SqlError({ reason: new SqlError.UnknownError({
              cause, operation, message: cause instanceof Error ? cause.message : String(cause),
            }) });
            return yield* withTransaction(Effect.gen(function* () {
              const scope: WorkMutationScope = {
                operation,
                journaled: parent?.journaled ?? false,
                unjournaled: parent?.unjournaled,
              };
              if (Option.isSome(live)) yield* live.value.assertCurrentWithin.pipe(Effect.mapError(hookError));
              const before = Option.isSome(live) ? (yield* sql`SELECT total_changes() AS n`)[0]!.n : undefined;
              const result = yield* body.pipe(Effect.provideService(WorkMutationContext, scope));
              if (Option.isSome(live) && live.value.afterMutation && (yield* sql`SELECT total_changes() AS n`)[0]!.n !== before) {
                yield* live.value.afterMutation(operation).pipe(Effect.mapError(hookError));
              }
              if (parent) parent.journaled ||= scope.journaled;
              return result;
            }));
          });
          Object.assign(sql, { withTransaction: guardedTransaction });
          installSqlCommitCallbacks(sql);
          return sql;
        }),
        close: () => {
          if (closed) return;
          closed = true;
          database.close();
        },
      };
    },
    catch: (error) => stateEngineError("open", error),
  });

export const makeStateEngineLive = (
  path?: string,
): Layer.Layer<StateEngine | SqlClient.SqlClient, StateEngineError> =>
  Layer.effectContext(Effect.gen(function* () {
    const opened = yield* Effect.acquireRelease(
      openStateEngine(path),
      ({ close }) => Effect.sync(close),
    );
    const client = yield* opened.client;
    return Context.make(StateEngine, opened.service).pipe(Context.add(SqlClient.SqlClient, client));
  })).pipe(Layer.provide(Reactivity.layer));

export const StateEngineLive = makeStateEngineLive();
