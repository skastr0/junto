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
  message: Schema.String,
  at: Schema.Number,
});
export type InventoryScanFailure = typeof InventoryScanFailure.Type;

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
