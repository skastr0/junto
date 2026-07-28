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
  readdirSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";
import {
  createVerifiedStateBackup,
  reconcilePendingStateBackups,
} from "./backup";
import { stateDatabasePath } from "./engine";
import type { StateBackupReceipt } from "./service";

const STATE_DIRECTORY_MODE = 0o700;
const STATE_FILE_MODE = 0o600;
const STATE_UPDATE_DIRECTORY = "update-candidates";
const STATE_UPDATE_DATABASE = "vellum.db";
const STATE_UPDATE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STATE_UPDATE_FILES = new Set([
  STATE_UPDATE_DATABASE,
  `${STATE_UPDATE_DATABASE}-journal`,
  `${STATE_UPDATE_DATABASE}-shm`,
  `${STATE_UPDATE_DATABASE}-wal`,
]);
const STATE_UPDATE_BACKUP_DIRECTORY = "backups";
const STATE_UPDATE_BACKUP_FILE =
  /^vellum-backup-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.db(?:\.pending)?$/u;

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

/**
 * Runtime authority for exact candidate disposal.
 *
 * `PreparedStateUpdateCandidate` remains readable by repository preflight
 * code, but a structurally similar object can never authorize filesystem
 * removal. Only this module can mint membership in the WeakSet.
 */
const releasableCandidates = new WeakMap<
  object,
  CandidateDirectoryIdentity
>();

type CandidateDirectoryIdentity = {
  readonly device: number | bigint;
  readonly inode: number | bigint;
};

type CandidateFileAuthority = CandidateDirectoryIdentity & {
  readonly path: string;
};

const admitCandidateCleanup = (
  candidate: PreparedStateUpdateCandidate,
): void => {
  const root = lstatSync(candidate.directoryPath);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error(
      "state update candidate cleanup root is not a real directory",
    );
  }
  releasableCandidates.set(candidate, {
    device: root.dev,
    inode: root.ino,
  });
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

const removeDisposableCandidateDirectory = (
  path: string,
  identity: CandidateDirectoryIdentity,
): void => {
  const root = lstatSync(path);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.dev !== identity.device ||
    root.ino !== identity.inode
  ) {
    throw new Error(
      "state update candidate cleanup root changed identity",
    );
  }

  const entries = readdirSync(path);
  const files: CandidateFileAuthority[] = [];
  let backupDirectory:
    | (CandidateDirectoryIdentity & { readonly path: string })
    | undefined;
  for (const entry of entries) {
    if (entry === STATE_UPDATE_BACKUP_DIRECTORY) {
      const backupPath = join(path, entry);
      const directory = lstatSync(backupPath);
      if (!directory.isDirectory() || directory.isSymbolicLink()) {
        throw new Error(
          "state update candidate backup path is not a real directory",
        );
      }
      backupDirectory = {
        path: backupPath,
        device: directory.dev,
        inode: directory.ino,
      };
      for (const backupEntry of readdirSync(backupPath)) {
        if (!STATE_UPDATE_BACKUP_FILE.test(backupEntry)) {
          throw new Error(
            `state update candidate backup contains an unexpected entry: ${backupEntry}`,
          );
        }
        const candidateBackupPath = join(backupPath, backupEntry);
        const backup = lstatSync(candidateBackupPath);
        if (!backup.isFile() || backup.isSymbolicLink()) {
          throw new Error(
            `state update candidate backup is not a regular file: ${backupEntry}`,
          );
        }
        files.push({
          path: candidateBackupPath,
          device: backup.dev,
          inode: backup.ino,
        });
      }
      continue;
    }
    if (!STATE_UPDATE_FILES.has(entry)) {
      throw new Error(
        `state update candidate contains an unexpected entry: ${entry}`,
      );
    }
    const candidateFile = join(path, entry);
    const linked = lstatSync(candidateFile);
    if (!linked.isFile() || linked.isSymbolicLink()) {
      throw new Error(
        `state update candidate entry is not a regular file: ${entry}`,
      );
    }
    files.push({
      path: candidateFile,
      device: linked.dev,
      inode: linked.ino,
    });
  }
  for (const file of files) {
    const linked = lstatSync(file.path);
    if (
      !linked.isFile() ||
      linked.isSymbolicLink() ||
      linked.dev !== file.device ||
      linked.ino !== file.inode
    ) {
      throw new Error(
        "state update candidate entry changed identity",
      );
    }
    unlinkSync(file.path);
  }
  if (backupDirectory !== undefined) {
    const directory = lstatSync(backupDirectory.path);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.dev !== backupDirectory.device ||
      directory.ino !== backupDirectory.inode
    ) {
      throw new Error(
        "state update candidate backup path changed identity",
      );
    }
    rmdirSync(backupDirectory.path);
  }
  const current = lstatSync(path);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== identity.device ||
    current.ino !== identity.inode
  ) {
    throw new Error(
      "state update candidate cleanup root changed identity",
    );
  }
  rmdirSync(path);
};

