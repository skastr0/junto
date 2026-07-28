import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import type { StateBackupReceipt } from "./service";

const STATE_DIRECTORY_MODE = 0o700;
const STATE_FILE_MODE = 0o600;
const STATE_BACKUP_DIRECTORY = "backups";
const STATE_BACKUP_FILE_PREFIX = "vellum-backup-";

type BackupSchemaIdentity = {
  readonly actualSchemaSha256: string;
  readonly sourceSchemaSha256: string;
};

type BackupFileIdentity = {
  readonly device: number | bigint;
  readonly inode: number | bigint;
};

type BackupWitness = {
  readonly userVersion: number;
  readonly identity: BackupSchemaIdentity;
  readonly schema: ReadonlyArray<{
    readonly type: string;
    readonly name: string;
    readonly tableName: string;
    readonly sql: string | null;
  }>;
  readonly rowCounts: ReadonlyArray<{
    readonly tableName: string;
    readonly count: number;
  }>;
};

const assertRegularOrMissing = (path: string): boolean => {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`state backup is not a regular file: ${path}`);
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

const makeOwnerOnlyWithoutFollowing = (
  path: string,
): BackupFileIdentity => {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) {
      throw new Error(`state backup is not a regular file: ${path}`);
    }
    fchmodSync(descriptor, STATE_FILE_MODE);
    const linked = lstatSync(path);
    if (
      !linked.isFile() ||
      linked.isSymbolicLink() ||
      linked.dev !== opened.dev ||
      linked.ino !== opened.ino
    ) {
      throw new Error(`state backup path changed during creation: ${path}`);
    }
    return {
      device: opened.dev,
      inode: opened.ino,
    };
  } finally {
    closeSync(descriptor);
  }
};

const unlinkExactBackup = (
  path: string,
  identity: BackupFileIdentity,
): void => {
  try {
    const linked = lstatSync(path);
    if (
      linked.isFile() &&
      !linked.isSymbolicLink() &&
      linked.dev === identity.device &&
      linked.ino === identity.inode
    ) {
      unlinkSync(path);
    }
  } catch {
    // Preserve the verification failure. Never remove a replacement.
  }
};

const assertPrivateBackupDirectory = (stateDirectory: string): string => {
  const path = join(stateDirectory, STATE_BACKUP_DIRECTORY);
  try {
    mkdirSync(path, { mode: STATE_DIRECTORY_MODE });
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
  }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`state backup path is not a real directory: ${path}`);
  }
  chmodSync(path, STATE_DIRECTORY_MODE);
  return path;
};

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const readBackupWitness = (database: DatabaseSync): BackupWitness => {
  const version = database.prepare("PRAGMA user_version").get() as
    | { readonly user_version: SQLOutputValue }
    | undefined;
  const identity = database.prepare(
    `
      SELECT actual_schema_sha256, source_schema_sha256
      FROM state_schema_identity
      WHERE singleton = 1
    `,
  ).get() as
    | {
        readonly actual_schema_sha256: SQLOutputValue;
        readonly source_schema_sha256: SQLOutputValue;
      }
    | undefined;
  if (identity === undefined) {
    throw new Error("state backup source has no schema identity witness");
  }
  const schema = database.prepare(
    `
      SELECT type, name, tbl_name AS table_name, sql
      FROM sqlite_schema
      WHERE type IN ('table', 'index', 'view', 'trigger')
        AND name NOT GLOB 'sqlite_*'
      ORDER BY type COLLATE BINARY, name COLLATE BINARY
    `,
  ).all() as unknown as ReadonlyArray<{
    readonly type: SQLOutputValue;
    readonly name: SQLOutputValue;
    readonly table_name: SQLOutputValue;
    readonly sql: SQLOutputValue;
  }>;
  const tables = schema.filter((entry) => entry.type === "table");
  return {
    userVersion: Number(version?.user_version),
    identity: {
      actualSchemaSha256: String(identity.actual_schema_sha256),
      sourceSchemaSha256: String(identity.source_schema_sha256),
    },
    schema: schema.map((entry) => ({
      type: String(entry.type),
      name: String(entry.name),
      tableName: String(entry.table_name),
      sql: entry.sql === null ? null : String(entry.sql),
    })),
    rowCounts: tables.map((table) => {
      const tableName = String(table.name);
      const row = database
        .prepare(`SELECT count(*) AS count FROM ${quoteIdentifier(tableName)}`)
        .get() as { readonly count: SQLOutputValue } | undefined;
      return { tableName, count: Number(row?.count) };
    }),
  };
};

const assertBackupWitness = (
  source: BackupWitness,
  backup: BackupWitness,
): void => {
  if (JSON.stringify(source) !== JSON.stringify(backup)) {
    throw new Error("state backup witness does not match its live source");
  }
};

/**
 * Mint a retained, owner-only SQLite snapshot and prove that a separate
 * read-only connection sees the same durable schema witness and row totals.
 * This runs before a live schema-advance transaction; it never mutates the
 * source database.
 */
export const createVerifiedStateBackup = (
  database: DatabaseSync,
  stateDirectory: string,
): StateBackupReceipt => {
  const source = readBackupWitness(database);
  const backupDirectory = assertPrivateBackupDirectory(stateDirectory);
  const path = join(
    backupDirectory,
    `${STATE_BACKUP_FILE_PREFIX}${randomUUID()}.db`,
  );
  if (assertRegularOrMissing(path)) {
    throw new Error(`backup destination already exists: ${path}`);
  }
  database.prepare("VACUUM INTO ?").run(path);
  const created = lstatSync(path);
  if (!created.isFile() || created.isSymbolicLink()) {
    throw new Error(`state backup is not a regular file: ${path}`);
  }
  const identity = {
    device: created.dev,
    inode: created.ino,
  };
  let backup: DatabaseSync | undefined;
  let verified = false;
  try {
    const secured = makeOwnerOnlyWithoutFollowing(path);
    if (
      secured.device !== identity.device ||
      secured.inode !== identity.inode
    ) {
      throw new Error(`state backup path changed during creation: ${path}`);
    }
    backup = new DatabaseSync(path, {
      open: true,
      readOnly: true,
      allowExtension: false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowBareNamedParameters: false,
      allowUnknownNamedParameters: false,
    });
    const quickCheck = backup.prepare("PRAGMA quick_check").all() as unknown as
      ReadonlyArray<{ readonly quick_check: SQLOutputValue }>;
    if (
      quickCheck.length !== 1 ||
      String(quickCheck[0]?.quick_check) !== "ok"
    ) {
      throw new Error("state backup quick_check failed");
    }
    const foreignKeyViolations = backup.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyViolations.length > 0) {
      throw new Error(
        `state backup has ${foreignKeyViolations.length} foreign-key violation(s)`,
      );
    }
    assertBackupWitness(source, readBackupWitness(backup));
    verified = true;
  } finally {
    backup?.close();
    if (!verified) unlinkExactBackup(path, identity);
  }
  return {
    path,
    schemaSha256: source.identity.actualSchemaSha256,
    schemaVersion: source.userVersion,
  };
};
