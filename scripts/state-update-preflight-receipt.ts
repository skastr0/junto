import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { InstallationId } from "../src/shared/installation-id";

export const STATE_UPDATE_PREFLIGHT_RECEIPT_MAX_BYTES =
  16 * 1024;
export const STATE_UPDATE_PREFLIGHT_RECEIPT_PROTOCOL =
  "vellum-state-update-preflight/v1" as const;

// This package-independent boundary intentionally does not import the main
// state runtime: Bun cannot load node:sqlite, and the signed Electron
// candidate has already exited by the time the installer validates stdout.
export const StateUpdatePreflightReceiptBoundary = Schema.Struct({
  protocol: Schema.Literal(
    STATE_UPDATE_PREFLIGHT_RECEIPT_PROTOCOL,
  ),
  candidateId: Schema.UUID,
  source: Schema.Literal("fresh", "installed"),
  sourceSchemaVersion: Schema.Number.pipe(
    Schema.int(),
    Schema.nonNegative(),
  ),
  targetSchemaVersion: Schema.Number.pipe(
    Schema.int(),
    Schema.positive(),
  ),
  targetSchemaSha256: Schema.String.pipe(
    Schema.pattern(/^[0-9a-f]{64}$/),
  ),
  backupFile: Schema.optionalWith(
    Schema.String.pipe(
      Schema.pattern(/^vellum-backup-[0-9a-f-]{36}\.db$/),
    ),
    { exact: true },
  ),
  installationId: InstallationId,
  role: Schema.Literal(
    "unenrolled",
    "command-center",
    "remote",
  ),
  canvasCount: Schema.Number.pipe(
    Schema.int(),
    Schema.nonNegative(),
  ),
  actorSeatCount: Schema.Number.pipe(
    Schema.int(),
    Schema.nonNegative(),
  ),
  workSnapshotCount: Schema.Number.pipe(
    Schema.int(),
    Schema.nonNegative(),
  ),
  pendingCommandCount: Schema.Number.pipe(
    Schema.int(),
    Schema.nonNegative(),
  ),
  armedRegionCount: Schema.Number.pipe(
    Schema.int(),
    Schema.nonNegative(),
  ),
  schedulerCursorCount: Schema.Number.pipe(
    Schema.int(),
    Schema.nonNegative(),
  ),
  activeIntent: Schema.optionalWith(
    Schema.Struct({
      generation: Schema.String.pipe(
        Schema.pattern(/^[1-9][0-9]*$/),
      ),
      contentSha256: Schema.String.pipe(
        Schema.pattern(/^[0-9a-f]{64}$/),
      ),
    }),
    { exact: true },
  ),
  ready: Schema.Literal(true),
});
export type StateUpdatePreflightReceiptBoundary =
  typeof StateUpdatePreflightReceiptBoundary.Type;

const strictDecode = { onExcessProperty: "error" } as const;

const receiptError = (message: string): Error =>
  new Error(`invalid state update preflight receipt: ${message}`);

const assertReceiptRelationships = (
  receipt: StateUpdatePreflightReceiptBoundary,
): void => {
  if (receipt.sourceSchemaVersion > receipt.targetSchemaVersion) {
    throw receiptError(
      "source schema version exceeds the candidate target",
    );
  }
  if (receipt.source === "installed") {
    if (receipt.backupFile === undefined) {
      throw receiptError(
        "an installed source requires its retained backup witness",
      );
    }
  } else if (
    receipt.sourceSchemaVersion !== 0 ||
    receipt.backupFile !== undefined ||
    receipt.role !== "unenrolled" ||
    receipt.canvasCount !== 0 ||
    receipt.actorSeatCount !== 0 ||
    receipt.workSnapshotCount !== 0 ||
    receipt.pendingCommandCount !== 0 ||
    receipt.armedRegionCount !== 0 ||
    receipt.schedulerCursorCount !== 0 ||
    receipt.activeIntent !== undefined
  ) {
    throw receiptError(
      "a fresh source must describe one empty unenrolled candidate",
    );
  }
  if (
    (receipt.canvasCount === 0) !==
    (receipt.activeIntent === undefined)
  ) {
    throw receiptError(
      "active intent presence must agree with canvas count",
    );
  }
};

/**
 * Decode exactly the JSON.stringify output emitted by the packaged candidate.
 *
 * Re-encoding after strict schema admission rejects duplicate JSON keys,
 * alternate key order, whitespace, and escape spellings without interpolating
 * the receipt into executable code.
 */
export const decodeStateUpdatePreflightReceiptText = (
  text: string,
): StateUpdatePreflightReceiptBoundary => {
  const bytes = Buffer.byteLength(text, "utf8");
  if (
    bytes < 1 ||
    bytes > STATE_UPDATE_PREFLIGHT_RECEIPT_MAX_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(text)
  ) {
    throw receiptError("input is empty, oversized, or contains controls");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw receiptError("input is not JSON");
  }
  const receipt = Schema.decodeUnknownSync(
    StateUpdatePreflightReceiptBoundary,
    strictDecode,
  )(parsed);
  assertReceiptRelationships(receipt);
  if (JSON.stringify(receipt) !== text) {
    throw receiptError(
      "input is not the canonical single object encoding",
    );
  }
  return receipt;
};

const modulePath = fileURLToPath(import.meta.url);
const invokedPath =
  process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (invokedPath === modulePath) {
  if (process.argv.length !== 2) {
    console.error(
      "usage: bun scripts/state-update-preflight-receipt.ts < receipt.json",
    );
    process.exitCode = 2;
  } else {
    try {
      decodeStateUpdatePreflightReceiptText(
        readFileSync(0, "utf8"),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    }
  }
}
