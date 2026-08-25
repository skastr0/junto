import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { ProviderQuota, UsageSnapshot, UsageUnavailableReason, UsageWindow } from "@shared/usage";
import type { UsageSource } from "./usage-source";

// Native Kimi Code (Moonshot AI) usage source, protocol per CodexBar:
//   - Web session path: POST https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages
//     with {"scope":["FEATURE_CODING"]} and a bearer web auth token, enriched by POST
//     .../kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats.
//   - Kimi Code API path: GET <base>/coding/v1/usages (default https://api.kimi.com) with an API key
//     or the CLI OAuth access token from ~/.kimi-code/credentials/kimi-code.json (read-only,
//     never refreshed in-process).
// Tokens live in memory only - never logged, persisted, or included in error copy.

const WEB_USAGE_URL =
  "https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages";
const SUBSCRIPTION_STATS_URL =
  "https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats";
const DEFAULT_CODE_API_BASE = "https://api.kimi.com";
const FETCH_TIMEOUT_MS = 10_000;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

// ---------------------------------------------------------------------------
// Credential resolution (local only, no network)
// ---------------------------------------------------------------------------

export interface KimiCredential {
  readonly token: string;
  // Which strategy resolved it: web session token, Code API key, CLI oauth file.
  readonly kind: "web-token" | "api-key" | "cli-oauth";
  readonly codeApiBase?: string;
  /** Identity headers CodexBar mirrors for the CLI credential path. */
  readonly identityHeaders?: Record<string, string>;
}

