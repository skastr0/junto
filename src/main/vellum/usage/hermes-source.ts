import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { ProviderQuota, UsageSnapshot } from "@shared/usage";
import { runCli } from "../adapters/exec";
import type { UsageSource } from "./usage-source";

// Native Hermes usage: aggregate tokens + cost from state.db (root + profiles).
// Subscription-included plans report estimated_cost_usd = 0 — we show billing
// mode honestly, never invent a weekly limit surface (there isn't one).

const HERMES_HOME = (): string => join(homedir(), ".hermes");
const WINDOW_SECONDS = 7 * 24 * 60 * 60;
const QUERY_TIMEOUT_MS = 8_000;

export interface HermesAggregate {
  readonly sessions: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd: number;
  readonly billingMode: string | undefined;
  readonly databases: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** Pure quota builder — unit-tested. */
export const buildHermesQuota = (
  aggregate: HermesAggregate,
  fetchedAt: string,
): ProviderQuota | undefined => {
  if (aggregate.sessions === 0 && aggregate.totalTokens === 0) return undefined;
  return {
    provider: "hermes",
    source: "state.db",
    status: "ok",
    windows: [],
    updatedAt: fetchedAt,
    extras: {
      capability: "tokens",
      partial: true,
      note: "tokens from state.db · subscription has no separate limit surface",
      window: "7d",
      inputTokens: aggregate.inputTokens,
      outputTokens: aggregate.outputTokens,
      cacheReadTokens: aggregate.cacheReadTokens,
      reasoningTokens: aggregate.reasoningTokens,
      totalTokens: aggregate.totalTokens,
      costUsd: aggregate.estimatedCostUsd,
      sessions: aggregate.sessions,
      databases: aggregate.databases,
      ...(aggregate.billingMode !== undefined ? { billingMode: aggregate.billingMode } : {}),
    },
  };
};

/** Parse one sqlite3 -json row (or object) into a partial aggregate. */
export const parseHermesSqlRow = (row: unknown): Omit<HermesAggregate, "databases"> | undefined => {
  if (!isObject(row)) return undefined;
  const sessions = asNumber(row.sessions) ?? asNumber(row.cnt) ?? 0;
  const inputTokens = asNumber(row.input_tokens) ?? 0;
  const outputTokens = asNumber(row.output_tokens) ?? 0;
  const cacheReadTokens = asNumber(row.cache_read_tokens) ?? 0;
  const reasoningTokens = asNumber(row.reasoning_tokens) ?? 0;
  const estimatedCostUsd = asNumber(row.estimated_cost_usd) ?? 0;
  const billingMode = asString(row.billing_mode) ?? undefined;
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + reasoningTokens;
  return {
    sessions,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    reasoningTokens,
    totalTokens,
    estimatedCostUsd,
    billingMode,
  };
};

export const mergeHermesPartials = (
  parts: ReadonlyArray<Omit<HermesAggregate, "databases">>,
): HermesAggregate => {
  let sessions = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let reasoningTokens = 0;
  let estimatedCostUsd = 0;
  let billingMode: string | undefined;
  for (const part of parts) {
    sessions += part.sessions;
    inputTokens += part.inputTokens;
    outputTokens += part.outputTokens;
    cacheReadTokens += part.cacheReadTokens;
    reasoningTokens += part.reasoningTokens;
    estimatedCostUsd += part.estimatedCostUsd;
    if (billingMode === undefined && part.billingMode !== undefined) {
      billingMode = part.billingMode;
    }
  }
  return {
    sessions,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    reasoningTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + reasoningTokens,
    estimatedCostUsd,
    billingMode,
    databases: parts.length,
  };
};

const SQL = `
SELECT
  COUNT(*) AS sessions,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
  COALESCE(SUM(estimated_cost_usd), 0) AS estimated_cost_usd,
  MAX(billing_mode) AS billing_mode
FROM sessions
WHERE started_at >= (strftime('%s', 'now') - ${WINDOW_SECONDS})
`.trim();

const listStateDatabases = (home: string): string[] => {
  const paths: string[] = [];
  const root = join(home, "state.db");
  if (existsSync(root)) paths.push(root);
  const profiles = join(home, "profiles");
  if (!existsSync(profiles)) return paths;
  let names: string[];
  try {
    names = readdirSync(profiles);
  } catch {
    return paths;
  }
  for (const name of names) {
    const db = join(profiles, name, "state.db");
    try {
      if (statSync(db).isFile()) paths.push(db);
    } catch {
      // skip
    }
  }
  return paths;
};

const queryDatabase = async (dbPath: string): Promise<Omit<HermesAggregate, "databases"> | undefined> => {
  const result = await runCli("sqlite3", ["-json", dbPath, SQL], QUERY_TIMEOUT_MS);
  if (!result.ok || !result.stdout.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
  const row = Array.isArray(parsed) ? parsed[0] : parsed;
  return parseHermesSqlRow(row);
};

const detectHermes = async (): Promise<boolean> => {
  try {
    return existsSync(HERMES_HOME());
  } catch {
    return false;
  }
};

const fetchHermes = async (): Promise<UsageSnapshot> => {
  const fetchedAt = new Date().toISOString();
  const home = HERMES_HOME();
  try {
    if (!existsSync(home)) {
      return {
        source: "hermes",
        fetchedAt,
        ok: false,
        reason: "source-missing",
        error: "~/.hermes not found",
        quotas: [],
      };
    }
    const dbs = listStateDatabases(home);
    if (dbs.length === 0) {
      return {
        source: "hermes",
        fetchedAt,
        ok: false,
        reason: "source-missing",
        error: "no hermes state.db found",
        quotas: [],
      };
    }
    const parts: Array<Omit<HermesAggregate, "databases">> = [];
    for (const db of dbs) {
      const part = await queryDatabase(db);
      if (part !== undefined) parts.push(part);
    }
    if (parts.length === 0) {
      return {
        source: "hermes",
        fetchedAt,
        ok: false,
        reason: "cli-error",
        error: "sqlite3 query failed (is sqlite3 on PATH?)",
        quotas: [],
      };
    }
    const aggregate = mergeHermesPartials(parts);
    const quota = buildHermesQuota(aggregate, fetchedAt);
    if (quota === undefined) {
      return {
        source: "hermes",
        fetchedAt,
        ok: false,
        reason: "source-missing",
        error: "no hermes sessions in the last 7 days",
        quotas: [],
      };
    }
    return { source: "hermes", fetchedAt, ok: true, quotas: [quota] };
  } catch (error) {
    return {
      source: "hermes",
      fetchedAt,
      ok: false,
      reason: "cli-error",
      error: error instanceof Error ? error.message : String(error),
      quotas: [],
    };
  }
};

export const hermesSource: UsageSource = {
  id: "hermes",
  detect: Effect.promise(detectHermes),
  fetch: Effect.promise(fetchHermes),
};
