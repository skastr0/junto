/**
 * The link's native-config channel: a harness's own settings, read and
 * written by closed key on the machine that holds them (docs/machines.md,
 * Harness inventory: native config).
 *
 * A request names the canvas, a harness, declared keys and a typed value;
 * never a file, a path, free text or a command. An answer carries the keys
 * asked for and their typed values, and a value read from a file that does
 * not fit its declared setting crosses as unfit, never as its text. Every
 * failure is rebuilt from its reason and key, so no path, file name or file
 * text crosses.
 */
import { Schema } from "effect";
import { OperationId } from "@shared/failure";
import { InventoryUnavailableError } from "@shared/harness-domain/inventory";
import { MachineName } from "@shared/machine-control";
import { HarnessId } from "@shared/managed-terminal-templates";
import { CanvasName } from "@shared/model";
import { MODEL_ID_PATTERN } from "@shared/model-id";
import { InventoryCanvasEditorMismatch, InventoryNoSeatHere, InventoryPeerNotPinned } from "./wire";

/** A harness's own key path, e.g. `permissions.defaultMode`; membership is the receiver's catalogue. */
export const NATIVE_KEY = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
export const MAX_NATIVE_KEYS = 16;

const Key = Schema.String.pipe(Schema.check(Schema.isPattern(NATIVE_KEY)));
/**
 * Every declared string and enum value is in the model id shape (`default`,
 * `on-request`, `opus[1m]`); the receiver still checks the declared spec.
 */
export const NativeWireValue = Schema.Union([
  Schema.Boolean,
  Schema.Finite,
  Schema.String.pipe(Schema.check(Schema.isPattern(MODEL_ID_PATTERN))),
]);
export type NativeWireValue = typeof NativeWireValue.Type;
export const isNativeWireValue = Schema.is(NativeWireValue);

const Keys = Schema.Array(Key).pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(MAX_NATIVE_KEYS)));

export const NativeConfigRequest = Schema.Union([
  Schema.TaggedStruct("ReadSettings", { canvas: CanvasName, harness: HarnessId, keys: Keys }),
  /** A set, never a toggle: sending it twice leaves the same file. */
  Schema.TaggedStruct("WriteSetting", { canvas: CanvasName, harness: HarnessId, key: Key, value: NativeWireValue }),
]);
export type NativeConfigRequest = typeof NativeConfigRequest.Type;

export const NativeSettingRead = Schema.Union([
  Schema.Struct({ key: Key, value: NativeWireValue }),
  /** The file holds a value outside the declared setting; its text stays home. */
  Schema.Struct({ key: Key, unfit: Schema.Literal(true) }),
]);
export type NativeSettingRead = typeof NativeSettingRead.Type;

export const NativeConfigResponse = Schema.Union([
  Schema.TaggedStruct("Settings", {
    machine: MachineName,
    harness: HarnessId,
    values: Schema.Array(NativeSettingRead).pipe(Schema.check(Schema.isMaxLength(MAX_NATIVE_KEYS))),
  }),
  /** The value as read back after the write. */
  Schema.TaggedStruct("Written", { machine: MachineName, harness: HarnessId, key: Key, value: NativeWireValue }),
]);
export type NativeConfigResponse = typeof NativeConfigResponse.Type;

// ── Failures ───────────────────────────────────────────────────────────────

const Where = {
  machine: MachineName,
  operationId: Schema.optionalKey(OperationId),
  harness: HarnessId,
  key: Schema.optionalKey(Key),
  message: Schema.String.pipe(Schema.check(Schema.isMaxLength(1024))),
};

/** Refused before any file was read: undeclared, not verified for the installed version, or a value outside the setting. */
export class NativeSettingRefused extends Schema.TaggedError<NativeSettingRefused>()("NativeSettingRefused", {
  ...Where,
  reason: Schema.Literals(["undeclared", "version", "value"]),
}) {}

/** Admitted, then the file itself: changed since the last read, a shape not edited in place, or the read or replace failed. */
export class NativeConfigWriteFailed extends Schema.TaggedError<NativeConfigWriteFailed>()("NativeConfigWriteFailed", {
  ...Where,
  reason: Schema.Literals(["conflict", "unsupported", "io"]),
}) {}

/** An event frame on the native-config channel, which carries none. */
export class NativeConfigEventRefused extends Schema.TaggedError<NativeConfigEventRefused>()("NativeConfigEventRefused", {
  message: Schema.String.pipe(Schema.check(Schema.isMaxLength(1024))),
}) {}

/** An answer that failed the closed decode or did not answer what was asked; the link stays open. */
export class NativeConfigAnswerRefused extends Schema.TaggedError<NativeConfigAnswerRefused>()("NativeConfigAnswerRefused", {
  machine: MachineName,
  operationId: Schema.optionalKey(OperationId),
  message: Schema.String.pipe(Schema.check(Schema.isMaxLength(1024))),
}) {}

export const NativeConfigLinkFailure = Schema.Union([
  InventoryPeerNotPinned,
  InventoryCanvasEditorMismatch,
  InventoryNoSeatHere,
  InventoryUnavailableError,
  NativeSettingRefused,
  NativeConfigWriteFailed,
]);
export type NativeConfigLinkFailure = typeof NativeConfigLinkFailure.Type;

/** Fixed text per reason: the machine's own messages can name paths and files. */
export const NATIVE_REFUSAL_TEXT: Readonly<Record<NativeSettingRefused["reason"], string>> = {
  undeclared: "is not a declared setting for this harness",
  version: "is not verified for the harness version installed on this machine",
  value: "does not take that value",
};
export const NATIVE_WRITE_TEXT: Readonly<Record<NativeConfigWriteFailed["reason"], string>> = {
  conflict: "changed in its file since this machine last read it; read it again first",
  unsupported: "is held in its file in a shape Junto does not edit in place",
  io: "could not be read or written in its file on this machine",
};
