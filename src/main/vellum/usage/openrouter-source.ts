import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { ProviderQuota, UsageSnapshot, UsageUnavailableReason, UsageWindow } from "@shared/usage";
import type { UsageSource } from "./usage-source";

// Native OpenRouter usage source — API-key REST read, first class.
//
// Endpoints:
//   GET {base}/credits  — total_credits / total_usage; balance = max(0, credits - usage).
//   GET {base}/auth/key — key label, limit, usage, limit_remaining, limit_reset,
//                         rate_limit, usage_daily/weekly/monthly. Falls back to
//                         {base}/key when the auth-prefixed route 404s.
//   GET https://openrouter.ai/api/v1/activity?date=YYYY-MM-DD — optional per-model
//                         spend history (last 30 completed UTC days). Requires a
//                         MANAGEMENT key (403 with the ordinary API key) and must
//                         never follow a user-configured base URL override.
//
// Credential discovery: OPENROUTER_API_KEY environment variable first (the only
// portable source), then two best-effort conventional key files. Keychain-backed
// settings are not a portable file contract, so they are not probed here.
//
// Costs from these endpoints are real metered vendor numbers — extras carry
// provenance "vendorMetered" and are never blended with estimates silently.

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const FETCH_TIMEOUT_MS = 10_000;
/** Activity enrichment deadline — degrade, never fail the snapshot over it. */
const ACTIVITY_TIMEOUT_MS = 5_000;
const ACTIVITY_HISTORY_DAYS = 30;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export interface OpenRouterCredentials {
  readonly apiKey: string;
  readonly managementApiKey?: string;
  readonly baseUrl: string;
}

/**
 * Trim whitespace and strip one layer of matching quotes — mirrors
 * OpenRouterSettingsReader.cleaned so pasted "sk-or-…" values resolve.
 */
export const cleanCredentialValue = (raw: string | undefined): string | undefined => {
  if (typeof raw !== "string") return undefined;
  let value = raw.trim();
  if (value.length === 0) return undefined;
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1).trim();
  }
  return value.length > 0 ? value : undefined;
};

const KEY_FILE_CANDIDATES = (): string[] => [
  join(homedir(), ".openrouter", "apikey"),
  join(homedir(), ".config", "openrouter", "apikey"),
];

