import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { ProviderQuota, UsageSnapshot, UsageUnavailableReason, UsageWindow } from "@shared/usage";
import { parseJson, runCli } from "../adapters/exec";
import type { UsageSource } from "./usage-source";

// Native OpenCode Go (the Go-based opencode CLI) usage source.
//
// Strategy pipeline (mirrors the CodexBar reference implementation):
//   (a) WEB/API — GET https://opencode.ai/zen/go/v1/usage with a Bearer key
//       resolved from OPENCODE_API_KEY or the opencode CLI's own
//       ~/.local/share/opencode/auth.json ("opencode-go"."key"). Read-only;
//       we NEVER rotate or redeem credentials. 401/403 folds into the local
//       tier below so callers always get the best available data.
//   (b) LOCAL — the opencode CLI records every assistant message (and, on
//       newer databases, each step-finish part) with a provider cost in
//       ~/.local/share/opencode/opencode.db. We read those rows through the
//       system sqlite3 CLI (read-only) and derive honest 5h/weekly/monthly
//       spend percentages against the documented Zen plan caps. Derived
//       numbers are labeled as such (dataConfidence "derived") — never
//       presented as server-reported quotas.
//
// Every failure folds into the TOTAL UsageSnapshot envelope; nothing throws.
// Secrets are redacted from every surfaced error string.

const OPENCODE_HOME = (): string => join(homedir(), ".local", "share", "opencode");
const AUTH_JSON = (): string => join(OPENCODE_HOME(), "auth.json");
const LOCAL_DB = (): string => join(OPENCODE_HOME(), "opencode.db");
const ZEN_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

/** Documented OpenCode Go Zen plan caps (USD) used for derived local percentages. */
export const ZEN_PLAN_LIMITS_USD = { session: 12, weekly: 30, monthly: 60 } as const;

const SESSION_WINDOW_MINUTES = 5 * 60;
const WEEK_WINDOW_MINUTES = 7 * 24 * 60;
const MONTH_WINDOW_MINUTES = 30 * 24 * 60;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 30;
// Monthly windows anchor at the earliest local row's day-of-month, which can
// reach back ~two calendar months — bound the SQL scan generously past that.
const SCAN_LOOKBACK_DAYS = 65;

const FETCH_TIMEOUT_MS = 10_000;
const SQLITE_TIMEOUT_MS = 9_000;

