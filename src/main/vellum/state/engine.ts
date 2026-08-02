import {
  chmodSync,
  lstatSync,
  mkdirSync,
} from "node:fs";
import { resolveVellumHome } from "@shared/vellum-home";
import { dirname, join, resolve } from "node:path";
import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import { Effect, Layer } from "effect";
import {
  StateEngine,
  StateEngineError,
  type StateBackupReceipt,
  type StateBindings,
  type StateEngineInfo,
  type StateEngineShape,
  type StateReader,
  type StateRow,
  type StateWriter,
} from "./service";
import { demoStateDatabasePath } from "../demo/runtime-isolation";
import { createVerifiedStateBackup } from "./backup";
import {
  migrateStateSchema,
  stateSchemaAdvanceRequired,
} from "./migrations";

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
      join(resolveVellumHome(), ".vellum", "state", "vellum.db"),
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
      let transactionOpen = false;

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
        ): Row | undefined =>
          applyBindings(
            prepare(sql),
            bindings,
            (...values) => prepare(sql).get(...values) as Row | undefined,
            (values) => prepare(sql).get(values) as Row | undefined,
          ),
        all: <Row extends StateRow>(
          sql: string,
          bindings?: StateBindings,
        ): ReadonlyArray<Row> =>
          applyBindings(
            prepare(sql),
            bindings,
            (...values) => prepare(sql).all(...values) as Row[],
            (values) => prepare(sql).all(values) as Row[],
          ),
      };

      const writer: StateWriter = {
        ...reader,
        run: (
          sql: string,
          bindings?: StateBindings,
        ) =>
          applyBindings(
            prepare(sql),
            bindings,
            (...values) => prepare(sql).run(...values),
            (values) => prepare(sql).run(values),
          ),
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
        }).pipe(Effect.withSpan(`state.${operation}`));

      const transaction = <A>(
        operation: string,
        body: (stateWriter: StateWriter) => A,
      ): Effect.Effect<A, StateEngineError> =>
        Effect.try({
          try: () => {
            requireOpen();
            if (transactionOpen) {
              throw new Error(
                `nested state transaction is not allowed (${operation})`,
              );
            }
            transactionOpen = true;
            database.exec("BEGIN IMMEDIATE");
            try {
              const result = body(writer);
              database.exec("COMMIT");
              return result;
            } catch (error) {
              try {
                database.exec("ROLLBACK");
              } catch {
                // Preserve the original failure. A failed rollback leaves the
                // engine unusable and the next operation will fail loudly.
              }
              throw error;
            } finally {
              transactionOpen = false;
            }
          },
          catch: (error) => stateEngineError(operation, error),
        }).pipe(Effect.withSpan(`state.${operation}`));

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
        }).pipe(Effect.withSpan("state.backup"));

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
): Layer.Layer<StateEngine, StateEngineError> =>
  Layer.effect(
    StateEngine,
    Effect.acquireRelease(
      openStateEngine(path),
      ({ close }) => Effect.sync(close),
    ).pipe(Effect.map(({ service }) => service)),
  );

export const StateEngineLive = makeStateEngineLive();