const reconcileOrphanedStateUpdateCandidates = (
  candidatesRoot: string,
): void => {
  for (const entry of readdirSync(candidatesRoot)) {
    if (!STATE_UPDATE_ID.test(entry)) continue;
    const directoryPath = join(candidatesRoot, entry);
    const root = lstatSync(directoryPath);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error(
        "state update candidate cleanup root is not a real directory",
      );
    }
    removeDisposableCandidateDirectory(directoryPath, {
      device: root.dev,
      inode: root.ino,
    });
  }
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
 * Product code cannot supply or redirect the source path. Unit tests replace
 * the canonical path resolver at the module boundary rather than widening
 * this filesystem capability.
 */
export const prepareStateUpdateCandidate = (): Effect.Effect<
  PreparedStateUpdateCandidate,
  StateUpdateCandidateError
> =>
  Effect.try({
    try: () => {
      const path = resolve(stateDatabasePath());
      const stateDirectory = dirname(path);
      assertRealDirectory(stateDirectory);
      const candidatesRoot = join(
        stateDirectory,
        STATE_UPDATE_DIRECTORY,
      );
      assertRealDirectory(candidatesRoot);
      reconcilePendingStateBackups(stateDirectory);
      reconcileOrphanedStateUpdateCandidates(candidatesRoot);

      const id = Schema.decodeUnknownSync(UpdateId)(randomUUID());
      const directoryPath = join(candidatesRoot, id);
      mkdirSync(directoryPath, {
        recursive: false,
        mode: STATE_DIRECTORY_MODE,
      });
      const directory = lstatSync(directoryPath);
      const directoryIdentity = {
        device: directory.dev,
        inode: directory.ino,
      };
      const databasePath = join(directoryPath, STATE_UPDATE_DATABASE);

      try {
        if (!assertRegularOrMissing(path)) {
          createEmptyCandidate(databasePath);
          const candidate = {
            id,
            databasePath,
            directoryPath,
            source: { _tag: "fresh" as const },
          } satisfies PreparedStateUpdateCandidate;
          admitCandidateCleanup(candidate);
          return candidate;
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
        const candidate = {
          id,
          databasePath,
          directoryPath,
          source: { _tag: "installed" as const, backup },
        } satisfies PreparedStateUpdateCandidate;
        admitCandidateCleanup(candidate);
        return candidate;
      } catch (error) {
        removeDisposableCandidateDirectory(
          directoryPath,
          directoryIdentity,
        );
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
      const authority = releasableCandidates.get(candidate);
      if (authority === undefined) {
        throw new Error(
          "state update candidate cleanup requires minted authority",
        );
      }
      const expected = join(
        dirname(dirname(candidate.directoryPath)),
        STATE_UPDATE_DIRECTORY,
        candidate.id,
      );
      if (resolve(candidate.directoryPath) !== resolve(expected)) {
        throw new Error("state update candidate authority is malformed");
      }
      const root = lstatSync(candidate.directoryPath);
      if (
        !root.isDirectory() ||
        root.isSymbolicLink() ||
        root.dev !== authority.device ||
        root.ino !== authority.inode
      ) {
        throw new Error(
          "state update candidate cleanup root changed identity",
        );
      }
      removeDisposableCandidateDirectory(
        candidate.directoryPath,
        authority,
      );
      releasableCandidates.delete(candidate);
    },
    catch: (error) => candidateError("release", error),
  }).pipe(Effect.withSpan("state.update.release-candidate"));

export const withStateUpdateCandidate = <A, E, R>(
  use: (
    candidate: PreparedStateUpdateCandidate,
  ) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | StateUpdateCandidateError, R> =>
  Effect.acquireUseRelease(
    prepareStateUpdateCandidate(),
    use,
    (candidate) =>
      releaseStateUpdateCandidate(candidate).pipe(Effect.orDie),
  );
