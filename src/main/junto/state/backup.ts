import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import type { StateBackupReceipt } from "./service";
import { stripProviderSecretsFromPreferencesBody } from "../credentials/redact";

const STATE_DIRECTORY_MODE = 0o700;
const STATE_FILE_MODE = 0o600;
const STATE_BACKUP_DIRECTORY = "backups";
const STATE_BACKUP_FILE_PREFIX = "junto-backup-";
const STATE_BACKUP_PENDING_SUFFIX = ".pending";
const STATE_BACKUP_PENDING_FILE =
  /^junto-backup-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.db\.pending(?:-journal|-wal|-shm)?$/u;

type BackupSchemaIdentity = {
  readonly actualSchemaSha256: string;
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

const unlinkKnownBackup = (
  path: string,
  identity: BackupFileIdentity,
): void => {
  const linked = lstatSync(path);
  if (
    !linked.isFile() ||
    linked.isSymbolicLink() ||
    linked.dev !== identity.device ||
    linked.ino !== identity.inode
  ) {
    throw new Error(`state backup path changed before removal: ${path}`);
  }
  unlinkSync(path);
};

const fsyncKnownBackup = (
  path: string,
  identity: BackupFileIdentity,
): void => {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(descriptor);
    const linked = lstatSync(path);
    if (
      !opened.isFile() ||
      !linked.isFile() ||
      linked.isSymbolicLink() ||
      opened.dev !== identity.device ||
      opened.ino !== identity.inode ||
      linked.dev !== identity.device ||
      linked.ino !== identity.inode
    ) {
      throw new Error(`state backup path changed before sync: ${path}`);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const fsyncDirectory = (path: string): void => {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  );
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isDirectory()) {
      throw new Error(`state backup path is not a real directory: ${path}`);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const assertPrivateBackupDirectory = (stateDirectory: string): string => {
  const path = join(stateDirectory, STATE_BACKUP_DIRECTORY);
  let created = false;
  try {
    mkdirSync(path, { mode: STATE_DIRECTORY_MODE });
    created = true;
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
  if (created) fsyncDirectory(stateDirectory);
  return path;
};

/**
 * Remove only incomplete backup artifacts minted by this module. Final
 * `junto-backup-<uuid>.db` files are immutable retained evidence and are
 * never considered cleanup candidates.
 */
export const reconcilePendingStateBackups = (
  stateDirectory: string,
): void => {
  const backupDirectory = join(stateDirectory, STATE_BACKUP_DIRECTORY);
  let entries: ReadonlyArray<string>;
  try {
    const directory = lstatSync(backupDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error(
        `state backup path is not a real directory: ${backupDirectory}`,
      );
    }
    entries = readdirSync(backupDirectory);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }

  let removed = false;
  for (const entry of entries) {
    if (!STATE_BACKUP_PENDING_FILE.test(entry)) continue;
    const path = join(backupDirectory, entry);
    const linked = lstatSync(path);
    if (!linked.isFile() || linked.isSymbolicLink()) {
      throw new Error(
        `pending state backup is not a regular file: ${path}`,
      );
    }
    unlinkKnownBackup(path, {
      device: linked.dev,
      inode: linked.ino,
    });
    removed = true;
  }
  if (removed) fsyncDirectory(backupDirectory);
};

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const readBackupWitness = (database: DatabaseSync): BackupWitness => {
  const version = database.prepare("PRAGMA user_version").get() as
    | { readonly user_version: SQLOutputValue }
    | undefined;
  const identity = database.prepare(
    `
      SELECT actual_schema_sha256
      FROM state_schema_identity
      WHERE singleton = 1
    `,
  ).get() as
    | {
        readonly actual_schema_sha256: SQLOutputValue;
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
 * Strip provider secrets from a VACUUM INTO copy, then compact the file so
 * the published backup does not retain the plaintext pages. Pending files
 * are never retained evidence and are deleted on the next open.
 */
const redactProviderSecretsInBackup = (path: string): void => {
  const database = new DatabaseSync(path, {
    open: true,
    readOnly: false,
    allowExtension: false,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowBareNamedParameters: false,
    allowUnknownNamedParameters: false,
  });
  try {
    const table = database.prepare(
      `SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'settings_preferences'`,
    ).get();
    if (table === undefined) return;
    const row = database.prepare(
      `SELECT body FROM settings_preferences WHERE singleton = 1`,
    ).get() as { readonly body: SQLOutputValue } | undefined;
    if (row === undefined) return;
    const body = String(row.body);
    const redacted = stripProviderSecretsFromPreferencesBody(body);
    if (redacted === body) return;
    database.prepare(
      `UPDATE settings_preferences SET body = ? WHERE singleton = 1`,
    ).run(redacted);
    database.exec("VACUUM");
  } finally {
    database.close();
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
  reconcilePendingStateBackups(stateDirectory);
  const backupDirectory = assertPrivateBackupDirectory(stateDirectory);
  const backupId = randomUUID();
  const path = join(
    backupDirectory,
    `${STATE_BACKUP_FILE_PREFIX}${backupId}.db`,
  );
  const pendingPath = `${path}${STATE_BACKUP_PENDING_SUFFIX}`;
  if (assertRegularOrMissing(path)) {
    throw new Error(`backup destination already exists: ${path}`);
  }
  if (assertRegularOrMissing(pendingPath)) {
    throw new Error(`backup destination already exists: ${pendingPath}`);
  }
  try {
    database.prepare("VACUUM INTO ?").run(pendingPath);
  } catch (error) {
    if (assertRegularOrMissing(pendingPath)) {
      const partial = lstatSync(pendingPath);
      unlinkKnownBackup(pendingPath, {
        device: partial.dev,
        inode: partial.ino,
      });
      fsyncDirectory(backupDirectory);
    }
    throw error;
  }
  const created = lstatSync(pendingPath);
  if (!created.isFile() || created.isSymbolicLink()) {
    throw new Error(`state backup is not a regular file: ${pendingPath}`);
  }
  let identity = {
    device: created.dev,
    inode: created.ino,
  };
  let backup: DatabaseSync | undefined;
  let published = false;
  try {
    redactProviderSecretsInBackup(pendingPath);
    const compacted = lstatSync(pendingPath);
    if (!compacted.isFile() || compacted.isSymbolicLink()) {
      throw new Error(`state backup is not a regular file: ${pendingPath}`);
    }
    identity = {
      device: compacted.dev,
      inode: compacted.ino,
    };
    const secured = makeOwnerOnlyWithoutFollowing(pendingPath);
    if (
      secured.device !== identity.device ||
      secured.inode !== identity.inode
    ) {
      throw new Error(
        `state backup path changed during creation: ${pendingPath}`,
      );
    }
    backup = new DatabaseSync(pendingPath, {
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
    backup.close();
    backup = undefined;

    fsyncKnownBackup(pendingPath, identity);
    if (assertRegularOrMissing(path)) {
      throw new Error(`backup destination already exists: ${path}`);
    }
    linkSync(pendingPath, path);
    const linked = lstatSync(path);
    if (
      !linked.isFile() ||
      linked.isSymbolicLink() ||
      linked.dev !== identity.device ||
      linked.ino !== identity.inode
    ) {
      throw new Error(`state backup changed during publication: ${path}`);
    }
    unlinkKnownBackup(pendingPath, identity);
    fsyncDirectory(backupDirectory);
    published = true;
  } finally {
    backup?.close();
    if (!published) unlinkExactBackup(pendingPath, identity);
  }
  return {
    path,
    schemaSha256: source.identity.actualSchemaSha256,
    schemaVersion: source.userVersion,
  };
};
