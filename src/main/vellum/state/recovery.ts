import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { Effect, Schema } from "effect";
import {
  decodeStateBackupExportReceipt,
  decodeStateBackupId,
  decodeStateBackupInventoryEntry,
  StateBackupId,
  type StateBackupExportReceipt,
  type StateBackupInventoryEntry,
} from "@shared/state-recovery";
import { stateDatabasePath } from "./engine";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  type StateSchemaMigrationPlan,
} from "./migrations";
import {
  expectedStateSchemaIdentity,
  verifyRecordedStateSchemaIdentity,
  type VerifiedStateSchemaIdentity,
} from "./schema-identity";

export {
  StateBackupId,
  StateBackupInventoryEntry,
  StateBackupExportReceipt,
} from "@shared/state-recovery";

const STATE_BACKUP_DIRECTORY = "backups";
const STATE_BACKUP_FILE_PATTERN =
  /^vellum-command-backup-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.db$/;
const STATE_FILE_MODE = 0o600;
const COPY_BUFFER_BYTES = 1024 * 1024;

export class StateRecoveryError extends Schema.TaggedErrorClass<StateRecoveryError>()(
  "StateRecoveryError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

type OpenedBackup = {
  readonly descriptor: number;
  readonly metadata: {
    readonly size: number;
    readonly mtimeMs: number;
  };
};

type FileIdentity = {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
};

const recoveryError = (
  operation: string,
  cause: unknown,
): StateRecoveryError =>
  StateRecoveryError.make({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const backupDirectoryFor = (databasePath: string): string =>
  join(dirname(resolve(databasePath)), STATE_BACKUP_DIRECTORY);

const currentUserId = (): number | undefined =>
  typeof process.getuid === "function" ? process.getuid() : undefined;

const assertCurrentUserOwns = (
  uid: number,
  subject: string,
): void => {
  const expected = currentUserId();
  if (expected !== undefined && uid !== expected) {
    throw new Error(`${subject} is not owned by the current user`);
  }
};

const idFromFile = (file: string): StateBackupId => {
  const match = STATE_BACKUP_FILE_PATTERN.exec(file);
  if (match === null) {
    throw new Error(`unexpected state backup entry: ${file}`);
  }
  return decodeStateBackupId(match[1]);
};

const openOwnedBackup = (path: string): OpenedBackup => {
  const linked = lstatSync(path);
  assertCurrentUserOwns(linked.uid, "state backup");
  if (
    !linked.isFile() ||
    linked.isSymbolicLink() ||
    (linked.mode & 0o777) !== STATE_FILE_MODE
  ) {
    throw new Error(
      `state backup is not an owner-only regular file: ${path}`,
    );
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(descriptor);
    assertCurrentUserOwns(opened.uid, "opened state backup");
    if (
      !opened.isFile() ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino
    ) {
      throw new Error(`state backup path changed during open: ${path}`);
    }
    const size = Number(opened.size);
    const mtimeMs = Number(opened.mtimeMs);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      !Number.isFinite(mtimeMs) ||
      mtimeMs < 0
    ) {
      throw new Error(`state backup metadata is not representable: ${path}`);
    }
    return { descriptor, metadata: { size, mtimeMs } };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
};

const inspectBackup = (
  path: string,
  file: string,
  migrationPlan: StateSchemaMigrationPlan = STATE_SCHEMA_MIGRATION_PLAN,
): StateBackupInventoryEntry => {
  const opened = openOwnedBackup(path);
  closeSync(opened.descriptor);
  const database = new DatabaseSync(path, {
    open: true,
    readOnly: true,
    allowExtension: false,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowBareNamedParameters: false,
    allowUnknownNamedParameters: false,
  });
  try {
    const quickCheck = database.prepare("PRAGMA quick_check").all() as unknown as
      ReadonlyArray<{ readonly quick_check: SQLOutputValue }>;
    if (
      quickCheck.length !== 1 ||
      String(quickCheck[0]?.quick_check) !== "ok"
    ) {
      throw new Error(`state backup quick_check failed: ${file}`);
    }
    if (database.prepare("PRAGMA foreign_key_check").all().length > 0) {
      throw new Error(
        `state backup foreign-key check failed: ${file}`,
      );
    }
    const version = database.prepare("PRAGMA user_version").get() as
      | { readonly user_version: SQLOutputValue }
      | undefined;
    const schemaVersion = Number(version?.user_version);
    if (
      !Number.isSafeInteger(schemaVersion) ||
      schemaVersion < 0 ||
      schemaVersion > migrationPlan.currentVersion
    ) {
      throw new Error(
        `state backup has an unsupported schema version: ${file}`,
      );
    }
    const recorded = verifyRecordedStateSchemaIdentity(database);
    const expected: VerifiedStateSchemaIdentity | undefined =
      schemaVersion === 0
        ? migrationPlan.baselineIdentity
        : schemaVersion === migrationPlan.currentVersion
          ? expectedStateSchemaIdentity(migrationPlan.currentSchemaSql)
          : migrationPlan.migrations.find(
            (migration) => migration.fromVersion === schemaVersion,
          )?.fromIdentity;
    if (
      expected === undefined ||
      recorded.actualSchemaSha256 !== expected.actualSchemaSha256
    ) {
      throw new Error(
        `state backup schema is not a recognized Vellum Command version: ${file}`,
      );
    }
    return decodeStateBackupInventoryEntry({
      id: idFromFile(file),
      file,
      bytes: Number(opened.metadata.size),
      modifiedAtEpochMs: Math.floor(opened.metadata.mtimeMs),
      schemaVersion,
      schemaSha256: recorded.actualSchemaSha256,
    });
  } finally {
    database.close();
  }
};

/**
 * Enumerate only verified coherent backups under the fixed StateEngine-owned
 * directory. An unexpected or unsafe entry fails the inventory instead of
 * being silently ignored.
 */
export const listStateBackups = (
  configuredPath: string = stateDatabasePath(),
): Effect.Effect<
  ReadonlyArray<StateBackupInventoryEntry>,
  StateRecoveryError
> =>
  Effect.try({
    try: () => {
      const directory = backupDirectoryFor(configuredPath);
      let directoryInfo: ReturnType<typeof lstatSync>;
      try {
        directoryInfo = lstatSync(directory);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return [];
        }
        throw error;
      }
      if (
        !directoryInfo.isDirectory() ||
        directoryInfo.isSymbolicLink() ||
        (directoryInfo.mode & 0o777) !== 0o700
      ) {
        throw new Error(
          "state backup directory is not an owner-only real directory",
        );
      }
      assertCurrentUserOwns(
        directoryInfo.uid,
        "state backup directory",
      );
      return readdirSync(directory)
        .sort()
        .map((file) => inspectBackup(join(directory, file), file));
    },
    catch: (error) => recoveryError("list-backups", error),
  }).pipe(Effect.withSpan("state.recovery.list-backups"));

const copyBackupToNewDestination = (
  source: string,
  destination: string,
): { readonly sha256: string; readonly identity: FileIdentity } => {
  const sourceFile = openOwnedBackup(source);
  let destinationDescriptor: number | undefined;
  let destinationIdentity: FileIdentity | undefined;
  let complete = false;
  try {
    destinationDescriptor = openSync(
      destination,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      STATE_FILE_MODE,
    );
    const created = fstatSync(destinationDescriptor);
    if (!created.isFile()) {
      throw new Error("state export destination is not a regular file");
    }
    assertCurrentUserOwns(created.uid, "state export destination");
    destinationIdentity = { dev: created.dev, ino: created.ino };
    fchmodSync(destinationDescriptor, STATE_FILE_MODE);

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let position = 0;
    while (position < sourceFile.metadata.size) {
      const read = readSync(
        sourceFile.descriptor,
        buffer,
        0,
        Math.min(
          buffer.byteLength,
          sourceFile.metadata.size - position,
        ),
        position,
      );
      if (read <= 0) {
        throw new Error("state backup ended during export");
      }
      hash.update(buffer.subarray(0, read));
      let written = 0;
      while (written < read) {
        written += writeSync(
          destinationDescriptor,
          buffer,
          written,
          read - written,
        );
      }
      position += read;
    }
    if (fstatSync(destinationDescriptor).size !== sourceFile.metadata.size) {
      throw new Error("state export size does not match its backup");
    }
    fsyncSync(destinationDescriptor);
    complete = true;
    return {
      sha256: hash.digest("hex"),
      identity: destinationIdentity,
    };
  } finally {
    closeSync(sourceFile.descriptor);
    if (destinationDescriptor !== undefined) {
      closeSync(destinationDescriptor);
    }
    if (!complete && destinationIdentity !== undefined) {
      unlinkExactFile(destination, destinationIdentity);
    }
  }
};

const unlinkExactFile = (
  path: string,
  expected: FileIdentity,
): void => {
  try {
    const linked = lstatSync(path);
    if (
      linked.isFile() &&
      !linked.isSymbolicLink() &&
      linked.dev === expected.dev &&
      linked.ino === expected.ino
    ) {
      unlinkSync(path);
    }
  } catch {
    // Preserve the original failure. A foreign replacement is never removed.
  }
};

/**
 * Export one verified backup to an explicit new operator destination.
 *
 * This is portability/evidence, not restore. It never replaces vellum-command.db,
 * never accepts a database source path, and refuses to overwrite output.
 */
export const exportStateBackup = (
  id: StateBackupId,
  destinationInput: string,
  configuredPath: string = stateDatabasePath(),
): Effect.Effect<StateBackupExportReceipt, StateRecoveryError> =>
  Effect.try({
    try: () => {
      if (
        !isAbsolute(destinationInput) ||
        destinationInput.includes("\0")
      ) {
        throw new Error(
          "state backup export destination must be an absolute path",
        );
      }
      const destination = resolve(destinationInput);
      const parent = lstatSync(dirname(destination));
      if (!parent.isDirectory() || parent.isSymbolicLink()) {
        throw new Error(
          "state backup export parent is not a real directory",
        );
      }
      assertCurrentUserOwns(
        parent.uid,
        "state backup export parent",
      );
      const entries = Effect.runSync(
        listStateBackups(configuredPath),
      );
      const backup = entries.find((entry) => entry.id === id);
      if (backup === undefined) {
        throw new Error(`unknown state backup: ${id}`);
      }
      const source = join(
        backupDirectoryFor(configuredPath),
        basename(backup.file),
      );
      const copied = copyBackupToNewDestination(source, destination);
      try {
        const exported = inspectBackup(destination, backup.file);
        if (
          exported.bytes !== backup.bytes ||
          exported.schemaVersion !== backup.schemaVersion ||
          exported.schemaSha256 !== backup.schemaSha256
        ) {
          throw new Error(
            "exported state backup does not match its source witness",
          );
        }
        return decodeStateBackupExportReceipt({
          backup,
          destination,
          sha256: copied.sha256,
        });
      } catch (error) {
        unlinkExactFile(destination, copied.identity);
        throw error;
      }
    },
    catch: (error) => recoveryError("export-backup", error),
  }).pipe(Effect.withSpan("state.recovery.export-backup"));
