import { Schema } from "effect";

// Provider usage plane: normalized rate-limit/quota snapshots from pluggable
// UsageSources — first-party native strategy pipelines per provider. A
// separate bounded context from the entity snapshot plane — quotas never bind
// to canvas nodes. Envelope semantics mirror entities.ts: a down source
// degrades to ok:false with a reason, never a throw.
// HUD fail-open: paint last-good when present; hide entirely when no quotas
// (no detected source, empty poll) — no error chrome.

export const UsageWindowLabel = Schema.Literals(["primary", "secondary", "tertiary", "extra"]);
export type UsageWindowLabel = typeof UsageWindowLabel.Type;

export const UsagePace = Schema.Struct({
  stage: Schema.String,
  deltaPercent: Schema.Number,
  expectedUsedPercent: Schema.optionalKey(Schema.Number),
  willLastToReset: Schema.optionalKey(Schema.Boolean),
  summary: Schema.optionalKey(Schema.String),
});
export type UsagePace = typeof UsagePace.Type;

export const UsageWindow = Schema.Struct({
  label: UsageWindowLabel,
  // Source-native identity for extra windows (e.g. "codex-spark-weekly").
  id: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  usedPercent: Schema.Number,
  windowMinutes: Schema.optionalKey(Schema.Number),
  resetsAt: Schema.optionalKey(Schema.String),
  resetDescription: Schema.optionalKey(Schema.String),
  pace: Schema.optionalKey(UsagePace),
});
export type UsageWindow = typeof UsageWindow.Type;

export const ProviderQuota = Schema.Struct({
  provider: Schema.String,
  // How the usage source read it (oauth|web|cli|auto|...).
  source: Schema.String,
  status: Schema.Literals(["ok", "error"]),
  account: Schema.optionalKey(Schema.String),
  plan: Schema.optionalKey(Schema.String),
  windows: Schema.Array(UsageWindow),
  creditsRemaining: Schema.optionalKey(Schema.Number),
  // Provider-specific payload remainder, passed through for the detail view.
  extras: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  error: Schema.optionalKey(Schema.String),
  updatedAt: Schema.String,
});
export type ProviderQuota = typeof ProviderQuota.Type;

export const UsageUnavailableReason = Schema.Literals(["cli-missing", "cli-error",
"parse-error",
"source-missing",]);
export type UsageUnavailableReason = typeof UsageUnavailableReason.Type;

export const UsageSnapshot = Schema.Struct({
  // Usage source id, e.g. "claude" | "grok" | "hermes" | "codex".
  source: Schema.String,
  fetchedAt: Schema.String,
  ok: Schema.Boolean,
  reason: Schema.optionalKey(UsageUnavailableReason),
  error: Schema.optionalKey(Schema.String),
  quotas: Schema.Array(ProviderQuota),
  // How trustworthy this payload is: "live" (fresh from the provider),
  // "stale-cache" (last-good local mirror painted honestly), or "derived"
  // (computed from indirect signals). Set by the source itself; absent means
  // the source does not distinguish.
  dataConfidence: Schema.optionalKey(Schema.String),
});
export type UsageSnapshot = typeof UsageSnapshot.Type;

/** Providers with first-party native readers (when they ship plan windows). */
export const NATIVE_USAGE_PROVIDERS = [
  "claude",
  "codex",
  "copilot",
  "cursor",
  "devin",
  "grok",
  "hermes",
  "kimi",
  "ollama",
  "opencode-go",
  "openrouter",
  "antigravity",
  "synthetic",
] as const;

/** True when any quota extras mark partial / tokens-only coverage. */
export const usageStateIsPartial = (state: { readonly snapshots: ReadonlyArray<UsageSnapshot> }): boolean =>
  state.snapshots.some(
    (snapshot) =>
      snapshot.ok &&
      snapshot.quotas.some((quota) => {
        const extras = quota.extras;
        return extras !== undefined && extras.partial === true;
      }),
  );

export const UsageState = Schema.Struct({
  snapshots: Schema.Array(UsageSnapshot),
  // True when `snapshots` are last-good (disk or prior poll) and the latest
  // live refresh has not replaced them with a fresher successful payload.
  stale: Schema.optionalKey(Schema.Boolean),
  // ISO time of the last successful live commit that carried quotas.
  lastLiveAt: Schema.optionalKey(Schema.String),
  // Last live failure message (kept while showing stale quotas).
  lastError: Schema.optionalKey(Schema.String),
});
export type UsageState = typeof UsageState.Type;

/** True when any snapshot carries at least one provider quota row. */
export const hasUsageQuotas = (state: UsageState): boolean =>
  state.snapshots.some((snapshot) => snapshot.ok && snapshot.quotas.length > 0);

// The window closest to exhaustion drives every aggregate readout (HUD fill,
// hue). Error quotas and windowless entries have no pressure and rank last.
export const worstWindow = (quota: ProviderQuota): UsageWindow | undefined =>
  quota.windows.reduce<UsageWindow | undefined>(
    (worst, window) => (worst === undefined || window.usedPercent > worst.usedPercent ? window : worst),
    undefined,
  );
