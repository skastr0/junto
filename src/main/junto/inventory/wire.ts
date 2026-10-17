/**
 * The link's inventory channel: what crosses, and nothing else
 * (docs/machines.md, Harness inventory).
 *
 * The request is the canvas only. The answer is its own closed struct, not
 * `HarnessInventory`: the executable path, failure text and model
 * descriptions stay on the scanned machine. Every harness-output string has a
 * pattern as well as a bound, so a snapshot has a fixed maximum size and no
 * control, bidi, zero-width, quote or angle-bracket character. The sender
 * builds it field by field and leaves out what does not fit; the receiver
 * decodes it closed.
 */
import { Schema } from "effect";
import {
  type HarnessInventory,
  InventoryUnavailableError,
  type MachineInventory,
  VersionVerdict,
} from "@shared/harness-domain/inventory";
import { MachineName } from "@shared/machine-control";
import { HARNESS_IDS, HarnessId, templateFor } from "@shared/managed-terminal-templates";
import { CanvasName } from "@shared/model";
import { MODEL_ID_PATTERN, MODEL_LABEL_PATTERN } from "@shared/model-id";

const bounded = (pattern: RegExp) => Schema.String.pipe(Schema.check(Schema.isPattern(pattern)));
const list = <S extends Schema.Top>(item: S, max: number) => Schema.Array(item).pipe(Schema.check(Schema.isMaxLength(max)));
const At = Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

/** A parsed version token, never raw `--version` output. */
export const WIRE_VERSION = /^[0-9][0-9A-Za-z.+-]{0,63}$/;
/** A verified range end: dotted numbers. */
export const WIRE_RANGE_END = /^\d{1,12}(?:\.\d{1,12}){0,7}$/;
/** Shared with the native config model value, so a picked id writes back safely. */
export const WIRE_MODEL_ID = MODEL_ID_PATTERN;
/** Shown as plain text only; the picker keys on the id. */
export const WIRE_MODEL_LABEL = MODEL_LABEL_PATTERN;
export const WIRE_EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;
export const WIRE_MODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const MAX_WIRE_MODELS = 200;
export const MAX_WIRE_EFFORTS = 16;
export const MAX_WIRE_MODES = 32;
export const MAX_WIRE_PERMISSION_MODES = 16;

const Version = bounded(WIRE_VERSION);
const RangeEnd = bounded(WIRE_RANGE_END);
const Effort = bounded(WIRE_EFFORT);
const Mode = bounded(WIRE_MODE);

export const LinkInventoryModel = Schema.Struct({
  id: bounded(WIRE_MODEL_ID),
  label: bounded(WIRE_MODEL_LABEL),
  efforts: Schema.optionalKey(list(Effort, MAX_WIRE_EFFORTS)),
});

export const LinkInventoryHarness = Schema.Struct({
  harness: HarnessId,
  installed: Schema.Boolean,
  version: Schema.optionalKey(Version),
  verification: Schema.optionalKey(Schema.Struct({ verdict: VersionVerdict, from: RangeEnd, through: RangeEnd })),
  models: list(LinkInventoryModel, MAX_WIRE_MODELS),
  efforts: list(Effort, MAX_WIRE_EFFORTS),
  modes: list(Mode, MAX_WIRE_MODES),
  permissionModes: list(Mode, MAX_WIRE_PERMISSION_MODES),
  scannedAt: Schema.optionalKey(At),
  refreshing: Schema.Boolean,
  // Unreachable is the editing machine's own word, never the peer's.
  failure: Schema.optionalKey(Schema.Struct({ reason: Schema.Literals(["timeout", "failed"]), at: At })),
});
export type LinkInventoryHarness = typeof LinkInventoryHarness.Type;

export const LinkInventorySnapshot = Schema.Struct({
  machine: MachineName,
  takenAt: At,
  harnesses: list(LinkInventoryHarness, HARNESS_IDS.length),
});
export type LinkInventorySnapshot = typeof LinkInventorySnapshot.Type;

export const LinkInventoryRequest = Schema.Struct({ canvas: CanvasName });
export type LinkInventoryRequest = typeof LinkInventoryRequest.Type;

// ── Failures ───────────────────────────────────────────────────────────────

const Where = { machine: Schema.String, operationId: Schema.optionalKey(Schema.String), message: Schema.String };

/** The asking machine is no longer pinned on the answering one. */
export class InventoryPeerNotPinned extends Schema.TaggedError<InventoryPeerNotPinned>()("InventoryPeerNotPinned", Where) {}
/** Only the machine that edits the canvas may ask for its seats' machine inventory. */
export class InventoryCanvasEditorMismatch extends Schema.TaggedError<InventoryCanvasEditorMismatch>()("InventoryCanvasEditorMismatch", Where) {}
/** The canvas has no seat on the answering machine. */
export class InventoryNoSeatHere extends Schema.TaggedError<InventoryNoSeatHere>()("InventoryNoSeatHere", Where) {}

/** The channel's closed failure union: what a handler failure may cross as. */
export const InventoryLinkFailure = Schema.Union([
  InventoryPeerNotPinned,
  InventoryCanvasEditorMismatch,
  InventoryNoSeatHere,
  InventoryUnavailableError,
]);
export type InventoryLinkFailure = typeof InventoryLinkFailure.Type;

