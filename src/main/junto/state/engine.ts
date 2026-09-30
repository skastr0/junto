import {
  chmodSync,
  lstatSync,
  mkdirSync,
} from "node:fs";
import { resolveJuntoHome } from "@shared/junto-home";
import { dirname, join, resolve } from "node:path";
import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import { Context, Effect, Layer, Option, Semaphore } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient, SqlError } from "effect/unstable/sql";
import { OverseerLiveExecution } from "../overseer/live/execution";
import {
  StateEngine,
  StateEngineError,
  StateTransactionOperation,
  type StateBackupReceipt,
  type StateBindings,
  type StateEngineInfo,
  type StateEngineShape,
  type StateReader,
  type StateRow,
  type StateWriter,
} from "./service";
import { withinBudget } from "../observability/main-thread-budget";
import {
  admitWorkStatement,
  beginWorkMutationScope,
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
  type StateBindings,
  type StateEngineInfo,
  type StateInputValue,
  type StateOutputValue,
  type StateReader,
  type StateRow,
  type StateRunResult,
  type StateWriter,
} from "./service";

const STATE_DIRECTORY_MODE = 0o700;
const STATE_FILE_MODE = 0o600;
const STATE_BUSY_TIMEOUT_MS = 5_000;
export const STATE_BULK_CHUNK_ROWS = 64;

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

const applyBindings = <A>(
  statement: StatementSync,
  bindings: StateBindings | undefined,
  positional: (...values: SQLInputValue[]) => A,
  named: (values: Record<string, SQLInputValue>) => A,
): A => {
  if (bindings === undefined) return positional();
  if (Array.isArray(bindings)) return positional(...bindings);
  return named({
    ...(bindings as Readonly<Record<string, SQLInputValue>>),
  });
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
      const statements = new Map<string, StatementSync>();
      const semaphore = Semaphore.makeUnsafe(1);
      // Initialized once by the Layer before either published service can run.
      let client: SqlClient.SqlClient;

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

      const prepare = (sql: string): StatementSync => {
        requireOpen();
        const existing = statements.get(sql);
        if (existing) return existing;
        const statement = database.prepare(sql);
        statements.set(sql, statement);
        return statement;
      };

      const reader: StateReader = {
        get: <Row extends StateRow>(
          sql: string,
          bindings?: StateBindings,
        ): Row | undefined => {
          return applyBindings(
            prepare(sql),
            bindings,
            (...values) => prepare(sql).get(...values) as Row | undefined,
            (values) => prepare(sql).get(values) as Row | undefined,
          );
        },
        all: <Row extends StateRow>(
          sql: string,
          bindings?: StateBindings,
        ): ReadonlyArray<Row> => {
          return applyBindings(
            prepare(sql),
            bindings,
            (...values) => prepare(sql).all(...values) as Row[],
            (values) => prepare(sql).all(values) as Row[],
          );
        },
      };

      const writer: StateWriter = {
        ...reader,
        run: (
          sql: string,
          bindings?: StateBindings,
        ) => {
          // The work plane's single mutation seam. Classification is cached by
          // exact SQL text, so a non-work statement costs one map hit.
          admitWorkStatement(sql, bindings);
          return applyBindings(
            prepare(sql),
            bindings,
            (...values) => prepare(sql).run(...values),
            (values) => prepare(sql).run(values),
          );
        },
      };

      const read = <A>(
        operation: string,
        body: (stateReader: StateReader) => A,
      ): Effect.Effect<A, StateEngineError> =>
        Effect.try({
          try: () => {
            requireOpen();
            return body(reader);
          },
          catch: (error) => stateEngineError(operation, error),
        }).pipe(semaphore.withPermit, Effect.withSpan(`state.${operation}`));

      const transaction = <A>(
        operation: string,
        body: (stateWriter: StateWriter) => A,
      ): Effect.Effect<A, StateEngineError> =>
        Effect.suspend(() => client.withTransaction(Effect.try({
          // Temporary raw callers share the SQL lease and Effect hooks. Only
          // their synchronous body holds the synchronous Work/budget scope.
          try: () => withinBudget(`state.${operation}`, () => {
            requireOpen();
            const closeWorkMutationScope = beginWorkMutationScope(operation);
            try {
              return body(writer);
            } finally {
              closeWorkMutationScope();
            }
          }),
          catch: (error) => stateEngineError(operation, error),
        }))).pipe(
          Effect.provideService(StateTransactionOperation, operation),
          Effect.mapError((error) => stateEngineError(operation, error)),
          Effect.withSpan(`state.${operation}`),
        );

      const chunkedWrite = <A>(
        operation: string,
        rows: ReadonlyArray<A>,
        body: (stateWriter: StateWriter, chunk: ReadonlyArray<A>) => void,
        options: { readonly chunkRows?: number } = {},
      ): Effect.Effect<void, StateEngineError> =>
        Effect.gen(function* () {
          const chunkRows = Math.max(
            1,
            Math.floor(options.chunkRows ?? STATE_BULK_CHUNK_ROWS),
          );
          for (let offset = 0; offset < rows.length; offset += chunkRows) {
            const chunk = rows.slice(offset, offset + chunkRows);
            yield* transaction(`${operation}.chunk`, (stateWriter) =>
              body(stateWriter, chunk)
            );
            if (offset + chunkRows < rows.length) {
              yield* Effect.sleep("1 millis");
            }
          }
        }).pipe(Effect.withSpan(`state.${operation}`));

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

      const journalMode =
        reader.get<{ journal_mode: SQLOutputValue }>(
          "PRAGMA journal_mode",
        )?.journal_mode;
      const synchronous =
        reader.get<{ synchronous: SQLOutputValue }>(
          "PRAGMA synchronous",
        )?.synchronous;
      const foreignKeys =
        reader.get<{ foreign_keys: SQLOutputValue }>(
          "PRAGMA foreign_keys",
        )?.foreign_keys;

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
          read,
          transaction,
          chunkedWrite,
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
          client = Object.assign(sql, { withTransaction: guardedTransaction });
          installSqlCommitCallbacks(sql);
          return client;
        }),
        close: () => {
          if (closed) return;
          closed = true;
          statements.clear();
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
