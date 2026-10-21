/**
 * The link's settings channel: what crosses, and nothing else
 * (docs/machines.md, Harness inventory: every machine-scoped page uses the
 * same path).
 *
 * Providers cross as source names and, per declared secret field, whether a
 * value is set. A value, an id or a length never crosses: a credential is set
 * on its own machine. The record crosses as the startup preference only; the
 * machine's name is the editing machine's own label for it. Cache windows
 * cross as minutes, the machine's and each declared harness's that differs:
 * a seat's session is cut on the machine it runs on, by that machine's
 * windows. Every request
 * names the canvas and nothing about the asker, and every write sets a value,
 * so a retried write lands the same.
 */
import { Schema } from "effect";
import { OperationId } from "@shared/failure";
import { MachineName } from "@shared/machine-control";
import type { MachineCacheWindows, MachineProviders, MachineRecord } from "@shared/machine-settings";
import { HARNESS_IDS } from "@shared/managed-terminal-templates";
import { CanvasName } from "@shared/model";
import { PROVIDER_SECRET_FIELDS, PROVIDER_SECTION_KEYS } from "@shared/settings";
import { CacheMode, CacheWindowMinutes } from "@shared/seat-offboard";
import { NATIVE_USAGE_PROVIDERS, NativeUsageProvider } from "@shared/usage";

const Sources = Schema.Array(NativeUsageProvider).pipe(
  Schema.check(Schema.isMaxLength(NATIVE_USAGE_PROVIDERS.length)),
);

export const ProvidersRead = Schema.TaggedStruct("ProvidersRead", { canvas: CanvasName });
export const ProvidersWrite = Schema.TaggedStruct("ProvidersWrite", {
  canvas: CanvasName,
  enabledSources: Schema.optionalKey(Sources),
});
export const RecordRead = Schema.TaggedStruct("RecordRead", { canvas: CanvasName });
export const StartupWrite = Schema.TaggedStruct("StartupWrite", {
  canvas: CanvasName,
  supervisedPreferred: Schema.Boolean,
});

export const CacheWindowsRead = Schema.TaggedStruct("CacheWindowsRead", { canvas: CanvasName });
/** A harness set to null follows the machine's window again. Only declared harnesses may be named. */
export const CacheWindowsWrite = Schema.TaggedStruct("CacheWindowsWrite", {
  canvas: CanvasName,
  cacheWindowMinutes: Schema.optionalKey(CacheWindowMinutes),
  harness: Schema.optionalKey(Schema.Struct(Object.fromEntries(
    HARNESS_IDS.map((harness) => [harness, Schema.optionalKey(Schema.NullOr(CacheWindowMinutes))]),
  ))),
  cacheMode: Schema.optionalKey(CacheMode),
});

export const LinkSettingsRequest = Schema.Union([
  ProvidersRead,
  ProvidersWrite,
  RecordRead,
  StartupWrite,
  CacheWindowsRead,
  CacheWindowsWrite,
]);
export type LinkSettingsRequest = typeof LinkSettingsRequest.Type;

const decodeRequest = Schema.decodeUnknownSync(LinkSettingsRequest, { onExcessProperty: "error" });

/** Decode a request closed; a providers write must set something. */
export const decodeLinkSettingsRequest = (raw: unknown): LinkSettingsRequest => {
  const request = decodeRequest(raw);
  if (request._tag === "ProvidersWrite" && request.enabledSources === undefined) {
    throw new Error("a providers write sets enabledSources");
  }
  if (request._tag === "ProvidersWrite" && request.enabledSources !== undefined
    && new Set(request.enabledSources).size !== request.enabledSources.length) {
    throw new Error("a source is named twice");
  }
  if (request._tag === "CacheWindowsWrite" && request.cacheWindowMinutes === undefined
    && Object.keys(request.harness ?? {}).length === 0 && request.cacheMode === undefined) {
    throw new Error("a cache windows write sets the machine's window, a harness's, or the cache mode");
  }
  return request;
};

// The credential map is closed: each declared section, each declared field, a boolean.
const Credentials = Schema.Struct(Object.fromEntries(PROVIDER_SECTION_KEYS.map((section) => [
  section,
  Schema.Struct(Object.fromEntries(PROVIDER_SECRET_FIELDS[section].map((field) => [field, Schema.Boolean]))),
])));

export const LinkProviders = Schema.Struct({
  machine: MachineName,
  enabledSources: Sources,
  credentials: Credentials,
});
export type LinkProviders = typeof LinkProviders.Type;

export const LinkRecord = Schema.Struct({ machine: MachineName, supervisedPreferred: Schema.Boolean });
export type LinkRecord = typeof LinkRecord.Type;

// The harness map is closed: each declared harness, at most once, as minutes.
// A machine on a build from before the cache mode answers without one.
export const LinkCacheWindows = Schema.Struct({
  machine: MachineName,
  cacheWindowMinutes: CacheWindowMinutes,
  harness: Schema.Struct(Object.fromEntries(HARNESS_IDS.map((harness) => [harness, Schema.optionalKey(CacheWindowMinutes)]))),
  cacheMode: Schema.optionalKey(CacheMode),
});
export type LinkCacheWindows = typeof LinkCacheWindows.Type;