/** A snapshot that failed the closed decode, refused on arrival; the link stays open. */
export class InventorySnapshotRefused extends Schema.TaggedError<InventorySnapshotRefused>()("InventorySnapshotRefused", Where) {}
/** A snapshot that names another machine than the link peer that sent it. */
export class InventoryNotFromItsMachine extends Schema.TaggedError<InventoryNotFromItsMachine>()("InventoryNotFromItsMachine", {
  ...Where,
  claimed: Schema.String,
}) {}

// ── Building and reading ───────────────────────────────────────────────────

const fits = (pattern: RegExp) => (value: string): boolean => pattern.test(value);

const wireModel = (model: HarnessInventory["models"][number]): typeof LinkInventoryModel.Type | undefined => {
  if (!WIRE_MODEL_ID.test(model.id)) return undefined;
  // An id always fits the label pattern; a label that does not is shown as its id.
  const label = WIRE_MODEL_LABEL.test(model.label) ? model.label : model.id.slice(0, 80);
  const efforts = model.efforts?.filter(fits(WIRE_EFFORT)).slice(0, MAX_WIRE_EFFORTS);
  return { id: model.id, label, ...(efforts === undefined ? {} : { efforts }) };
};

/** What one machine says about one harness, built field by field. */
export const wireHarness = (row: HarnessInventory): { readonly harness: LinkInventoryHarness; readonly omittedModels: number } => {
  const template = templateFor(row.harness);
  const models = row.models.map(wireModel).filter((model) => model !== undefined).slice(0, MAX_WIRE_MODELS);
  const verification = row.verification;
  return {
    omittedModels: Math.min(row.models.length, MAX_WIRE_MODELS) - models.length,
    harness: {
      harness: row.harness,
      installed: row.installed,
      ...(row.version !== undefined && WIRE_VERSION.test(row.version) ? { version: row.version } : {}),
      ...(verification !== undefined && WIRE_RANGE_END.test(verification.from) && WIRE_RANGE_END.test(verification.through)
        ? { verification: { verdict: verification.verdict, from: verification.from, through: verification.through } }
        : {}),
      models,
      efforts: row.efforts.filter(fits(WIRE_EFFORT)).slice(0, MAX_WIRE_EFFORTS),
      modes: (template.modes ?? []).filter(fits(WIRE_MODE)).slice(0, MAX_WIRE_MODES),
      permissionModes: (template.permissionModes ?? []).filter(fits(WIRE_MODE)).slice(0, MAX_WIRE_PERMISSION_MODES),
      ...(row.scannedAt === undefined ? {} : { scannedAt: row.scannedAt }),
      refreshing: row.refreshing,
      ...(row.lastFailure === undefined || row.lastFailure.reason === "unreachable"
        ? {}
        : { failure: { reason: row.lastFailure.reason, at: row.lastFailure.at } }),
    },
  };
};

/** This machine's inventory as it may cross the link. */
export const wireSnapshot = (
  inventory: MachineInventory,
  takenAt: number,
): { readonly snapshot: LinkInventorySnapshot; readonly omittedModels: number } => {
  const seen = new Set<string>();
  const rows = inventory.harnesses.filter((row) => !seen.has(row.harness) && seen.add(row.harness));
  const built = rows.map(wireHarness);
  return {
    snapshot: { machine: inventory.machine, takenAt, harnesses: built.map((entry) => entry.harness) },
    omittedModels: built.reduce((total, entry) => total + entry.omittedModels, 0),
  };
};

const decodeSnapshot = Schema.decodeUnknownSync(LinkInventorySnapshot, { onExcessProperty: "error" });

/**
 * Decode a snapshot closed. Throws on anything outside the schema, or a
 * harness named twice.
 */
export const decodeLinkInventorySnapshot = (payload: unknown): LinkInventorySnapshot => {
  const snapshot = decodeSnapshot(payload);
  if (new Set(snapshot.harnesses.map((row) => row.harness)).size !== snapshot.harnesses.length) {
    throw new Error("a harness is named twice");
  }
  return snapshot;
};

/** A peer's snapshot as the editing machine's settings and pickers read it. */
export const inventoryOfSnapshot = (snapshot: LinkInventorySnapshot): MachineInventory => ({
  machine: snapshot.machine,
  harnesses: snapshot.harnesses.map((row): HarnessInventory => ({
    harness: row.harness,
    machine: snapshot.machine,
    installed: row.installed,
    ...(row.version === undefined ? {} : { version: row.version }),
    models: row.models.map((model) => ({
      id: model.id,
      label: model.label,
      ...(model.efforts === undefined ? {} : { efforts: [...model.efforts] }),
    })),
    efforts: [...row.efforts],
    ...(row.scannedAt === undefined ? {} : { scannedAt: row.scannedAt }),
    refreshing: row.refreshing,
    ...(row.failure === undefined ? {} : { lastFailure: { reason: row.failure.reason, at: row.failure.at } }),
    ...(row.verification === undefined ? {} : { verification: { ...row.verification } }),
  })),
});