const API_KEY_ENV = "OPENCODE_API_KEY";

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Replace every occurrence of a secret with [redacted]. Empty secrets are ignored. */
export const redactSecrets = (text: string, secrets: ReadonlyArray<string | undefined>): string => {
  let out = text;
  for (const secret of secrets) {
    if (secret === undefined || secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
};

/**
 * API key resolution: OPENCODE_API_KEY first (quotes stripped), then the
 * opencode CLI's own auth.json ("opencode-go"."key"). Never logged.
 */
export const resolveGoApiKey = (
  env: NodeJS.ProcessEnv = process.env,
  openCodeHome: string = OPENCODE_HOME(),
): string | undefined => {
  const raw = env[API_KEY_ENV];
  if (raw !== undefined) {
    let value = raw.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1).trim();
    }
    if (value !== "") return value;
  }
  try {
    const path = join(openCodeHome, "auth.json");
    if (!existsSync(path)) return undefined;
    const payload = parseJson<unknown>(readFileSync(path, "utf8"));
    if (!isObject(payload)) return undefined;
    const entry = payload["opencode-go"];
    if (!isObject(entry)) return undefined;
    const key = asString(entry["key"])?.trim();
    return key !== undefined && key !== "" ? key : undefined;
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------------------
// Zen usage API decode
// ---------------------------------------------------------------------------

const PERCENT_KEYS = [
  "usagePercent",
  "usedPercent",
  "percentUsed",
  "percent",
  "usage_percent",
  "used_percent",
  "utilization",
  "utilizationPercent",
  "utilization_percent",
  "usage",
];
const RESET_IN_KEYS = [
  "resetInSec",
  "resetInSeconds",
  "resetSeconds",
  "reset_sec",
  "reset_in_sec",
  "resetsInSec",
  "resetsInSeconds",
  "resetIn",
  "resetSec",
];
const RESET_AT_KEYS = ["resetAt", "resetsAt", "reset_at", "resets_at", "nextReset", "next_reset"];
const RENEW_AT_KEYS = ["renewAt", "renew_at", "renewsAt"];
const USED_KEYS = ["used", "consumed", "count"];
const LIMIT_KEYS = ["limit", "total", "quota", "max", "cap"];

const firstValue = (dict: JsonObject, keys: ReadonlyArray<string>): unknown => {
  for (const key of keys) {
    if (dict[key] !== undefined) return dict[key];
  }
  return undefined;
};

const toDate = (value: unknown): Date | undefined => {
  const number = asNumber(value);
  if (number !== undefined) {
    if (number > 1_000_000_000_000) return new Date(number);
    if (number > 1_000_000_000) return new Date(number * 1000);
    return undefined;
  }
  const text = asString(value);
  if (text !== undefined) {
    const numeric = Number(text.trim());
    if (Number.isFinite(numeric)) return toDate(numeric);
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return undefined;
};

const isoFromSeconds = (seconds: number, fromMs: number): string => new Date(fromMs + seconds * 1000).toISOString();

interface ParsedWindow {
  readonly usedPercent: number;
  readonly resetsAt?: string;
}

const parseWindowDict = (dict: JsonObject, nowMs: number): ParsedWindow | undefined => {
  let percent: number | undefined;
  for (const key of PERCENT_KEYS) {
    const value = asNumber(dict[key]);
    if (value !== undefined) {
      percent = value;
      break;
    }
  }
  const directPercent = percent !== undefined;
  if (!directPercent) {
    let used: number | undefined;
    for (const key of USED_KEYS) {
      used = asNumber(dict[key]);
      if (used !== undefined) break;
    }
    let limit: number | undefined;
    for (const key of LIMIT_KEYS) {
      limit = asNumber(dict[key]);
      if (limit !== undefined) break;
    }
    if (used !== undefined && limit !== undefined && limit > 0) percent = (used / limit) * 100;
  }
  if (percent === undefined) return undefined;
  let resolved = directPercent && percent >= 0 && percent <= 1 ? percent * 100 : percent;
  resolved = Math.max(0, Math.min(100, resolved));

  let resetsAt: string | undefined;
  const resetInSec = firstValue(dict, RESET_IN_KEYS);
  const resetInSeconds = asNumber(resetInSec);
  if (resetInSeconds !== undefined && resetInSeconds >= 0) {
    resetsAt = isoFromSeconds(resetInSeconds, nowMs);
  } else {
    const parsedResetAt = toDate(firstValue(dict, RESET_AT_KEYS));
    if (parsedResetAt !== undefined) resetsAt = parsedResetAt.toISOString();
  }

  return { usedPercent: Math.round(resolved * 10) / 10, ...(resetsAt !== undefined ? { resetsAt } : {}) };
};

const WINDOW_GROUP_KEYS: ReadonlyArray<readonly [label: "primary" | "secondary" | "tertiary", keys: ReadonlyArray<string>, title: string, minutes: number]> = [
  ["primary", ["rollingUsage", "rolling", "rolling_usage", "rollingWindow", "rolling_window"], "5-hour", SESSION_WINDOW_MINUTES],
  ["secondary", ["weeklyUsage", "weekly", "weekly_usage"], "Weekly", WEEK_WINDOW_MINUTES],
  ["tertiary", ["monthlyUsage", "monthly", "monthly_usage"], "Monthly", MONTH_WINDOW_MINUTES],
];

const hasRollingGroup = (dict: JsonObject): boolean =>
  WINDOW_GROUP_KEYS[0]![1].some((key) => isObject(dict[key]));

const findUsageDict = (dict: JsonObject, depth: number): JsonObject | undefined => {
  if (hasRollingGroup(dict)) return dict;
  if (depth >= 3) return undefined;
  for (const nested of Object.values(dict)) {
    if (isObject(nested)) {
      const found = findUsageDict(nested, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

/**
 * Pure decode of the zen/go/v1/usage response — exported for unit tests.
 * Returns undefined when no usable rolling window exists.
 */
export const parseZenUsage = (payload: unknown, fetchedAt: string): ProviderQuota | undefined => {
  if (!isObject(payload)) return undefined;
  const nowMs = Date.parse(fetchedAt);
  const usageDict = findUsageDict(payload, 0);
  if (usageDict === undefined) return undefined;

  const windows: UsageWindow[] = [];
  for (const [label, keys, title, minutes] of WINDOW_GROUP_KEYS) {
    const group = firstValue(usageDict, keys);
    if (!isObject(group)) continue;
    const parsed = parseWindowDict(group, nowMs);
    if (parsed === undefined) continue;
    windows.push({
      label,
      title,
      usedPercent: parsed.usedPercent,
      windowMinutes: minutes,
      ...(parsed.resetsAt !== undefined ? { resetsAt: parsed.resetsAt, resetDescription: `resets ${parsed.resetsAt}` } : {}),
    });
  }
  if (windows.length === 0) return undefined;

  const findRenewAt = (dict: JsonObject, depth: number): Date | undefined => {
    const direct = toDate(firstValue(dict, RENEW_AT_KEYS));
    if (direct !== undefined) return direct;
    if (depth >= 3) return undefined;
    for (const nested of Object.values(dict)) {
      if (!isObject(nested)) continue;
      const found = findRenewAt(nested, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const renewsAt = findRenewAt(payload as JsonObject, 0);
  if (renewsAt !== undefined) {
    windows.push({
      label: "extra",
      id: "renewal",
      title: "Renews",
      usedPercent: 0,
      resetsAt: renewsAt.toISOString(),
      resetDescription: `resets ${renewsAt.toISOString()}`,
    });
  }

  return {
    provider: "opencode-go",
    source: "zen-api",
    status: "ok",
    windows,
    updatedAt: fetchedAt,
    extras: { capability: "plan-windows", endpoint: "zen/go/v1/usage" },
  };
};

// ---------------------------------------------------------------------------
// Local opencode.db reader (system sqlite3 CLI, read-only)
// ---------------------------------------------------------------------------

export interface GoCostRow {
  readonly createdMs: number;
  readonly cost: number;
  readonly model: string;
}

const MESSAGE_ONLY_SQL = (cutoffMs: number): string => `
SELECT
  CAST(COALESCE(json_extract(data, '$.time.created'), time_created) AS INTEGER) AS createdMs,
  CAST(json_extract(data, '$.cost') AS REAL) AS cost,
  1 AS requestCount,
  COALESCE(json_extract(data, '$.modelID'), '') AS modelID
FROM message
WHERE time_created >= ${cutoffMs}
  AND json_valid(data)
  AND json_extract(data, '$.providerID') = 'opencode-go'
  AND json_extract(data, '$.role') = 'assistant'
  AND json_type(data, '$.cost') IN ('integer', 'real')
`;

const MESSAGE_AND_PART_SQL = (cutoffMs: number): string => `
WITH provider_messages AS (
  SELECT
    id AS messageID,
    CAST(COALESCE(json_extract(data, '$.time.created'), time_created) AS INTEGER) AS createdMs,
    CAST(json_extract(data, '$.cost') AS REAL) AS cost,
    COALESCE(json_extract(data, '$.modelID'), '') AS modelID
  FROM message
  WHERE time_created >= ${cutoffMs}
    AND json_valid(data)
    AND json_extract(data, '$.providerID') = 'opencode-go'
    AND json_extract(data, '$.role') = 'assistant'
)
SELECT
  CAST(COALESCE(json_extract(p.data, '$.time.created'), p.time_created, m.createdMs) AS INTEGER) AS createdMs,
  CAST(json_extract(p.data, '$.cost') AS REAL) AS cost,
  1 AS requestCount,
  m.modelID AS modelID
FROM part p
JOIN provider_messages m ON m.messageID = p.message_id
WHERE json_valid(p.data)
  AND json_extract(p.data, '$.type') = 'step-finish'
  AND json_type(p.data, '$.cost') IN ('integer', 'real')
UNION ALL
SELECT createdMs, cost, 1 AS requestCount, modelID
FROM provider_messages m
WHERE NOT EXISTS (
  SELECT 1 FROM part p
  WHERE p.message_id = m.message_id
    AND json_valid(p.data)
    AND json_extract(p.data, '$.type') = 'step-finish'
    AND json_type(p.data, '$.cost') IN ('integer', 'real')
)
`;

/** Parse `sqlite3 -json` output rows into normalized cost rows. */
export const parseSqliteRows = (stdout: string): GoCostRow[] => {
  const payload = parseJson<unknown>(stdout);
  if (!Array.isArray(payload)) return [];
  const rows: GoCostRow[] = [];
  for (const entry of payload) {
    if (!isObject(entry)) continue;
    const createdMs = asNumber(entry.createdMs);
    const cost = asNumber(entry.cost);
    if (createdMs === undefined || cost === undefined || createdMs <= 0 || cost < 0) continue;
    // Tolerate second-resolution timestamps.
    const normalizedMs = createdMs < 100_000_000_000 ? createdMs * 1000 : createdMs;
    rows.push({
      createdMs: normalizedMs,
      cost,
      model: (asString(entry.modelID) ?? "").trim(),
    });
  }
  return rows;
};

export interface DailyBucket {
  readonly day: string;
  readonly model: string;
  readonly costUsd: number;
  readonly requests: number;
}

export interface LocalAggregate {
  readonly sessionCost: number;
  readonly weeklyCost: number;
  readonly monthlyCost: number;
  readonly oldestSessionMs?: number;
  readonly weekEndMs: number;
  readonly monthStartMs: number;
  readonly monthEndMs: number;
  readonly daily: ReadonlyArray<DailyBucket>;
}

const utcDayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const startOfUtcWeek = (nowMs: number): number => {
  const now = new Date(nowMs);
  const mondayOffset = (now.getUTCDay() + 6) % 7;
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - mondayOffset);
};

const daysInUtcMonth = (year: number, monthIndex: number): number => new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

/**
 * Month cycle anchored at the earliest local row's day/time-of-day (UTC),
 * mirroring how a billing anniversary drifts against calendar months.
 */
const anchoredMonthBounds = (nowMs: number, anchorMs: number | undefined): { startMs: number; endMs: number } => {
  const now = new Date(nowMs);
  if (anchorMs === undefined) {
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    return { startMs: start, endMs: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) };
  }
  const anchor = new Date(anchorMs);
  const anchoredStart = (year: number, monthIndex: number): number => {
    const day = Math.min(anchor.getUTCDate(), daysInUtcMonth(year, monthIndex));
    return Date.UTC(year, monthIndex, day, anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds());
  };
  let year = now.getUTCFullYear();
  let monthIndex = now.getUTCMonth();
  let start = anchoredStart(year, monthIndex);
  if (start > nowMs) {
    monthIndex -= 1;
    if (monthIndex < 0) {
      monthIndex = 11;
      year -= 1;
    }
    start = anchoredStart(year, monthIndex);
  }
  let endYear = year;
  let endMonth = monthIndex + 1;
  if (endMonth > 11) {
    endMonth = 0;
    endYear += 1;
  }
  return { startMs: start, endMs: anchoredStart(endYear, endMonth) };
};

/** Pure aggregate of cost rows over session/weekly/monthly windows + daily buckets. */
export const aggregateLocalRows = (rows: ReadonlyArray<GoCostRow>, nowMs: number): LocalAggregate => {
  const sessionStartMs = nowMs - 5 * 60 * 60 * 1000;
  const weekStartMs = startOfUtcWeek(nowMs);
  const weekEndMs = weekStartMs + WEEK_MS;
  const earliest = rows.reduce<number | undefined>(
    (min, row) => (min === undefined || row.createdMs < min ? row.createdMs : min),
    undefined,
  );
  const month = anchoredMonthBounds(nowMs, earliest);
  const historyStartMs = nowMs - HISTORY_DAYS * 24 * 60 * 60 * 1000;

  let sessionCost = 0;
  let weeklyCost = 0;
  let monthlyCost = 0;
  let oldestSessionMs: number | undefined;
  const dailyByDayModel = new Map<string, { cost: number; requests: number }>();

  for (const row of rows) {
    if (row.createdMs >= sessionStartMs && row.createdMs <= nowMs) {
      sessionCost += row.cost;
      if (oldestSessionMs === undefined || row.createdMs < oldestSessionMs) oldestSessionMs = row.createdMs;
    }
    if (row.createdMs >= weekStartMs && row.createdMs < weekEndMs) weeklyCost += row.cost;
    if (row.createdMs >= month.startMs && row.createdMs < month.endMs) monthlyCost += row.cost;
    if (row.createdMs >= historyStartMs && row.createdMs <= nowMs) {
      const key = `${utcDayKey(row.createdMs)}\u0000${row.model === "" ? "unknown" : row.model}`;
      const bucket = dailyByDayModel.get(key) ?? { cost: 0, requests: 0 };
      bucket.cost += row.cost;
      bucket.requests += 1;
      dailyByDayModel.set(key, bucket);
    }
  }

  const daily = [...dailyByDayModel.entries()]
    .map(([key, bucket]) => {
      const separator = key.indexOf("\u0000");
      return {
        day: key.slice(0, separator),
        model: key.slice(separator + 1),
        costUsd: Math.round(bucket.cost * 1000) / 1000,
        requests: bucket.requests,
      };
    })
    .sort((a, b) => (a.day === b.day ? b.costUsd - a.costUsd : a.day < b.day ? -1 : 1));

  return {
    sessionCost,
    weeklyCost,
    monthlyCost,
    ...(oldestSessionMs !== undefined ? { oldestSessionMs } : {}),
    weekEndMs,
    monthStartMs: month.startMs,
    monthEndMs: month.endMs,
    daily,
  };
};

const roundedPercent = (used: number, limit: number): number => {
  if (!Number.isFinite(used) || limit <= 0) return 0;
  return Math.round(Math.max(0, Math.min(100, (used / limit) * 100)) * 10) / 10;
};

/** Pure builder of the derived local quota — exported for unit tests. */
export const buildLocalQuota = (
  aggregate: LocalAggregate,
  nowMs: number,
  fetchedAt: string,
): ProviderQuota | undefined => {
  if (aggregate.daily.length === 0) return undefined;
  const windows: UsageWindow[] = [];

  const primaryResetsAt = aggregate.oldestSessionMs !== undefined
    ? new Date(Math.min(aggregate.oldestSessionMs + 5 * 60 * 60 * 1000, nowMs + 5 * 60 * 60 * 1000)).toISOString()
    : undefined;
  windows.push({
    label: "primary",
    title: "5-hour",
    usedPercent: roundedPercent(aggregate.sessionCost, ZEN_PLAN_LIMITS_USD.session),
    windowMinutes: SESSION_WINDOW_MINUTES,
    ...(primaryResetsAt !== undefined ? { resetsAt: primaryResetsAt, resetDescription: `resets ${primaryResetsAt}` } : {}),
  });

  const weeklyResetsAt = new Date(aggregate.weekEndMs).toISOString();
  windows.push({
    label: "secondary",
    title: "Weekly",
    usedPercent: roundedPercent(aggregate.weeklyCost, ZEN_PLAN_LIMITS_USD.weekly),
    windowMinutes: WEEK_WINDOW_MINUTES,
    resetsAt: weeklyResetsAt,
    resetDescription: `resets ${weeklyResetsAt}`,
  });

  const monthlyResetsAt = new Date(aggregate.monthEndMs).toISOString();
  windows.push({
    label: "tertiary",
    title: "Monthly",
    usedPercent: roundedPercent(aggregate.monthlyCost, ZEN_PLAN_LIMITS_USD.monthly),
    windowMinutes: MONTH_WINDOW_MINUTES,
    resetsAt: monthlyResetsAt,
    resetDescription: `resets ${monthlyResetsAt}`,
  });

  return {
    provider: "opencode-go",
    source: "local-file",
    status: "ok",
    windows,
    updatedAt: fetchedAt,
    extras: {
      capability: "cost",
      partial: true,
      note: "percentages derived from local opencode.db spend against assumed Zen plan caps - not server-reported",
      limitsUsd: ZEN_PLAN_LIMITS_USD,
      daily: aggregate.daily,
    },
  };
};

interface SqliteQueryOutcome {
  readonly ok: boolean;
  readonly rows?: ReadonlyArray<GoCostRow>;
  readonly error?: string;
}

const PART_TABLE_PROBE_SQL =
  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'part' LIMIT 1";

const hasPartTableResult = (stdout: string): boolean => {
  const payload = parseJson<unknown>(stdout);
  return Array.isArray(payload) && payload.length > 0;
};

const runDataQuery = async (hasPartTable: boolean, cutoffMs: number): Promise<SqliteQueryOutcome> => {
  const sql = hasPartTable ? MESSAGE_AND_PART_SQL(cutoffMs) : MESSAGE_ONLY_SQL(cutoffMs);
  const result = await runCli("sqlite3", ["-readonly", "-json", `file:${LOCAL_DB()}`, sql], SQLITE_TIMEOUT_MS);
  if (!result.ok) return { ok: false, error: result.error ?? "sqlite3 query failed" };
  return { ok: true, rows: parseSqliteRows(result.stdout) };
};

const probeSqlite = async (sql: string): Promise<{ readonly ok: boolean; readonly stdout?: string; readonly error?: string }> => {
  // A clean WAL shutdown can leave an idle main file without sidecars; a plain
  // read-only open then fails until SQLite recreates them. Retry immutable so
  // we never touch (or recreate) the opencode CLI's own WAL state.
  const plain = await runCli("sqlite3", ["-readonly", "-json", `file:${LOCAL_DB()}`, sql], SQLITE_TIMEOUT_MS);
  if (plain.ok) return { ok: true, stdout: plain.stdout };
  const immutable = await runCli("sqlite3", ["-readonly", "-json", `file:${LOCAL_DB()}?immutable=1`, sql], SQLITE_TIMEOUT_MS);
  if (immutable.ok) return { ok: true, stdout: immutable.stdout };
  return { ok: false, error: immutable.error ?? plain.error ?? "sqlite3 query failed" };
};

const readLocalRows = async (): Promise<SqliteQueryOutcome> => {
  const cutoffMs = Date.now() - SCAN_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const probe = await probeSqlite(PART_TABLE_PROBE_SQL);
  if (!probe.ok) return { ok: false, error: probe.error };
  // Newer databases carry per-step step-finish part rows; older ones are message-only.
  return runDataQuery(hasPartTableResult(probe.stdout ?? ""), cutoffMs);
};

// ---------------------------------------------------------------------------
// Envelope assembly
// ---------------------------------------------------------------------------

export type ApiTier =
  | { readonly kind: "skipped" }
  | { readonly kind: "ok"; readonly quota: ProviderQuota }
  | { readonly kind: "unauthorized"; readonly status: number }
  | { readonly kind: "http-error"; readonly status: number }
  | { readonly kind: "failed"; readonly error: string };

export type LocalTier =
  | { readonly kind: "skipped" }
  | { readonly kind: "ok"; readonly quota: ProviderQuota }
  | { readonly kind: "source-missing"; readonly error: string }
  | { readonly kind: "cli-error"; readonly error: string }
  | { readonly kind: "parse-error"; readonly error: string };

const mergeExtras = (
  apiExtras: Record<string, unknown> | undefined,
  localQuota: ProviderQuota | undefined,
): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...(apiExtras ?? {}) };
  if (localQuota?.extras !== undefined && localQuota.extras.localDaily !== undefined) {
    merged.localDaily = localQuota.extras.localDaily;
  } else if (localQuota?.extras !== undefined && Array.isArray(localQuota.extras.daily)) {
    merged.localDaily = localQuota.extras.daily;
  }
  return merged;
};

/**
 * Pure fold of both strategy tiers into the one snapshot callers see.
 * Live API wins when it decodes; otherwise the derived local estimate ships;
 * otherwise the failure envelope carries the most actionable reason.
 * All error text passes through secret redaction. Exported for unit tests.
 */
export const assembleGoSnapshot = (
  api: ApiTier,
  local: LocalTier,
  fetchedAt: string,
  secrets: ReadonlyArray<string | undefined> = [],
): UsageSnapshot => {
  const redacted = (text: string): string => redactSecrets(text, secrets);

  if (api.kind === "ok") {
    const quota: ProviderQuota = local.kind === "ok"
      ? { ...api.quota, extras: mergeExtras(api.quota.extras, local.quota) }
      : { ...api.quota };
    return { source: "opencode-go", fetchedAt, ok: true, quotas: [quota], dataConfidence: "live" };
  }

  if (local.kind === "ok") {
    return { source: "opencode-go", fetchedAt, ok: true, quotas: [local.quota], dataConfidence: "derived" };
  }

  let reason: UsageUnavailableReason;
  let error: string;
  if (api.kind === "unauthorized") {
    reason = "cli-error";
    error = redacted(
      `zen usage rejected credentials (${api.status}) - re-authenticate OpenCode Go (opencode auth login or refresh OPENCODE_API_KEY)`,
    );
  } else if (local.kind === "source-missing") {
    reason = "source-missing";
    error = redacted(local.error);
  } else if (local.kind === "cli-error") {
    reason = "cli-error";
    error = redacted(local.error);
  } else if (local.kind === "parse-error") {
    reason = "parse-error";
    error = redacted(local.error);
  } else if (api.kind === "http-error") {
    reason = "cli-error";
    error = `zen usage request failed with HTTP ${api.status}`;
  } else if (api.kind === "failed") {
    reason = "cli-error";
    error = redacted(api.error);
  } else {
    reason = "source-missing";
    error = "no OpenCode Go credential or local usage database available";
  }
  return { source: "opencode-go", fetchedAt, ok: false, reason, error, quotas: [] };
};

// ---------------------------------------------------------------------------
// Fetch pipeline (TOTAL)
// ---------------------------------------------------------------------------

interface FetchApiArgs {
  readonly apiKey: string;
}

const fetchZenUsage = async (args: FetchApiArgs): Promise<ApiTier> => {
  let response: Response;
  try {
    response = await globalThis.fetch(ZEN_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        Accept: "application/json",
        "User-Agent": "Vellum Command",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized", status: response.status };
  }
  if (!response.ok) {
    return { kind: "http-error", status: response.status };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { kind: "failed", error: "zen usage returned a non-JSON body" };
  }
  const quota = parseZenUsage(payload, new Date().toISOString());
  return quota !== undefined ? { kind: "ok", quota } : { kind: "failed", error: "zen usage returned no usable rate-limit windows" };
};

const fetchLocalTier = async (): Promise<LocalTier> => {
  const dbPath = LOCAL_DB();
  if (!existsSync(dbPath)) {
    return { kind: "source-missing", error: "~/.local/share/opencode/opencode.db not found - use OpenCode Go locally first" };
  }
  const outcome = await readLocalRows();
  if (!outcome.ok) {
    return { kind: "cli-error", error: `could not read local OpenCode Go usage: ${outcome.error ?? "unknown error"}` };
  }
  const nowMs = Date.now();
  const aggregate = aggregateLocalRows(outcome.rows ?? [], nowMs);
  const quota = buildLocalQuota(aggregate, nowMs, new Date().toISOString());
  if (quota === undefined) {
    return { kind: "source-missing", error: "no recent opencode-go cost rows in the local usage database" };
  }
  return { kind: "ok", quota };
};

const fetchOpenCodeGo = async (): Promise<UsageSnapshot> => {
  const fetchedAt = new Date().toISOString();
  try {
    const apiKey = resolveGoApiKey();
    const hasLocalDb = existsSync(LOCAL_DB());
    if (apiKey === undefined && !hasLocalDb) {
      return assembleGoSnapshot({ kind: "skipped" }, { kind: "skipped" }, fetchedAt);
    }

    const apiTier: ApiTier =
      apiKey !== undefined ? await fetchZenUsage({ apiKey }) : { kind: "skipped" };

    // A rejected credential alone is not worth a full local walk when the
    // database is absent — skip honestly instead of double-reporting.
    const localTier: LocalTier = hasLocalDb
      ? await fetchLocalTier()
      : { kind: "source-missing", error: "~/.local/share/opencode/opencode.db not found - use OpenCode Go locally first" };

    return assembleGoSnapshot(apiTier, localTier, fetchedAt, [apiKey]);
  } catch (error) {
    return {
      source: "opencode-go",
      fetchedAt,
      ok: false,
      reason: "cli-error",
      error: error instanceof Error ? error.message : String(error),
      quotas: [],
    };
  }
};

const detectOpenCodeGo = async (): Promise<boolean> => {
  try {
    if (process.env[API_KEY_ENV] !== undefined && process.env[API_KEY_ENV]!.trim() !== "") return true;
    if (existsSync(LOCAL_DB())) return true;
    if (existsSync(AUTH_JSON())) return true;
    return false;
  } catch {
    return false;
  }
};

/** Capability note for doctor / HUD partial labeling. */
export const OPENCODE_GO_LIMITS_STATUS =
  "live web windows via opencode.ai/zen/go/v1/usage (OPENCODE_API_KEY or auth.json); local opencode.db cost reader via system sqlite3";

export const opencodeGoSource: UsageSource = {
  id: "opencode-go",
  detect: Effect.promise(detectOpenCodeGo),
  fetch: Effect.promise(fetchOpenCodeGo),
};