// ── Failures ───────────────────────────────────────────────────────────────

// Bounded as everything else that crosses: a failure rides the link as detail.
const Where = {
  machine: MachineName,
  operationId: Schema.optionalKey(OperationId),
  message: Schema.String.pipe(Schema.check(Schema.isMaxLength(1024))),
};

/** The asking machine is no longer pinned on the answering one. */
export class SettingsPeerNotPinned extends Schema.TaggedError<SettingsPeerNotPinned>()("SettingsPeerNotPinned", Where) {}
/** Only the machine that edits the canvas may ask for a seat machine's settings. */
export class SettingsCanvasEditorMismatch extends Schema.TaggedError<SettingsCanvasEditorMismatch>()("SettingsCanvasEditorMismatch", Where) {}
/** The canvas has no seat on the answering machine. */
export class SettingsNoSeatHere extends Schema.TaggedError<SettingsNoSeatHere>()("SettingsNoSeatHere", Where) {}
/** The answering machine could not read or change its settings; its text stays home. */
export class SettingsNotAnswered extends Schema.TaggedError<SettingsNotAnswered>()("SettingsNotAnswered", Where) {}

/** The channel's closed failure union: what a handler failure may cross as. */
export const SettingsLinkFailure = Schema.Union([
  SettingsPeerNotPinned,
  SettingsCanvasEditorMismatch,
  SettingsNoSeatHere,
  SettingsNotAnswered,
]);
export type SettingsLinkFailure = typeof SettingsLinkFailure.Type;

/** An event frame on the settings channel, which carries none. */
export class SettingsEventRefused extends Schema.TaggedError<SettingsEventRefused>()("SettingsEventRefused", {
  message: Schema.String.pipe(Schema.check(Schema.isMaxLength(1024))),
}) {}

/** An answer that failed the closed decode, refused on arrival; the link stays open. */
export class SettingsAnswerRefused extends Schema.TaggedError<SettingsAnswerRefused>()("SettingsAnswerRefused", Where) {}
/** An answer that names another machine than the link peer that sent it. */
export class SettingsNotFromItsMachine extends Schema.TaggedError<SettingsNotFromItsMachine>()("SettingsNotFromItsMachine", {
  ...Where,
  claimed: MachineName,
}) {}

// ── Building and reading ───────────────────────────────────────────────────

/**
 * This machine's providers as they may cross: built by walking the declared
 * sections and fields, never by spreading settings, so a field added to
 * settings later cannot ride along.
 */
export const wireProviders = (providers: MachineProviders): LinkProviders => {
  const credentials: Record<string, Record<string, boolean>> = {};
  for (const section of PROVIDER_SECTION_KEYS) {
    const fields: Record<string, boolean> = {};
    for (const field of PROVIDER_SECRET_FIELDS[section]) fields[field] = providers.credentials[section]?.[field] === true;
    credentials[section] = fields;
  }
  const seen = new Set<string>();
  return {
    machine: providers.machine,
    enabledSources: providers.enabledSources.filter((source) => !seen.has(source) && seen.add(source)),
    credentials: credentials as LinkProviders["credentials"],
  };
};

export const wireRecord = (record: MachineRecord): LinkRecord => ({
  machine: record.machine,
  supervisedPreferred: record.supervisedPreferred === true,
});

/** This machine's cache windows as they may cross: declared harnesses only. */
export const wireCacheWindows = (windows: MachineCacheWindows): LinkCacheWindows => ({
  machine: windows.machine,
  cacheWindowMinutes: windows.cacheWindowMinutes,
  harness: Object.fromEntries(
    HARNESS_IDS.flatMap((harness) => {
      const minutes = windows.harness[harness];
      return minutes === undefined ? [] : [[harness, minutes]];
    }),
  ),
  ...(windows.cacheMode === undefined ? {} : { cacheMode: windows.cacheMode }),
});

export const decodeLinkProviders = Schema.decodeUnknownSync(LinkProviders, { onExcessProperty: "error" });
export const decodeLinkCacheWindows = Schema.decodeUnknownSync(LinkCacheWindows, { onExcessProperty: "error" });
export const decodeLinkRecord = Schema.decodeUnknownSync(LinkRecord, { onExcessProperty: "error" });

export const providersOfWire = (wire: LinkProviders): MachineProviders => ({
  machine: wire.machine,
  enabledSources: [...wire.enabledSources],
  credentials: Object.fromEntries(Object.entries(wire.credentials).map(([section, fields]) => [section, { ...fields }])),
});

export const cacheWindowsOfWire = (wire: LinkCacheWindows): MachineCacheWindows => ({
  machine: wire.machine,
  cacheWindowMinutes: wire.cacheWindowMinutes,
  harness: { ...wire.harness } as Record<string, number>,
  ...(wire.cacheMode === undefined ? {} : { cacheMode: wire.cacheMode }),
});

/** A linked machine's record; its name is the label the editing machine knows it by. */
export const recordOfWire = (wire: LinkRecord): MachineRecord => ({
  machine: wire.machine,
  name: wire.machine,
  supervisedPreferred: wire.supervisedPreferred,
});