const cleanToken = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/** Web session token from the environment (KIMI_AUTH_TOKEN / kimi_auth_token). */
export const resolveKimiWebToken = (
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => cleanToken(env.KIMI_AUTH_TOKEN ?? env.kimi_auth_token);

/** Kimi Code API key from the environment (KIMI_CODE_API_KEY). */
export const resolveKimiApiKey = (
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => cleanToken(env.KIMI_CODE_API_KEY);

export const kimiCodeHome = (env: NodeJS.ProcessEnv = process.env): string =>
  env.KIMI_CODE_HOME !== undefined && env.KIMI_CODE_HOME.trim() !== ""
    ? env.KIMI_CODE_HOME.trim()
    : join(homedir(), ".kimi-code");

/**
 * Pure decode of ~/.kimi-code/credentials/kimi-code.json:
 * `{ access_token, refresh_token, expires_at }`. Exported for unit tests.
 */
export const extractKimiCodeAccessToken = (payload: unknown): string | undefined => {
  if (!isObject(payload)) return undefined;
  return cleanToken(asString(payload.access_token));
};

interface KimiCodeCredentialFile {
  readonly accessToken: string;
  readonly expiresAt?: number;
}

const readKimiCodeCredentialFile = (): KimiCodeCredentialFile | undefined => {
  const path = join(kimiCodeHome(), "credentials", "kimi-code.json");
  try {
    if (!existsSync(path)) return undefined;
    const payload: unknown = JSON.parse(readFileSync(path, "utf8"));
    const accessToken = extractKimiCodeAccessToken(payload);
    if (accessToken === undefined) return undefined;
    const expiresAt = asNumber(isObject(payload) ? payload.expires_at : undefined);
    return { accessToken, ...(expiresAt !== undefined ? { expiresAt } : {}) };
  } catch {
    return undefined;
  }
};

/** True when the stored CLI credential is fresh (expires > now + 60s). */
export const kimiCodeCredentialFresh = (
  credential: { readonly expiresAt?: number } | undefined,
  nowMs: number,
): boolean => {
  if (credential === undefined) return false;
  if (credential.expiresAt === undefined || !Number.isFinite(credential.expiresAt)) return true;
  return credential.expiresAt * 1000 > nowMs + 60_000;
};

/**
 * Ordered resolution mirroring CodexBar's auto pipeline:
 *   web session token -> Code API key -> fresh CLI OAuth credential.
 * Endpoint overrides (KIMI_CODE_BASE_URL / KIMI_CODE_OAUTH_HOST) disable the
 * CLI-oauth tier, matching CodexBar's hasCodeEndpointOverride gate.
 */
export const resolveKimiCredential = (
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): KimiCredential | undefined => {
  const webToken = resolveKimiWebToken(env);
  if (webToken !== undefined) return { token: webToken, kind: "web-token" };

  const codeApiBase =
    env.KIMI_CODE_BASE_URL !== undefined && env.KIMI_CODE_BASE_URL.trim() !== ""
      ? env.KIMI_CODE_BASE_URL.trim()
      : DEFAULT_CODE_API_BASE;
  const endpointOverride =
    codeApiBase !== DEFAULT_CODE_API_BASE ||
    (env.KIMI_CODE_OAUTH_HOST ?? env.KIMI_OAUTH_HOST ?? "").trim() !== "";

  const apiKey = resolveKimiApiKey(env);
  if (apiKey !== undefined) {
    return {
      token: apiKey,
      kind: "api-key",
      codeApiBase,
      identityHeaders: cliIdentityHeaders(),
    };
  }

  if (endpointOverride) return undefined;
  const file = readKimiCodeCredentialFile();
  if (file !== undefined && kimiCodeCredentialFresh(file, nowMs)) {
    return {
      token: file.accessToken,
      kind: "cli-oauth",
      codeApiBase,
      identityHeaders: cliIdentityHeaders(),
    };
  }
  return undefined;
};

const cliIdentityHeaders = (): Record<string, string> => ({
  "X-Msh-Platform": "kimi_code_cli",
});

/** Cheap local presence probe - no network. */
export const detectKimiPresence = async (): Promise<boolean> => {
  if (resolveKimiWebToken() !== undefined || resolveKimiApiKey() !== undefined) return true;
  return readKimiCodeCredentialFile() !== undefined;
};

// ---------------------------------------------------------------------------
// Wire decode
// ---------------------------------------------------------------------------

export interface KimiUsageDetail {
  readonly limit: number;
  readonly used?: number;
  readonly remaining?: number;
  readonly resetTime?: string;
}

/** Kimi sends counters as strings or numbers; tolerate both. */
export const detailValue = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

/** Decode one usage detail block; limit is required (KimiUsageDetail.limit). */
export const decodeUsageDetail = (value: unknown): KimiUsageDetail | undefined => {
  if (!isObject(value)) return undefined;
  const limit = detailValue(value.limit);
  if (limit === undefined || limit <= 0) return undefined;
  const used = detailValue(value.used);
  const remaining = detailValue(value.remaining);
  const resetTime =
    asString(value.resetTime) ?? asString(value.reset_at) ??
    asString(value.reset_time) ?? asString(value.resetTimeSnake);
  return {
    limit,
    ...(used !== undefined ? { used } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(resetTime !== undefined ? { resetTime } : {}),
  };
};

export interface DetailCounts {
  readonly usedPercent: number;
  // False when remaining-derived and invalid counters withhold pacing info.
  readonly reliable: boolean;
  readonly used: number;
}

/**
 * Mirror of CodexBar usageCounts: used is authoritative even over limit
 * (overage); remaining must describe a valid balance; otherwise 0 percent
 * with reliable=false so no pace/window duration is invented.
 */
export const countsOfDetail = (detail: KimiUsageDetail): DetailCounts => {
  if (detail.used !== undefined && detail.used >= 0) {
    return {
      usedPercent: clampPercent((detail.used / detail.limit) * 100),
      reliable: true,
      used: detail.used,
    };
  }
  if (detail.remaining !== undefined && detail.remaining >= 0 && detail.remaining <= detail.limit) {
    return {
      usedPercent: clampPercent(((detail.limit - detail.remaining) / detail.limit) * 100),
      reliable: true,
      used: detail.limit - detail.remaining,
    };
  }
  return { usedPercent: 0, reliable: false, used: 0 };
};

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

/** KimiWindow.duration + timeUnit enum to minutes. */
export const windowDurationMinutes = (value: unknown): number | undefined => {
  if (!isObject(value)) return undefined;
  const duration = asNumber(value.duration);
  const timeUnit = asString(value.timeUnit);
  if (duration === undefined || duration <= 0) return undefined;
  const multiplier =
    timeUnit === "TIME_UNIT_MINUTE" ? 1 :
    timeUnit === "TIME_UNIT_HOUR" ? 60 :
    timeUnit === "TIME_UNIT_DAY" ? 24 * 60 :
    undefined;
  if (multiplier === undefined) return undefined;
  const minutes = duration * multiplier;
  return Number.isSafeInteger(minutes) ? minutes : undefined;
};

const isoOrNull = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};

const weeklyDetailWindow = (detail: KimiUsageDetail): UsageWindow => {
  const counts = countsOfDetail(detail);
  return {
    label: "primary",
    title: "7d coding",
    usedPercent: counts.usedPercent,
    // Weekly cadence only when the counters are trustworthy enough to pace.
    ...(counts.reliable ? { windowMinutes: 7 * 24 * 60 } : {}),
    ...(isoOrNull(detail.resetTime) !== undefined
      ? { resetsAt: isoOrNull(detail.resetTime), resetDescription: `${counts.used}/${detail.limit} requests` }
      : {}),
  };
};

const rateLimitWindow = (
  entry: { readonly detail: KimiUsageDetail; readonly windowMinutes?: number },
): UsageWindow => {
  const counts = countsOfDetail(entry.detail);
  const windowMinutes = counts.reliable ? entry.windowMinutes : undefined;
  let description: string | undefined;
  if (counts.reliable) {
    description =
      windowMinutes !== undefined && windowMinutes % 60 === 0 && windowMinutes > 0
        ? `Rate: ${counts.used}/${entry.detail.limit} per ${windowMinutes / 60} hour(s)`
        : `Rate: ${counts.used}/${entry.detail.limit} per ${windowMinutes} minute(s)`;
  }
  return {
    label: "secondary",
    title: "rate limit",
    usedPercent: counts.usedPercent,
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(isoOrNull(entry.detail.resetTime) !== undefined
      ? { resetsAt: isoOrNull(entry.detail.resetTime) }
      : {}),
    ...(description !== undefined ? { resetDescription: description } : {}),
  };
};

/** Parse limits[] entries; malformed siblings never drop good ones. */
export const parseRateLimits = (payload: JsonObject):
  Array<{ readonly detail: KimiUsageDetail; readonly windowMinutes?: number }> => {
  const raw = Array.isArray(payload.limits) ? payload.limits : [];
  const out: Array<{ detail: KimiUsageDetail; windowMinutes?: number }> = [];
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    const detail = decodeUsageDetail(entry.detail);
    if (detail === undefined) continue;
    out.push({ detail, windowMinutes: windowDurationMinutes(entry.window) });
  }
  return out;
};

/**
 * Pure decode of the Kimi Code API response `{ usage, limits }` - exported
 * for unit tests. Returns undefined without a usable weekly detail.
 */
export const parseCodeApiUsage = (
  payload: unknown,
  fetchedAt: string,
): ProviderQuota | undefined => {
  if (!isObject(payload)) return undefined;
  const weekly = decodeUsageDetail(payload.usage);
  if (weekly === undefined) return undefined;

  const windows: UsageWindow[] = [];
  const primary = weeklyDetailWindow(weekly);
  if (primary !== undefined) windows.push(primary);

  const [firstLimit] = parseRateLimits(payload);
  // Session lane fallback: 5h, matching CodexBar sessionWindowMinutes.
  if (firstLimit !== undefined) {
    windows.push(rateLimitWindow({ ...firstLimit, windowMinutes: firstLimit.windowMinutes ?? 300 }));
  }

  return {
    provider: "kimi",
    source: "code-api",
    status: "ok",
    windows,
    updatedAt: fetchedAt,
  };
};

/** Extra windows from GetSubscriptionStats: shared pool monthly + distinct Code 7-day ratio. */
export const parseSubscriptionStats = (payload: unknown): UsageWindow[] => {
  if (!isObject(payload)) return [];
  const windows: UsageWindow[] = [];

  const balance = isObject(payload.subscriptionBalance) ? payload.subscriptionBalance : undefined;
  if (
    balance !== undefined &&
    (balance.feature === undefined || balance.feature === "FEATURE_OMNI") &&
    (balance.type === undefined || balance.type === "SUBSCRIPTION")
  ) {
    const ratio = asNumber(balance.amountUsedRatio);
    if (ratio !== undefined) {
      windows.push({
        label: "extra",
        id: "kimi-monthly",
        title: "Total usage",
        usedPercent: clampPercent(ratio * 100),
        // Monthly sentinel cadence for pace math.
        windowMinutes: 30 * 24 * 60,
        ...(isoOrNull(asString(balance.expireTime)) !== undefined
          ? { resetsAt: isoOrNull(asString(balance.expireTime)) }
          : {}),
      });
    }
  }

  const codeWeekly = isObject(payload.ratelimitCode7d) ? payload.ratelimitCode7d : undefined;
  if (codeWeekly !== undefined && codeWeekly.enabled !== false) {
    const ratio = asNumber(codeWeekly.ratio);
    if (ratio !== undefined) {
      windows.push({
        label: "extra",
        id: "kimi-code-7d",
        title: "Code 7-day",
        usedPercent: clampPercent(ratio * 100),
        windowMinutes: 7 * 24 * 60,
        ...(isoOrNull(asString(codeWeekly.resetTime)) !== undefined
          ? { resetsAt: isoOrNull(asString(codeWeekly.resetTime)) }
          : {}),
      });
    }
  }
  return windows;
};

/**
 * Suppress the membership Code 7-day extra when it duplicates the weekly
 * primary lane (same percent within 1 point, resets within 5 minutes).
 */
export const suppressDuplicateCodeWeekly = (
  extras: ReadonlyArray<UsageWindow>,
  primary: UsageWindow | undefined,
): UsageWindow[] => {
  const duplicate =
    primary !== undefined &&
    primary.windowMinutes !== undefined &&
    extras.some(
      (extra) =>
        extra.id === "kimi-code-7d" &&
        Math.abs(extra.usedPercent - primary.usedPercent) <= 1 &&
        extra.resetsAt !== undefined &&
        primary.resetsAt !== undefined &&
        Math.abs(Date.parse(extra.resetsAt) - Date.parse(primary.resetsAt)) <= 5 * 60_000,
    );
  return duplicate ? extras.filter((extra) => extra.id !== "kimi-code-7d") : [...extras];
};

/** Pure decode of the web GetUsages response `{ usages: [{scope, detail, limits}] }`. */
export const parseWebUsage = (
  payload: unknown,
  fetchedAt: string,
): ProviderQuota | undefined => {
  if (!isObject(payload)) return undefined;
  const usages = Array.isArray(payload.usages) ? payload.usages : [];
  const coding = usages.find(
    (entry): entry is JsonObject => isObject(entry) && entry.scope === "FEATURE_CODING",
  );
  if (coding === undefined) return undefined;

  const weekly = decodeUsageDetail(coding.detail);
  if (weekly === undefined) return undefined;

  const windows: UsageWindow[] = [];
  const primary = weeklyDetailWindow(weekly);
  if (primary !== undefined) windows.push(primary);

  const rateLimits = parseRateLimits(coding);
  if (rateLimits.length > 0) {
    windows.push(rateLimitWindow({ ...rateLimits[0], windowMinutes: rateLimits[0].windowMinutes ?? 300 }));
  }

  return {
    provider: "kimi",
    source: "web",
    status: "ok",
    windows,
    updatedAt: fetchedAt,
  };
};

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export type KimiOutcome =
  | { readonly kind: "ok"; readonly quota: ProviderQuota; readonly dataConfidence?: "live" }
  | {
      readonly kind: "unavailable";
      readonly reason: UsageUnavailableReason;
      readonly error: string;
    };

export const buildKimiSnapshot = (fetchedAt: string, outcome: KimiOutcome): UsageSnapshot =>
  outcome.kind === "ok"
    ? {
        source: "kimi",
        fetchedAt,
        ok: true,
        quotas: [outcome.quota],
        dataConfidence: outcome.dataConfidence ?? "live",
      }
    : {
        source: "kimi",
        fetchedAt,
        ok: false,
        reason: outcome.reason,
        error: outcome.error,
        quotas: [],
      };

// ---------------------------------------------------------------------------
// Fetch pipeline
// ---------------------------------------------------------------------------

const baseHeaders = (token: string, kind: KimiCredential["kind"]): Record<string, string> => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": "Vellum Command",
  };
  if (kind === "web-token") {
    // Connect-protocol conventions per CodexBar webRequest().
    headers["Content-Type"] = "application/json";
    headers["Cookie"] = `kimi-auth=${token}`;
    headers["Origin"] = "https://www.kimi.com";
    headers["Referer"] = "https://www.kimi.com/code/console";
    headers["connect-protocol-version"] = "1";
    headers["x-msh-platform"] = "web";
  }
  return headers;
};

