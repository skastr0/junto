import { Schema } from "effect";

const STRICT_DECODE_OPTIONS = {
  onExcessProperty: "error",
} as const;

const BACKUP_FILE_PATTERN =
  /^vellum-backup-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.db$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const StateBackupId = Schema.UUID.pipe(
  Schema.brand("StateBackupId"),
);
export type StateBackupId = typeof StateBackupId.Type;

export const StateBackupInventoryEntry = Schema.Struct({
  id: StateBackupId,
  file: Schema.String.pipe(Schema.pattern(BACKUP_FILE_PATTERN)),
  bytes: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  modifiedAtEpochMs: Schema.Number.pipe(
    Schema.int(),
    Schema.nonNegative(),
  ),
  schemaVersion: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  schemaSha256: Schema.String.pipe(Schema.pattern(SHA256_PATTERN)),
});
export type StateBackupInventoryEntry =
  typeof StateBackupInventoryEntry.Type;

/** Main-process receipt. The destination never crosses the context bridge. */
export const StateBackupExportReceipt = Schema.Struct({
  backup: StateBackupInventoryEntry,
  destination: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(4_096),
  ),
  sha256: Schema.String.pipe(Schema.pattern(SHA256_PATTERN)),
});
export type StateBackupExportReceipt =
  typeof StateBackupExportReceipt.Type;

const RecoveryMessage = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(240),
);

export const StateRecoveryListResult = Schema.Union(
  Schema.Struct({
    outcome: Schema.Literal("listed"),
    backups: Schema.Array(StateBackupInventoryEntry),
  }),
  Schema.Struct({
    outcome: Schema.Literal("error"),
    code: Schema.Literal("inventory-failed"),
    message: RecoveryMessage,
  }),
);
export type StateRecoveryListResult =
  typeof StateRecoveryListResult.Type;

export const StateRecoveryExportResult = Schema.Union(
  Schema.Struct({
    outcome: Schema.Literal("exported"),
    backup: StateBackupInventoryEntry,
    fileName: Schema.String.pipe(
      Schema.minLength(1),
      Schema.maxLength(255),
    ),
    sha256: Schema.String.pipe(Schema.pattern(SHA256_PATTERN)),
  }),
  Schema.Struct({
    outcome: Schema.Literal("canceled"),
  }),
  Schema.Struct({
    outcome: Schema.Literal("error"),
    code: Schema.Literal(
      "invalid-backup-id",
      "dialog-failed",
      "export-failed",
    ),
    message: RecoveryMessage,
  }),
);
export type StateRecoveryExportResult =
  typeof StateRecoveryExportResult.Type;

export const decodeStateBackupId = (
  input: unknown,
): StateBackupId =>
  Schema.decodeUnknownSync(StateBackupId, STRICT_DECODE_OPTIONS)(input);

export const decodeStateBackupInventoryEntry = (
  input: unknown,
): StateBackupInventoryEntry =>
  Schema.decodeUnknownSync(
    StateBackupInventoryEntry,
    STRICT_DECODE_OPTIONS,
  )(input);

export const decodeStateBackupExportReceipt = (
  input: unknown,
): StateBackupExportReceipt =>
  Schema.decodeUnknownSync(
    StateBackupExportReceipt,
    STRICT_DECODE_OPTIONS,
  )(input);

export const decodeStateRecoveryListResult = (
  input: unknown,
): StateRecoveryListResult =>
  Schema.decodeUnknownSync(
    StateRecoveryListResult,
    STRICT_DECODE_OPTIONS,
  )(input);

export const decodeStateRecoveryExportResult = (
  input: unknown,
): StateRecoveryExportResult =>
  Schema.decodeUnknownSync(
    StateRecoveryExportResult,
    STRICT_DECODE_OPTIONS,
  )(input);
