import { Schema } from "effect";

// Provider usage plane: normalized rate-limit/quota snapshots from pluggable
// UsageSources (codexbar CLI first). A separate bounded context from the
// entity snapshot plane — quotas never bind to canvas nodes. Envelope
// semantics mirror entities.ts: a down source degrades to ok:false with a
// reason, never a throw, and the renderer simply hides the surface.

export const UsageWindowLabel = Schema.Literal("primary", "secondary", "tertiary", "extra");
export type UsageWindowLabel = typeof UsageWindowLabel.Type;

export const UsagePace = Schema.Struct({
  stage: Schema.String,
  deltaPercent: Schema.Number,
  expectedUsedPercent: Schema.optionalWith(Schema.Number, { exact: true }),
  willLastToReset: Schema.optionalWith(Schema.Boolean, { exact: true }),
  summary: Schema.optionalWith(Schema.String, { exact: true }),
});
export type UsagePace = typeof UsagePace.Type;

export const UsageWindow = Schema.Struct({
  label: UsageWindowLabel,
  // Source-native identity for extra windows (e.g. "codex-spark-weekly").
  id: Schema.optionalWith(Schema.String, { exact: true }),
  title: Schema.optionalWith(Schema.String, { exact: true }),
  usedPercent: Schema.Number,
  windowMinutes: Schema.optionalWith(Schema.Number, { exact: true }),
  resetsAt: Schema.optionalWith(Schema.String, { exact: true }),
  resetDescription: Schema.optionalWith(Schema.String, { exact: true }),
  pace: Schema.optionalWith(UsagePace, { exact: true }),
});
export type UsageWindow = typeof UsageWindow.Type;

export const ProviderQuota = Schema.Struct({
  provider: Schema.String,
  // How the usage source read it (oauth|web|cli|auto|...).
  source: Schema.String,
  status: Schema.Literal("ok", "error"),
  account: Schema.optionalWith(Schema.String, { exact: true }),
  plan: Schema.optionalWith(Schema.String, { exact: true }),
  windows: Schema.Array(UsageWindow),
  creditsRemaining: Schema.optionalWith(Schema.Number, { exact: true }),
  // Provider-specific payload remainder, passed through for the detail view.
  extras: Schema.optionalWith(Schema.Record({ key: Schema.String, value: Schema.Unknown }), { exact: true }),
  error: Schema.optionalWith(Schema.String, { exact: true }),
  updatedAt: Schema.String,
});
export type ProviderQuota = typeof ProviderQuota.Type;

export const UsageUnavailableReason = Schema.Literal("cli-missing", "cli-error", "parse-error");
export type UsageUnavailableReason = typeof UsageUnavailableReason.Type;

export const UsageSnapshot = Schema.Struct({
  // Usage source id, e.g. "codexbar".
  source: Schema.String,
  fetchedAt: Schema.String,
  ok: Schema.Boolean,
  reason: Schema.optionalWith(UsageUnavailableReason, { exact: true }),
  error: Schema.optionalWith(Schema.String, { exact: true }),
  quotas: Schema.Array(ProviderQuota),
});
export type UsageSnapshot = typeof UsageSnapshot.Type;

export const UsageState = Schema.Struct({
  snapshots: Schema.Array(UsageSnapshot),
});
export type UsageState = typeof UsageState.Type;

// The window closest to exhaustion drives every aggregate readout (HUD fill,
// hue). Error quotas and windowless entries have no pressure and rank last.
export const worstWindow = (quota: ProviderQuota): UsageWindow | undefined =>
  quota.windows.reduce<UsageWindow | undefined>(
    (worst, window) => (worst === undefined || window.usedPercent > worst.usedPercent ? window : worst),
    undefined,
  );