const withIdentityHeaders = (
  headers: Record<string, string>,
  credential: KimiCredential,
): Record<string, string> => ({
  ...headers,
  ...(credential.identityHeaders ?? {}),
});

const postJson = async (
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; ok: boolean; payload?: unknown }> => {
  const response = await globalThis.fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return { status: response.status, ok: false };
  try {
    return { status: response.status, ok: true, payload: await response.json() };
  } catch {
    return { status: response.status, ok: false };
  }
};

const fetchCodeApiUsage = async (
  credential: KimiCredential,
): Promise<{ quota: ProviderQuota; extras: UsageWindow[] } | { failure: string }> => {
  const base = credential.codeApiBase ?? DEFAULT_CODE_API_BASE;
  // CodexBar endpoint rule: <base>/coding/v1/<usages>, tolerating bases that
  // already carry the coding path suffix.
  const suffix = /\/coding\/v1\/?$/.test(base)
    ? "usages"
    : /\/coding\/?$/.test(base)
      ? "v1/usages"
      : "coding/v1/usages";
  const url = `${base.replace(/\/+$/, "")}/${suffix}`;
  try {
    const response = await globalThis.fetch(url, {
      method: "GET",
      headers: withIdentityHeaders(
        baseHeaders(credential.token, credential.kind),
        credential,
      ),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return { failure: `Kimi Code API rejected credentials (${response.status})` };
    }
    if (!response.ok) {
      return { failure: `Kimi Code API usages request failed with HTTP ${response.status}` };
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { failure: "Kimi Code API returned a non-JSON usages payload" };
    }
    const quota = parseCodeApiUsage(payload, new Date().toISOString());
    if (quota === undefined) {
      return { failure: "Kimi Code API returned no usable FEATURE_CODING usage" };
    }
    return { quota, extras: [] };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
};

const fetchWebUsage = async (
  token: string,
): Promise<{ quota: ProviderQuota; extras: UsageWindow[] } | { failure: string }> => {
  const headers = baseHeaders(token, "web-token");
  try {
    const usage = await postJson(WEB_USAGE_URL, { scope: ["FEATURE_CODING"] }, headers);
    if (usage.status === 401 || usage.status === 403) {
      return { failure: "Kimi web session rejected credentials - re-authenticate at www.kimi.com/code/console" };
    }
    if (!usage.ok) {
      return { failure: `Kimi web usage request failed with HTTP ${usage.status}` };
    }
    const quota = parseWebUsage(usage.payload, new Date().toISOString());
    if (quota === undefined) {
      return { failure: "Kimi web usage returned no usable FEATURE_CODING scope" };
    }
    // Subscription stats are enrichment: failure never sinks the primary lanes.
    const stats = await postJson(SUBSCRIPTION_STATS_URL, {}, headers).catch(() => undefined);
    const extras =
      stats?.ok === true ? suppressDuplicateCodeWeekly(parseSubscriptionStats(stats.payload), quota.windows[0]) : [];
    return { quota, extras };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
};

const fetchKimi = async (): Promise<UsageSnapshot> => {
  const fetchedAt = new Date().toISOString();
  try {
    const credential = resolveKimiCredential();
    if (credential === undefined) {
      return buildKimiSnapshot(fetchedAt, {
        kind: "unavailable",
        reason: "source-missing",
        error:
          "no Kimi credentials found - set KIMI_AUTH_TOKEN or KIMI_CODE_API_KEY, or run the kimi CLI login (~/.kimi-code/credentials/kimi-code.json)",
      });
    }

    const result =
      credential.kind === "web-token"
        ? await fetchWebUsage(credential.token)
        : await fetchCodeApiUsage(credential);

    if ("failure" in result) {
      return buildKimiSnapshot(fetchedAt, {
        kind: "unavailable",
        reason: "cli-error",
        // Status codes only - header material never reaches error copy.
        error: result.failure,
      });
    }

    // Extra lanes ride the same quota row with label:"extra" + stable ids.
    const quota: ProviderQuota = { ...result.quota, windows: [...result.quota.windows, ...result.extras] };
    return buildKimiSnapshot(fetchedAt, { kind: "ok", quota, dataConfidence: "live" });
  } catch (error) {
    return buildKimiSnapshot(fetchedAt, {
      kind: "unavailable",
      reason: "cli-error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

/** Capability note for doctor / HUD partial labeling. */
export const KIMI_LIMITS_STATUS =
  "live - kimi.com billing/membership endpoints via KIMI_AUTH_TOKEN, or api.kimi.com coding usages via KIMI_CODE_API_KEY / ~/.kimi-code credentials";

export const kimiSource: UsageSource = {
  id: "kimi",
  detect: Effect.promise(detectKimiPresence),
  fetch: Effect.promise(fetchKimi),
};
