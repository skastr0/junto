/**
 * Harness inventory: what a machine has installed and which models each
 * harness offers there. A param whose options come from `inventory` resolves
 * against the SEAT's machine, never the window's.
 *
 * The local machine scans its own CLIs; another machine answers over the link.
 * Both return these shapes. Scans run in parallel under a hard deadline, are
 * cached for `INVENTORY_TTL_MS`, and never hang a reader: a stale answer is
 * served while a fresh scan runs, and a scan that fails says why.
 */
import { Schema } from "effect";
import { HarnessId } from "../managed-terminal-templates";
import { HostId } from "../remote-hosts";

export const INVENTORY_TTL_MS = 6 * 60 * 60 * 1000;

export const InventoryModel = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  /** Efforts this model accepts, when the harness reports them per model. */
  efforts: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type InventoryModel = typeof InventoryModel.Type;

export const InventoryScanFailure = Schema.Struct({
  reason: Schema.Literals(["timeout", "failed", "unreachable"]),
  // Can carry command output, so it stays on the scanned machine; a
  // snapshot read over the link carries the reason only.
  message: Schema.optionalKey(Schema.String),
  at: Schema.Number,
});
export type InventoryScanFailure = typeof InventoryScanFailure.Type;

/**
 * Where an installed version sits against the range a harness record was
 * verified on. Anything but `verified` means Junto's reading of that harness
 * (screen rules, params, decoders) has not been checked on this install.
 */
export const VersionVerdict = Schema.Literals(["verified", "older", "newer", "unknown"]);
export type VersionVerdict = typeof VersionVerdict.Type;

export const VerifiedRange = Schema.Struct({ from: Schema.String, through: Schema.String });
export type VerifiedRange = typeof VerifiedRange.Type;

export const InventoryVerification = Schema.Struct({
  verdict: VersionVerdict,
  from: Schema.String,
  through: Schema.String,
});
export type InventoryVerification = typeof InventoryVerification.Type;

/**
 * The first dotted number in a version string, by segment: `v0.21.6+675`,
 * `2026.10.14`, `codex-cli 0.46.0`. Undefined when there is none.
 */
export const versionNumbers = (raw: string): readonly number[] | undefined =>
  raw.match(/\d+(?:\.\d+)*/)?.[0].split(".").map(Number);

/** Numeric compare by segment; a missing segment reads as 0. */
export const compareVersions = (a: readonly number[], b: readonly number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const order = (a[i] ?? 0) - (b[i] ?? 0);
    if (order !== 0) return order;
  }
  return 0;
};

/** Is `installed` inside `range`, inclusive at both ends? */
export const verifyVersion = (installed: string | undefined, range: VerifiedRange): InventoryVerification => {
  const at = installed === undefined ? undefined : versionNumbers(installed);
  const from = versionNumbers(range.from);
  const through = versionNumbers(range.through);
  const verdict: VersionVerdict =
    at === undefined || from === undefined || through === undefined
      ? "unknown"
      : compareVersions(at, from) < 0
        ? "older"
        : compareVersions(at, through) > 0
          ? "newer"
          : "verified";
  return { verdict, from: range.from, through: range.through };
};

export const HarnessInventory = Schema.Struct({
  harness: HarnessId,
  machine: HostId,
  installed: Schema.Boolean,
  executable: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  models: Schema.Array(InventoryModel),
  /** Efforts the harness offers when its models carry none. */
  efforts: Schema.Array(Schema.String),
  /** When the models were scanned; absent before the first scan finishes. */
  scannedAt: Schema.optionalKey(Schema.Number),
  /** A scan is running now; the models shown are the last good answer. */
  refreshing: Schema.Boolean,
  lastFailure: Schema.optionalKey(InventoryScanFailure),
  /** The installed version against the record's verified range; absent when not installed. */
  verification: Schema.optionalKey(InventoryVerification),
});
export type HarnessInventory = typeof HarnessInventory.Type;

export const MachineInventory = Schema.Struct({
  machine: HostId,
  harnesses: Schema.Array(HarnessInventory),
});
export type MachineInventory = typeof MachineInventory.Type;

export class InventoryUnavailableError extends Schema.TaggedError<InventoryUnavailableError>()(
  "InventoryUnavailableError",
  {
    machine: Schema.String,
    harness: Schema.optionalKey(Schema.String),
    reason: Schema.Literals(["timeout", "failed", "unreachable", "notInstalled"]),
    message: Schema.String,
  },
) {}

export const isInventoryStale = (inventory: HarnessInventory, nowMs: number): boolean =>
  inventory.scannedAt === undefined || nowMs - inventory.scannedAt >= INVENTORY_TTL_MS;

/** The values an `inventory` param offers on a machine. */
export const inventoryOptions = (inventory: HarnessInventory | undefined): readonly string[] =>
  inventory?.installed ? inventory.models.map((model) => model.id) : [];
