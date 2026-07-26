import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { ProviderQuota, UsageSnapshot } from "@shared/usage";
import type { UsageSource } from "./usage-source";

// Native Grok usage: per-turn tokens + costUsdTicks from updates.jsonl under
// ~/.grok/sessions. Weekly plan % is TUI-only (/usage scrape) — not claimed here.
// costUsdTicks scale is unverified; we surface ticks, never a fake USD claim.

const GROK_SESSIONS = (): string => join(homedir(), ".grok", "sessions");

/** Rolling window for token aggregation. */
export const GROK_USAGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Cap session files scanned per poll (newest first). */
const MAX_SESSION_FILES = 80;
/** Cap bytes read per updates.jsonl (tail). */
const MAX_UPDATES_BYTES = 512 * 1024;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export interface GrokTurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costUsdTicks: number;
}

/** Extract turn_completed usage from one updates.jsonl line. */
export const parseGrokUpdateLine = (line: string): GrokTurnUsage | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObject(parsed)) return undefined;
  const params = isObject(parsed.params) ? parsed.params : undefined;
  const update = params !== undefined && isObject(params.update) ? params.update : undefined;
  if (update === undefined) return undefined;
  if (update.sessionUpdate !== "turn_completed") return undefined;
  const usage = isObject(update.usage) ? update.usage : undefined;
  if (usage === undefined) return undefined;
  const inputTokens = asNumber(usage.inputTokens) ?? 0;
  const outputTokens = asNumber(usage.outputTokens) ?? 0;
  const totalTokens = asNumber(usage.totalTokens) ?? inputTokens + outputTokens;
  const costUsdTicks = asNumber(usage.costUsdTicks) ?? 0;
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0 && costUsdTicks === 0) {
    return undefined;
  }
  return { inputTokens, outputTokens, totalTokens, costUsdTicks };
};

export interface GrokAggregate {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costUsdTicks: number;
  readonly turns: number;
  readonly sessions: number;
}

/** Pure aggregate builder — unit-tested. */
export const buildGrokQuota = (
  aggregate: GrokAggregate,
  fetchedAt: string,
): ProviderQuota | undefined => {
  if (aggregate.turns === 0 && aggregate.totalTokens === 0) return undefined;
  return {
    provider: "grok",
    source: "updates.jsonl",
    status: "ok",
    windows: [],
    updatedAt: fetchedAt,
    extras: {
      capability: "tokens",
      partial: true,
      note: "tokens/cost from local sessions · plan weekly % needs /usage scrape (not live)",
      window: "7d",
      inputTokens: aggregate.inputTokens,
      outputTokens: aggregate.outputTokens,
      totalTokens: aggregate.totalTokens,
      costUsdTicks: aggregate.costUsdTicks,
      turns: aggregate.turns,
      sessions: aggregate.sessions,
    },
  };
};

const listRecentUpdatesFiles = (root: string, sinceMs: number): string[] => {
  const out: Array<{ path: string; mtime: number }> = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || out.length >= MAX_SESSION_FILES * 2) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (st.mtimeMs >= sinceMs) walk(full, depth + 1);
      } else if (name === "updates.jsonl" && st.mtimeMs >= sinceMs) {
        out.push({ path: full, mtime: st.mtimeMs });
      }
    }
  };
  walk(root, 0);
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, MAX_SESSION_FILES).map((entry) => entry.path);
};

const readTail = (path: string, maxBytes: number): string => {
  const raw = readFileSync(path);
  if (raw.length <= maxBytes) return raw.toString("utf8");
  // Start at a newline boundary so we don't parse a partial first line.
  const slice = raw.subarray(raw.length - maxBytes);
  const text = slice.toString("utf8");
  const nl = text.indexOf("\n");
  return nl >= 0 ? text.slice(nl + 1) : text;
};

export const aggregateGrokUpdates = (files: ReadonlyArray<string>): GrokAggregate => {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let costUsdTicks = 0;
  let turns = 0;
  let sessions = 0;
  for (const file of files) {
    let text: string;
    try {
      text = readTail(file, MAX_UPDATES_BYTES);
    } catch {
      continue;
    }
    let sessionTurns = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const usage = parseGrokUpdateLine(line);
      if (usage === undefined) continue;
      sessionTurns += 1;
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      totalTokens += usage.totalTokens;
      costUsdTicks += usage.costUsdTicks;
      turns += 1;
    }
    if (sessionTurns > 0) sessions += 1;
  }
  return { inputTokens, outputTokens, totalTokens, costUsdTicks, turns, sessions };
};

const detectGrok = async (): Promise<boolean> => {
  try {
    return existsSync(join(homedir(), ".grok"));
  } catch {
    return false;
  }
};

const fetchGrok = async (): Promise<UsageSnapshot> => {
  const fetchedAt = new Date().toISOString();
  const root = GROK_SESSIONS();
  try {
    if (!existsSync(root)) {
      return {
        source: "grok",
        fetchedAt,
        ok: false,
        reason: "source-missing",
        error: "~/.grok/sessions not found",
        quotas: [],
      };
    }
    const sinceMs = Date.now() - GROK_USAGE_WINDOW_MS;
    const files = listRecentUpdatesFiles(root, sinceMs);
    const aggregate = aggregateGrokUpdates(files);
    const quota = buildGrokQuota(aggregate, fetchedAt);
    if (quota === undefined) {
      return {
        source: "grok",
        fetchedAt,
        ok: false,
        reason: "source-missing",
        error: "no recent Grok turn usage in updates.jsonl",
        quotas: [],
      };
    }
    return { source: "grok", fetchedAt, ok: true, quotas: [quota] };
  } catch (error) {
    return {
      source: "grok",
      fetchedAt,
      ok: false,
      reason: "cli-error",
      error: error instanceof Error ? error.message : String(error),
      quotas: [],
    };
  }
};

export const grokSource: UsageSource = {
  id: "grok",
  detect: Effect.promise(detectGrok),
  fetch: Effect.promise(fetchGrok),
};
