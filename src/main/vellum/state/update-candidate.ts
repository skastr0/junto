import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";
import { createVerifiedStateBackup } from "./backup";
import { stateDatabasePath } from "./engine";
import type { StateBackupReceipt } from "./service";

const STATE_DIRECTORY_MODE = 0o700;
const STATE_FILE_MODE = 0o600;
const STATE_UPDATE_DIRECTORY = "update-candidates";
const STATE_UPDATE_DATABASE = "vellum.db";

const UpdateId = Schema.UUID.pipe(Schema.brand("StateUpdateId"));
export type StateUpdateId = typeof UpdateId.Type;

export class StateUpdateCandidateError extends Schema.TaggedError<StateUpdateCandidateError>()(
  "StateUpdateCandidateError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}

export type PreparedStateUpdateCandidate = {
  readonly id: StateUpdateId;
  readonly databasePath: string;
  readonly directoryPath: string;
  readonly source:
    | {
        readonly _tag: "fresh";
      }
    | {
        readonly _tag: "installed";
        readonly backup: StateBackupReceipt;
      };
};

const candidateError = (
  operation: string,
  cause: unknown,
): StateUpdateCandidateError =>
  StateUpdateCandidateError.make({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const assertRealDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: STATE_DIRECTORY_MODE });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`state update path is not a real directory: ${path}`);
  }
  chmodSync(path, STATE_DIRECTORY_MODE);
};

const assertRegularOrMissing = (path: string): boolean => {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(
        `state update source is not a regular file: ${path}`,
      );
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

const makeOwnerOnlyWithoutFollowing = (path: string): void => {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) {
      throw new Error(
        `state update candidate is not a regular file: ${path}`,
      );
    }
    fchmodSync(descriptor, STATE_FILE_MODE);
    const linked = lstatSync(path);
    if (
      !linked.isFile() ||
      linked.isSymbolicLink() ||
      linked.dev !== opened.dev ||
      linked.ino !== opened.ino
    ) {
      throw new Error(
        `state update candidate path changed during creation: ${path}`,
      );
    }
  } finally {
    closeSync(descriptor);
  }
};

const createEmptyCandidate = (path: string): void => {
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
    STATE_FILE_MODE,
  );
  closeSync(descriptor);
  makeOwnerOnlyWithoutFollowing(path);
};

/**
 * Prepare one disposable candidate database from the fixed installed store.
 *
 * This capability is for a quiesced update transaction only. The incumbent
 * Electron process must have released SQLite before the signed candidate
 * proof process calls it. The source connection is read-only; all migration
 * and readiness writes happen against the disposable clone.
 *
 * Tests may inject another database path. Product update code calls the
 * zero-argument form and therefore cannot redirect authority.
 */
export const prepareStateUpdateCandidate = (
  configuredPath: string = stateDatabasePath(),
): Effect.Effect<
  PreparedStateUpdateCandidate,
  StateUpdateCandidateError
> =>
  Effect.try({
    try: () => {
      const path = resolve(configuredPath);
      const stateDirectory = dirname(path);
      assertRealDirectory(stateDirectory);
      const candidatesRoot = join(
        stateDirectory,
        STATE_UPDATE_DIRECTORY,
      );
      assertRealDirectory(candidatesRoot);

      const id = Schema.decodeUnknownSync(UpdateId)(randomUUID());
      const directoryPath = join(candidatesRoot, id);
      mkdirSync(directoryPath, {
        recursive: false,
        mode: STATE_DIRECTORY_MODE,
      });
      const databasePath = join(directoryPath, STATE_UPDATE_DATABASE);

      try {
        if (!assertRegularOrMissing(path)) {
          createEmptyCandidate(databasePath);
          return {
            id,
            databasePath,
            directoryPath,
            source: { _tag: "fresh" as const },
          } satisfies PreparedStateUpdateCandidate;
        }

        const source = new DatabaseSync(path, {
          open: true,
          readOnly: true,
          allowExtension: false,
          enableForeignKeyConstraints: true,
          enableDoubleQuotedStringLiterals: false,
          allowBareNamedParameters: false,
          allowUnknownNamedParameters: false,
          timeout: 5_000,
        });
        let backup: StateBackupReceipt;
        try {
          source.exec(`
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;
            PRAGMA trusted_schema = OFF;
          `);
          backup = createVerifiedStateBackup(source, stateDirectory);
        } finally {
          source.close();
        }

        copyFileSync(
          backup.path,
          databasePath,
          constants.COPYFILE_EXCL,
        );
        makeOwnerOnlyWithoutFollowing(databasePath);
        return {
          id,
          databasePath,
          directoryPath,
          source: { _tag: "installed" as const, backup },
        } satisfies PreparedStateUpdateCandidate;
      } catch (error) {
        rmSync(directoryPath, { recursive: true, force: true });
        throw error;
      }
    },
    catch: (error) => candidateError("prepare", error),
  }).pipe(Effect.withSpan("state.update.prepare-candidate"));

/**
 * Release only the exact UUID directory minted above. Retained verified
 * backups are deliberately outside this disposable tree and survive.
 */
export const releaseStateUpdateCandidate = (
  candidate: PreparedStateUpdateCandidate,
): Effect.Effect<void, StateUpdateCandidateError> =>
  Effect.try({
    try: () => {
      const expected = join(
        dirname(dirname(candidate.directoryPath)),
        STATE_UPDATE_DIRECTORY,
        candidate.id,
      );
      if (resolve(candidate.directoryPath) !== resolve(expected)) {
        throw new Error("state update candidate authority is malformed");
      }
      rmSync(candidate.directoryPath, {
        recursive: true,
        force: true,
      });
    },
    catch: (error) => candidateError("release", error),
  }).pipe(Effect.withSpan("state.update.release-candidate"));

export const withStateUpdateCandidate = <A, E, R>(
  use: (
    candidate: PreparedStateUpdateCandidate,
  ) => Effect.Effect<A, E, R>,
  configuredPath?: string,
): Effect.Effect<A, E | StateUpdateCandidateError, R> =>
  Effect.acquireUseRelease(
    prepareStateUpdateCandidate(configuredPath),
    use,
    (candidate) =>
      releaseStateUpdateCandidate(candidate).pipe(Effect.orDie),
  );
