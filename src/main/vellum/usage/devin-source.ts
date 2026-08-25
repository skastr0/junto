import { Effect } from "effect";
import type { ProviderQuota, UsageSnapshot, UsageWindow } from "@shared/usage";
import { detectDevinCredential, resolveDevinCredential } from "./devin-auth";
import type { DevinCredential } from "./devin-auth";
import type { UsageSource } from "./usage-source";

// Native Devin (Cognition) usage: daily/weekly ACU quota windows from the
// app.devin.ai web backend,
// `GET https://app.devin.ai/api/<organization>/billing/quota/usage`,
// bearer from the browser session or DEVIN_* env overrides (CodexBar
// parity). Read-only; on 401/403 we tell the operator to refresh the Devin
// session — never a write, spawn, or token refresh. Every failure mode folds
// into a TOTAL envelope; nothing throws.

const BASE_URL = "https://app.devin.ai/api/";
const FETCH_TIMEOUT_MS = 10_000;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (value.trim() !== "" && Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

/**
 * Endpoint candidates for one organization, in probe order (CodexBar
 * `candidatePaths` parity): internal ID path first, normalized form next,
 * then slug/prefixed variants.
 */
export const candidatePaths = (
  organization: string,
  internalOrganizationId?: string,
): string[] => {
  const paths: string[] = [];
  const push = (path: string): void => {
    if (!paths.includes(path)) paths.push(path);
  };
  const normalized = organization;
  const slug = normalized.startsWith("org/") ? normalized.slice(4) : undefined;
  if (internalOrganizationId !== undefined) {
    push(`${internalOrganizationId}/billing/quota/usage`);
  }
  push(`${normalized}/billing/quota/usage`);
  if (slug !== undefined) push(`${slug}/billing/quota/usage`);
  else push(`org/${normalized.replace(/^organizations\//, "")}/billing/quota/usage`);
  if (internalOrganizationId !== undefined) {
    push(`organizations/${internalOrganizationId}/billing/quota/usage`);
  }
  return paths;
};

/** Percent fields arrive as either 0..1 fractions or whole percents. */
const toPercent = (value: unknown): number | undefined => {
  const raw = asNumber(value);
  if (raw === undefined || raw < 0) return undefined;
  return raw <= 1 ? raw * 100 : raw;
};

/** ISO strings, epoch seconds and epoch milliseconds all decode. */
const isoFromDateValue = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return isoFromDateValue(numeric);
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const seconds = asNumber(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  const ms = seconds > 10_000_000_000 ? seconds : seconds * 1000;
  return new Date(ms).toISOString();
};

interface RawWindow {
  readonly usedPercent: number;
  readonly resetsAt?: string;
}

const windowFromCurrentShape = (
  percent: unknown,
  resetAt: unknown,
): RawWindow | undefined => {
  const usedPercent = toPercent(percent);
  if (usedPercent === undefined) return undefined;
  const resetsAt = isoFromDateValue(resetAt);
  return { usedPercent, ...(resetsAt !== undefined ? { resetsAt } : {}) };
};

/**
 * Nested fallback shape (`quota_usage.daily_quota.{…}`) — used/limit pairs,
 * direct/remaining percent keys, `reset_at` / `next_reset_at`.
 */
const windowFromNestedQuota = (value: unknown): RawWindow | undefined => {
  if (!isObject(value)) return undefined;
  let usedPercent =
    toPercent(value.used_percent) ??
    toPercent(value.usedPercent) ??
    toPercent(value.usage_percent);
  if (usedPercent === undefined) {
    const remaining = toPercent(
      value.remaining_percent ?? value.percent_remaining ?? value.remainingPercent,
    );
    if (remaining !== undefined) usedPercent = Math.max(0, Math.min(100, 100 - remaining));
  }
  if (usedPercent === undefined) {
    const used = asNumber(value.used ?? value.usage);
    const limit = asNumber(value.limit ?? value.quota ?? value.total);
    if (used !== undefined && limit !== undefined && limit > 0) {
      usedPercent = Math.max(0, Math.min(100, (used / limit) * 100));
    }
  }
  if (usedPercent === undefined) return undefined;
  const resetsAt =
    isoFromDateValue(value.reset_at) ?? isoFromDateValue(value.next_reset_at) ?? undefined;
  return { usedPercent, ...(resetsAt !== undefined ? { resetsAt } : {}) };
};

const nestedDaily = (payload: JsonObject): RawWindow | undefined => {
  const quotaUsage = isObject(payload.quota_usage) ? payload.quota_usage : undefined;
  if (quotaUsage === undefined) return undefined;
  return windowFromNestedQuota(quotaUsage.daily_quota);
};

const nestedWeekly = (payload: JsonObject): RawWindow | undefined => {
  const quotaUsage = isObject(payload.quota_usage) ? payload.quota_usage : undefined;
  if (quotaUsage === undefined) return undefined;
  return windowFromNestedQuota(quotaUsage.weekly_quota);
};

/** Overage ACU balance → creditsRemaining (dollars, or cents /100). */
const parseOverageBalance = (payload: JsonObject): number | undefined => {
  const dollars = asNumber(payload.overage_balance);
  if (dollars !== undefined && dollars >= 0) return dollars;
  const cents = asNumber(payload.overage_balance_cents);
  if (cents !== undefined && cents >= 0) return cents / 100;
  return undefined;
};

/** `team_plan` → `Team Plan` for the plan row. */
const cleanPlanName = (raw: string): string =>
  raw
    .trim()
    .split(/[_\-\s]+/)
    .filter((part) => part !== "")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const findPlanName = (payload: JsonObject): string | undefined => {
  for (const key of ["plan_name", "planName", "plan", "tier", "subscription_tier"]) {
    const value = asString(payload[key]);
    if (value !== undefined && value.trim() !== "") return cleanPlanName(value);
  }
  // Nested plans (e.g. under account/subscription objects).
  for (const value of Object.values(payload)) {
    if (!isObject(value)) continue;
    const found = findPlanName(value);
    if (found !== undefined) return found;
  }
  return undefined;
};

/**
 * Pure decode of the billing/quota/usage response — exported for unit tests.
 * Returns undefined when no usable quota windows exist (caller degrades
 * honestly instead of painting an invented bar).
 */
export const parseDevinQuotaUsage = (
  payload: unknown,
  fetchedAt: string,
  context: { readonly organization?: string },
): ProviderQuota | undefined => {
  if (!isObject(payload)) return undefined;

  const currentDaily = windowFromCurrentShape(payload.daily_percentage, payload.daily_reset_at) ??
    nestedDaily(payload);
  const currentWeekly = windowFromCurrentShape(payload.weekly_percentage, payload.weekly_reset_at) ??
    nestedWeekly(payload);

  const primary: UsageWindow | undefined = currentDaily === undefined
    ? undefined
    : {
        label: "primary",
        title: "Daily",
        usedPercent: currentDaily.usedPercent,
        windowMinutes: 24 * 60,
        ...(currentDaily.resetsAt !== undefined
          ? { resetsAt: currentDaily.resetsAt, resetDescription: "resets at daily boundary" }
          : {}),
      };
  const secondary: UsageWindow | undefined = currentWeekly === undefined
    ? undefined
    : {
        label: "secondary",
        title: "Weekly",
        usedPercent: currentWeekly.usedPercent,
        windowMinutes: 7 * 24 * 60,
        ...(currentWeekly.resetsAt !== undefined
          ? { resetsAt: currentWeekly.resetsAt, resetDescription: "resets at weekly boundary" }
          : {}),
      };

  const windows = [...(primary !== undefined ? [primary] : []), ...(secondary !== undefined ? [secondary] : [])];
  if (windows.length === 0) return undefined;

  const creditsRemaining = parseOverageBalance(payload);
  const plan = findPlanName(payload);
  const account = context.organization;

  return {
    provider: "devin",
    source: "web",
    status: "ok",
    windows,
    updatedAt: fetchedAt,
    ...(account !== undefined ? { account } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(creditsRemaining !== undefined ? { creditsRemaining } : {}),
    extras: {
      capability: "acu-quota",
      overageBalanceUsd: creditsRemaining,
      hasOverageBalance: creditsRemaining !== undefined,
    },
  };
};

export type DevinOutcome =
  | { readonly kind: "ok"; readonly quotas: ReadonlyArray<ProviderQuota> }
  | {
      readonly kind: "unavailable";
      readonly reason: "cli-error" | "parse-error" | "source-missing";
      readonly error: string;
    };

/** Envelope builder: every unavailable mode carries a machine-readable reason. */
export const buildDevinSnapshot = (fetchedAt: string, outcome: DevinOutcome): UsageSnapshot =>
  outcome.kind === "ok"
    ? { source: "devin", fetchedAt, ok: true, dataConfidence: "live", quotas: outcome.quotas }
    : { source: "devin", fetchedAt, ok: false, reason: outcome.reason, error: outcome.error, quotas: [] };

/**
 * Defense in depth: scrub any credential material that could have leaked
 * into an error string. Tokens never belong in envelopes.
 */
export const redactToken = (message: string, credential?: DevinCredential): string => {
  let redacted = message;
  if (credential !== undefined && credential.bearerToken.length >= 8) {
    redacted = redacted.split(credential.bearerToken).join("[redacted]");
  }
  return redacted;
};

export interface DevinFetchOutcome {
  readonly ok: boolean;
  readonly status: number;
  /** Decoded JSON body when the response was 200 and valid JSON. */
  readonly payload?: unknown;
  /** Short failure description; never carries header material. */
  readonly error?: string;
}

/** Minimal injectable fetch surface - the DOM `typeof fetch` carries extra members. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const fetchOnce = async (
  path: string,
  credential: DevinCredential,
  fetchImpl: FetchLike,
): Promise<DevinFetchOutcome> => {
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credential.bearerToken}`,
      Accept: "application/json",
      "User-Agent": "Vellum Command",
    };
    if (credential.internalOrganizationId !== undefined) {
      headers["x-cog-org-id"] = credential.internalOrganizationId;
    }
    const response = await fetchImpl(new URL(path, BASE_URL).toString(), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: response.status,
        error: `app.devin.ai rejected credentials (${response.status}) - sign in to app.devin.ai to refresh the session`,
      };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, error: `billing/quota/usage failed with HTTP ${response.status}` };
    }
    const payload: unknown = await response.json();
    return { ok: true, status: response.status, payload };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export const fetchDevinWith = async (
  fetchImpl: FetchLike,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UsageSnapshot> => {
  const fetchedAt = new Date().toISOString();
  try {
    const auth = resolveDevinCredential(env);
    if (auth.kind !== "ok") {
      return buildDevinSnapshot(fetchedAt, {
        kind: "unavailable",
        reason: "source-missing",
        error:
          "no Devin session found - sign in to app.devin.ai in Chrome, or set DEVIN_BEARER_TOKEN to enable live Devin usage",
      });
    }

    const credential = auth.credential;
    const organization = credential.organization ?? (credential.internalOrganizationId !== undefined
      ? `organizations/${credential.internalOrganizationId}`
      : undefined);
    if (organization === undefined) {
      return buildDevinSnapshot(fetchedAt, {
        kind: "unavailable",
        reason: "source-missing",
        error:
          "no Devin organization resolved - open an app.devin.ai usage page once, or set DEVIN_ORGANIZATION",
      });
    }

    let lastError = "no Devin quota endpoint succeeded";
    for (const path of candidatePaths(organization, credential.internalOrganizationId)) {
      const outcome = await fetchOnce(path, credential, fetchImpl);
      if (outcome.ok && outcome.payload !== undefined) {
        const quota = parseDevinQuotaUsage(outcome.payload, fetchedAt, {
          organization: credential.organization,
        });
        if (quota !== undefined) return buildDevinSnapshot(fetchedAt, { kind: "ok", quotas: [quota] });
        return buildDevinSnapshot(fetchedAt, {
          kind: "unavailable",
          reason: "parse-error",
          error: "billing/quota/usage returned no usable quota windows",
        });
      }
      // Invalid credentials fail the whole pipeline (CodexBar parity):
      // trying more paths with the same dead session is pointless.
      if (outcome.status === 401 || outcome.status === 403) {
        return buildDevinSnapshot(fetchedAt, {
          kind: "unavailable",
          reason: "cli-error",
          error: redactToken(outcome.error ?? "credentials rejected", credential),
        });
      }
      if (outcome.error !== undefined) lastError = redactToken(outcome.error, credential);
    }
    return buildDevinSnapshot(fetchedAt, { kind: "unavailable", reason: "cli-error", error: lastError });
  } catch (error) {
    return buildDevinSnapshot(fetchedAt, {
      kind: "unavailable",
      reason: "cli-error",
      error: redactToken(error instanceof Error ? error.message : String(error)),
    });
  }
};

const fetchDevin = async (): Promise<UsageSnapshot> => fetchDevinWith(globalThis.fetch);

/** Capability note for doctor / HUD labeling - the fetch path is live. */
export const DEVIN_LIMITS_STATUS =
  "live - app.devin.ai/api/<org>/billing/quota/usage via browser session or DEVIN_BEARER_TOKEN (read-only)";

export const devinSource: UsageSource = {
  id: "devin",
  detect: Effect.promise(detectDevinCredential),
  fetch: Effect.promise(fetchDevin),
};