const readKeyFile = (path: string): string | undefined => {
  try {
    if (!existsSync(path)) return undefined;
    return cleanCredentialValue(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * Pure-ish credential resolution — env first, then conventional key files.
 * The file reader is injectable for unit tests. Never logs secret values.
 */
export const resolveOpenRouterCredentials = (
  env: Record<string, string | undefined> = process.env,
  readFile: (path: string) => string | undefined = readKeyFile,
): OpenRouterCredentials | undefined => {
  const fileKey = KEY_FILE_CANDIDATES()
    .map(readFile)
    .map((raw) => cleanCredentialValue(raw))
    .find((key) => key !== undefined);
  const apiKey = cleanCredentialValue(env.OPENROUTER_API_KEY) ?? fileKey;
  if (apiKey === undefined) return undefined;
  // Endpoint override must be HTTPS or a bare-host HTTPS URL.
  let baseUrl = DEFAULT_BASE_URL;
  const override = cleanCredentialValue(env.OPENROUTER_API_URL);
  if (override !== undefined) {
    try {
      const url = new URL(override.startsWith("http") ? override : `https://${override}`);
      if (url.protocol === "https:") baseUrl = url.toString().replace(/\/+$/, "");
    } catch {
      // Ignore invalid overrides; production endpoint stays.
    }
  }
  const managementApiKey = cleanCredentialValue(env.OPENROUTER_MANAGEMENT_API_KEY);
  return {
    apiKey,
    ...(managementApiKey !== undefined ? { managementApiKey } : {}),
    baseUrl,
  };
};

/** Redact any accidental credential echo out of error strings. */
export const redactSecret = (text: string, secrets: ReadonlyArray<string>): string => {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0 && out.includes(secret)) out = "[redacted]";
  }
  return out;
};

export type OpenRouterEndpointOutcome =
  | { readonly kind: "ok"; readonly payload: unknown }
  | { readonly kind: "unauthorized"; readonly status: number }
  | { readonly kind: "http-error"; readonly status: number }
  | { readonly kind: "failed"; readonly error: string };

const fetchOpenRouterJson = async (
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<OpenRouterEndpointOutcome> => {
  try {
    const response = await globalThis.fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) {
      return { kind: "unauthorized", status: response.status };
    }
    if (!response.ok) return { kind: "http-error", status: response.status };
    return { kind: "ok", payload: await response.json() };
  } catch (error) {
    return {
      kind: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export interface OpenRouterCreditsData {
  readonly totalCredits: number;
  readonly totalUsage: number;
  readonly balance: number;
}

/** Decode { data: { total_credits, total_usage } } — both required finite. */
export const parseCreditsPayload = (payload: unknown): OpenRouterCreditsData | undefined => {
  if (!isObject(payload)) return undefined;
  const data = payload.data;
  if (!isObject(data)) return undefined;
  const totalCredits = asNumber(data.total_credits);
  const totalUsage = asNumber(data.total_usage);
  if (totalCredits === undefined || totalUsage === undefined) return undefined;
  return {
    totalCredits,
    totalUsage,
    balance: Math.max(0, totalCredits - totalUsage),
  };
};

export interface OpenRouterKeyInfo {
  readonly label?: string;
  readonly limit?: number;
  readonly usage?: number;
  readonly limitRemaining?: number;
  readonly limitReset?: string;
  readonly usageDaily?: number;
  readonly usageWeekly?: number;
  readonly usageMonthly?: number;
  readonly rateLimit?: { readonly requests: number; readonly interval: string };
}

/** Decode { data: { ...key info } } — every field optional but type-checked. */
export const parseKeyPayload = (payload: unknown): OpenRouterKeyInfo | undefined => {
  if (!isObject(payload)) return undefined;
  const data = payload.data;
  if (!isObject(data)) return undefined;
  const rateLimitRaw = isObject(data.rate_limit) ? data.rate_limit : undefined;
  const requests = rateLimitRaw !== undefined ? asNumber(rateLimitRaw.requests) : undefined;
  const interval = rateLimitRaw !== undefined ? asString(rateLimitRaw.interval) : undefined;
  return {
    ...(asString(data.label) !== undefined ? { label: asString(data.label) } : {}),
    ...(asNumber(data.limit) !== undefined ? { limit: asNumber(data.limit) } : {}),
    ...(asNumber(data.usage) !== undefined ? { usage: asNumber(data.usage) } : {}),
    ...(asNumber(data.limit_remaining) !== undefined
      ? { limitRemaining: asNumber(data.limit_remaining) }
      : {}),
    ...(asString(data.limit_reset) !== undefined ? { limitReset: asString(data.limit_reset) } : {}),
    ...(asNumber(data.usage_daily) !== undefined ? { usageDaily: asNumber(data.usage_daily) } : {}),
    ...(asNumber(data.usage_weekly) !== undefined
      ? { usageWeekly: asNumber(data.usage_weekly) }
      : {}),
    ...(asNumber(data.usage_monthly) !== undefined
      ? { usageMonthly: asNumber(data.usage_monthly) }
      : {}),
    ...(requests !== undefined && interval !== undefined
      ? { rateLimit: { requests: Math.trunc(requests), interval } }
      : {}),
  };
};

export interface OpenRouterActivityRow {
  readonly date: string;
  readonly model?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly requests: number;
  /** Metered spend in USD — vendor truth, never an estimate. */
  readonly costUsd: number;
}

/**
 * Decode one activity response ({ data: [...] }) into dated rows. Rows outside
 * the 30-day cutoff are dropped; malformed rows reject the whole payload so we
 * never half-trust spend numbers.
 */
export const parseActivityPayload = (
  payload: unknown,
  opts: { readonly latestCompleted: string; readonly cutoff: string },
): OpenRouterActivityRow[] => {
  if (!isObject(payload)) throw new TypeError("activity response must be an object");
  if (!Array.isArray(payload.data)) throw new TypeError("activity.data must be an array");
  const rows: OpenRouterActivityRow[] = [];
  for (const [index, raw] of payload.data.entries()) {
    if (!isObject(raw)) throw new TypeError(`activity.data[${index}] must be an object`);
    const date = asString(raw.date)?.trim().slice(0, 10);
    if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new TypeError(`activity.data[${index}].date must be a YYYY-MM-DD day`);
    }
    if (date > opts.latestCompleted) continue;
    if (date < opts.cutoff) continue;
    const modelSlug = asString(raw.model_permaslug) ?? asString(raw.model);
    const promptTokens = asNumber(raw.prompt_tokens);
    const completionTokens = asNumber(raw.completion_tokens);
    const requests = asNumber(raw.requests);
    const meteredCost = asNumber(raw.usage);
    if (
      promptTokens === undefined ||
      completionTokens === undefined ||
      requests === undefined ||
      meteredCost === undefined
    ) {
      throw new TypeError(`activity.data[${index}] has missing numeric fields`);
    }
    rows.push({
      date,
      ...(modelSlug !== undefined && modelSlug.trim().length > 0
        ? { model: modelSlug.trim().slice(0, 64) }
        : {}),
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      requests,
      costUsd: meteredCost + (asNumber(raw.byok_usage_inference) ?? 0),
    });
  }
  return rows;
};

export interface OpenRouterSpendHistory {
  readonly windowEnd: string;
  readonly totalUsd: number;
  readonly byModel: ReadonlyArray<{ readonly model: string; readonly costUsd: number }>;
}

/** Aggregate activity rows into a per-model spend breakdown (pure). */
export const buildSpendHistory = (rows: ReadonlyArray<OpenRouterActivityRow>): OpenRouterSpendHistory => {
  const byModel = new Map<string, number>();
  let totalUsd = 0;
  let windowEnd = "";
  for (const row of rows) {
    totalUsd += row.costUsd;
    if (row.date > windowEnd) windowEnd = row.date;
    if (row.model === undefined) continue;
    byModel.set(row.model, (byModel.get(row.model) ?? 0) + row.costUsd);
  }
  return {
    windowEnd,
    totalUsd,
    byModel: [...byModel.entries()]
      .map(([model, costUsd]) => ({ model, costUsd }))
      .sort((a, b) => b.costUsd - a.costUsd),
  };
};

const activityWindowBounds = (now: Date): { latestCompleted: string; cutoff: string } => {
  const latestCompletedDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const latestCompleted = latestCompletedDate.toISOString().slice(0, 10);
  const cutoff = new Date(latestCompletedDate.getTime() - (ACTIVITY_HISTORY_DAYS - 1) * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return { latestCompleted, cutoff };
};

const usd = (value: number): string => `$${Math.max(0, value).toFixed(2)}`;

export interface OpenRouterParts {
  readonly credits?: OpenRouterCreditsData;
  readonly key?: OpenRouterKeyInfo;
  readonly spendHistory?: OpenRouterSpendHistory;
  readonly keyDegradedReason?: string;
  readonly spendHistoryNote?: string;
}

/**
 * Pure quota builder from decoded parts. Returns undefined only when neither
 * the credits nor the key endpoint produced usable data.
 */
export const buildOpenRouterQuota = (parts: OpenRouterParts, fetchedAt: string): ProviderQuota | undefined => {
  const { credits, key } = parts;
  if (credits === undefined && key === undefined) return undefined;

  const windows: UsageWindow[] = [];
  if (key?.limit !== undefined && key.limit > 0) {
    // Prefer the server-reported remaining amount, then the usage field that
    // matches the declared reset window, then cumulative usage (that order).
    let used: number | undefined;
    if (key.limitRemaining !== undefined) {
      used = key.limit - Math.min(key.limit, Math.max(0, key.limitRemaining));
    } else if (key.limitReset === "daily" && key.usageDaily !== undefined) {
      used = key.usageDaily;
    } else if (key.limitReset === "weekly" && key.usageWeekly !== undefined) {
      used = key.usageWeekly;
    } else if (key.limitReset === "monthly" && key.usageMonthly !== undefined) {
      used = key.usageMonthly;
    } else if (key.usage !== undefined) {
      used = key.usage;
    }
    if (used !== undefined && Number.isFinite(used) && used >= 0) {
      windows.push({
        label: "primary",
        title: "API key budget",
        usedPercent: Math.min(100, (used / key.limit) * 100),
        ...(key.limitReset !== undefined ? { resetDescription: `resets ${key.limitReset}` } : {}),
      });
    }
  }

  const extras: Record<string, unknown> = {
    capability: "credits",
    provenance: "vendorMetered",
    note: "spend figures are metered values reported by the OpenRouter API - no estimates mixed in",
  };
  if (credits !== undefined) {
    extras.totalCreditsUsd = credits.totalCredits;
    extras.totalUsageUsd = credits.totalUsage;
  } else {
    extras.creditsAvailable = false;
  }
  if (key !== undefined) {
    if (key.label !== undefined) extras.keyLabel = key.label;
    if (key.limit !== undefined) extras.keyBudgetUsd = key.limit;
    if (key.usage !== undefined) extras.keyUsageUsd = key.usage;
    if (key.limitRemaining !== undefined) extras.keyLimitRemainingUsd = key.limitRemaining;
    if (key.rateLimit !== undefined) extras.rateLimit = `${key.rateLimit.requests} requests / ${key.rateLimit.interval}`;
    for (const [name, value] of [
      ["usageDailyUsd", key.usageDaily],
      ["usageWeeklyUsd", key.usageWeekly],
      ["usageMonthlyUsd", key.usageMonthly],
    ] as const) {
      if (value !== undefined) extras[name] = value;
    }
  } else {
    extras.keyBudgetAvailable = false;
    if (parts.keyDegradedReason !== undefined) extras.keyBudgetNote = parts.keyDegradedReason;
  }
  if (parts.spendHistory !== undefined) {
    extras.spendHistoryDays = ACTIVITY_HISTORY_DAYS;
    extras.spendHistoryTotalUsd = parts.spendHistory.totalUsd;
    extras.spendHistoryByModel = parts.spendHistory.byModel.slice(0, 20);
    if (parts.spendHistory.windowEnd !== "") extras.spendHistoryWindowEnd = parts.spendHistory.windowEnd;
  } else if (parts.spendHistoryNote !== undefined) {
    extras.spendHistoryAvailable = false;
    extras.spendHistoryNote = parts.spendHistoryNote;
  }

  return {
    provider: "openrouter",
    source: "api-key",
    status: "ok",
    windows,
    updatedAt: fetchedAt,
    ...(credits !== undefined ? { creditsRemaining: credits.balance } : {}),
    extras,
  };
};

export interface OpenRouterOutcomes {
  readonly credentialsPresent: boolean;
  /** Credential values held in memory only for error-string redaction. */
  readonly secrets?: ReadonlyArray<string>;
  readonly creditsOutcome?: OpenRouterEndpointOutcome;
  readonly keyOutcome?: OpenRouterEndpointOutcome;
  readonly historyOutcomes?: ReadonlyArray<OpenRouterEndpointOutcome>;
  readonly managementConfigured: boolean;
  readonly now?: Date;
}

/**
 * Pure fold of endpoint outcomes into the one snapshot callers see. Any
 * single-endpoint success ships an ok snapshot (degradations recorded in
 * extras); total failure folds into the error envelope. Secrets are redacted
 * from every emitted string.
 */
export const assembleOpenRouterSnapshot = (
  outcomes: OpenRouterOutcomes,
  fetchedAt: string,
): UsageSnapshot => {
  const redact = (text: string): string => redactSecret(text, outcomes.secrets ?? []);
  const decodeCredits =
    outcomes.creditsOutcome?.kind === "ok" ? parseCreditsPayload(outcomes.creditsOutcome.payload) : undefined;
  const decodeKey =
    outcomes.keyOutcome?.kind === "ok" ? parseKeyPayload(outcomes.keyOutcome.payload) : undefined;

  const historyRows: OpenRouterActivityRow[] = [];
  let historyFailed = false;
  if (outcomes.historyOutcomes !== undefined) {
    const bounds = activityWindowBounds(outcomes.now ?? new Date(fetchedAt));
    try {
      for (const outcome of outcomes.historyOutcomes) {
        if (outcome.kind !== "ok") {
          historyFailed = true;
          continue;
        }
        historyRows.push(...parseActivityPayload(outcome.payload, bounds));
      }
    } catch {
      historyFailed = true;
    }
  }

  if (decodeCredits !== undefined || decodeKey !== undefined) {
    const quota = buildOpenRouterQuota(
      {
        ...(decodeCredits !== undefined ? { credits: decodeCredits } : {}),
        ...(decodeKey !== undefined ? { key: decodeKey } : {}),
        ...(historyRows.length > 0 ? { spendHistory: buildSpendHistory(historyRows) } : {}),
        ...(decodeKey === undefined && outcomes.keyOutcome !== undefined
          ? { keyDegradedReason: keyDegradationText(outcomes.keyOutcome, redact) }
          : {}),
        ...(historyRows.length === 0
          ? { spendHistoryNote: spendHistoryNote(outcomes, historyFailed) }
          : {}),
      },
      fetchedAt,
    );
    return {
      source: "openrouter",
      fetchedAt,
      ok: true,
      quotas: quota !== undefined ? [quota] : [],
      dataConfidence: "live",
    };
  }

  // Total failure envelope.
  let reason: UsageUnavailableReason;
  let error: string;
  if (!outcomes.credentialsPresent) {
    reason = "source-missing";
    error = "no OpenRouter credentials found (OPENROUTER_API_KEY or conventional key files)";
  } else {
    const attempted = [outcomes.creditsOutcome, outcomes.keyOutcome].filter(
      (outcome): outcome is OpenRouterEndpointOutcome => outcome !== undefined,
    );
    if (attempted.some((outcome) => outcome.kind === "unauthorized")) {
      reason = "cli-error";
      const status = attempted.find((outcome) => outcome.kind === "unauthorized");
      error = `OpenRouter rejected credentials (HTTP ${status?.kind === "unauthorized" ? status.status : "?"})`;
    } else if (attempted.some((outcome) => outcome.kind === "failed")) {
      reason = "cli-error";
      const failure = attempted.find((outcome) => outcome.kind === "failed");
      error = redact(failure?.kind === "failed" ? failure.error : "request failed");
    } else {
      reason = "parse-error";
      error = "OpenRouter endpoints returned unrecognized payloads";
    }
  }
  return { source: "openrouter", fetchedAt, ok: false, reason, error, quotas: [] };
};

const keyDegradationText = (
  outcome: OpenRouterEndpointOutcome,
  redact: (text: string) => string,
): string => {
  switch (outcome.kind) {
    case "unauthorized":
      return `key info rejected credentials (HTTP ${outcome.status})`;
    case "http-error":
      return `key info returned HTTP ${outcome.status}`;
    case "failed":
      return `key info request failed (${redact(outcome.error)})`;
    default:
      return "key info payload was invalid";
  }
};

const spendHistoryNote = (outcomes: OpenRouterOutcomes, failed: boolean): string => {
  if (!outcomes.managementConfigured) return "management key not configured (OPENROUTER_MANAGEMENT_API_KEY)";
  if (outcomes.historyOutcomes?.some((outcome) => outcome.kind === "unauthorized") === true) {
    return "management key was rejected (HTTP 401/403)";
  }
  if (outcomes.historyOutcomes?.some((outcome) => outcome.kind === "http-error") === true) {
    return "activity request returned an HTTP error";
  }
  if (failed) return "activity response was invalid";
  return "activity unavailable";
};

const fetchAll = async (
  credentials: OpenRouterCredentials,
): Promise<Omit<OpenRouterOutcomes, "credentialsPresent" | "managementConfigured">> => {
  const headers: Record<string, string> = { Authorization: `Bearer ${credentials.apiKey}` };
  const creditsPromise = fetchOpenRouterJson(`${credentials.baseUrl}/credits`, headers, FETCH_TIMEOUT_MS);
  // Documented route first; fall back to the short form on 404.
  let keyOutcome = await fetchOpenRouterJson(`${credentials.baseUrl}/auth/key`, headers, FETCH_TIMEOUT_MS);
  if (keyOutcome.kind === "http-error" && keyOutcome.status === 404) {
    keyOutcome = await fetchOpenRouterJson(`${credentials.baseUrl}/key`, headers, FETCH_TIMEOUT_MS);
  }
  const creditsOutcome = await creditsPromise;

  let historyOutcomes: OpenRouterEndpointOutcome[] | undefined;
  // A management credential must never follow a user-configurable base URL to
  // a proxy — always hit the production activity host.
  if (credentials.managementApiKey !== undefined) {
    const bounds = activityWindowBounds(new Date());
    const activityHeaders: Record<string, string> = {
      Authorization: `Bearer ${credentials.managementApiKey}`,
    };
    const activityUrl = "https://openrouter.ai/api/v1/activity";
    historyOutcomes = await Promise.all([
      fetchOpenRouterJson(activityUrl, activityHeaders, ACTIVITY_TIMEOUT_MS),
      fetchOpenRouterJson(`${activityUrl}?date=${encodeURIComponent(bounds.latestCompleted)}`, activityHeaders, ACTIVITY_TIMEOUT_MS),
    ]);
  }

  return {
    creditsOutcome,
    keyOutcome,
    ...(historyOutcomes !== undefined ? { historyOutcomes } : {}),
  };
};

const detectOpenRouter = async (): Promise<boolean> =>
  resolveOpenRouterCredentials() !== undefined;

const fetchOpenRouter = async (): Promise<UsageSnapshot> => {
  const fetchedAt = new Date().toISOString();
  try {
    const credentials = resolveOpenRouterCredentials();
    if (credentials === undefined) {
      return assembleOpenRouterSnapshot({ credentialsPresent: false, managementConfigured: false }, fetchedAt);
    }
    const outcomes = await fetchAll(credentials);
    return assembleOpenRouterSnapshot(
      {
        credentialsPresent: true,
        managementConfigured: credentials.managementApiKey !== undefined,
        secrets: [credentials.apiKey, ...(credentials.managementApiKey !== undefined ? [credentials.managementApiKey] : [])],
        ...outcomes,
      },
      fetchedAt,
    );
  } catch (error) {
    return {
      source: "openrouter",
      fetchedAt,
      ok: false,
      reason: "cli-error",
      error: error instanceof Error ? error.message : String(error),
      quotas: [],
    };
  }
};

export const openrouterSource: UsageSource = {
  id: "openrouter",
  detect: Effect.promise(detectOpenRouter),
  fetch: Effect.promise(fetchOpenRouter),
};
