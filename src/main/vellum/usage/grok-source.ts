import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { ProviderQuota, UsageSnapshot, UsageWindow } from "@shared/usage";
import type { UsageSource } from "./usage-source";
import {
  GROK_AUTH_PATH,
  grokHome,
  isGrokCredentialExpired,
  readGrokCredentials,
} from "./grok-auth";
import {
  grokPrimaryTitle,
  parseGrokGrpcWebBilling,
  parseGrokProxyBilling,
  parseGrokSettingsTier,
  redactSecret,
} from "./grok-billing";

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
      note: "tokens/cost from local sessions - plan weekly % needs /usage scrape (not live)",
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


// ---------------------------------------------------------------------------
// Strategy pipeline: CLI credits proxy -> grok.com gRPC-web -> local sessions.
//
// Adapter constraint notes: the primary auto-mode strategy spawns an interactive
// `grok agent stdio` JSON-RPC session, but Vellum Command's shared adapter
// plane closes child stdin immediately (exec.ts runCli), so a multi-turn RPC
// exchange is unrepresentable here - the bearer-token surfaces below are the
// supported live path, with the local session scan as the honest floor.
// Browser-cookie scraping (Chrome sso/sso-rw) is deliberately out of scope.
// ---------------------------------------------------------------------------

const PROXY_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const PROXY_SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";
const GRPC_WEB_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
const FETCH_TIMEOUT_MS = 10_000;
const SETTINGS_TIMEOUT_MS = 4_000;

export type GrokTierOutcome =
  | {
      readonly kind: "ok";
      readonly quota: ProviderQuota;
      /** True when the quota came from the local sessions tier (derived confidence). */
      readonly fromSessions?: boolean;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: "cli-missing" | "cli-error" | "parse-error" | "source-missing";
      readonly error: string;
      /** Set when the endpoint rejected our credential (HTTP 401/403 or grpc auth status). */
      readonly authRejected?: boolean;
    };

export interface GrokFetchTiers {
  readonly credentialsMissing: boolean;
  readonly credentialsError?: string;
  readonly outcomes: ReadonlyArray<GrokTierOutcome>;
  readonly sessionsQuota?: ProviderQuota;
  readonly sessionsAvailable: boolean;
}

/**
 * Pure fold of the ordered tier outcomes into the one snapshot callers see -
 * exported for unit tests. First ok tier wins (network tiers carry live
 * confidence, the sessions tier derived); every failure folds into a TOTAL
 * fail-open envelope.
 */
export const assembleGrokSnapshot = (fetchedAt: string, tiers: GrokFetchTiers): UsageSnapshot => {
  for (const outcome of tiers.outcomes) {
    if (outcome.kind === "ok") {
      return {
        source: "grok",
        fetchedAt,
        ok: true,
        quotas: [outcome.quota],
        dataConfidence: outcome.fromSessions === true ? "derived" : "live",
      };
    }
  }

  // Every network tier failed - fall back to the local session scan before
  // failing the whole snapshot.
  if (tiers.sessionsQuota !== undefined) {
    return {
      source: "grok",
      fetchedAt,
      ok: true,
      quotas: [tiers.sessionsQuota],
      dataConfidence: "derived",
    };
  }

  const failures = tiers.outcomes.filter(
    (outcome): outcome is Extract<GrokTierOutcome, { kind: "unavailable" }> =>
      outcome.kind === "unavailable",
  );
  const authFailure = failures.find((outcome) => outcome.authRejected === true);
  if (authFailure !== undefined) {
    return {
      source: "grok",
      fetchedAt,
      ok: false,
      reason: "cli-error",
      error: authFailure.error,
      quotas: [],
    };
  }

  if (failures.length === 0 && !tiers.sessionsAvailable) {
    return {
      source: "grok",
      fetchedAt,
      ok: false,
      reason: "source-missing",
      error:
        tiers.credentialsMissing || tiers.credentialsError === undefined
          ? "no Grok credentials (~/.grok/auth.json or GROK_OAUTH_TOKEN) and no ~/.grok/sessions found"
          : tiers.credentialsError,
      quotas: [],
    };
  }

  const first = failures[0];
  const allParse = failures.every((outcome) => outcome.reason === "parse-error");
  return {
    source: "grok",
    fetchedAt,
    ok: false,
    reason: first !== undefined ? first.reason : allParse ? "parse-error" : "cli-error",
    error:
      first?.error ??
      (tiers.sessionsQuota === undefined ? "no recent Grok turn usage in updates.jsonl" : "Grok usage unavailable"),
    quotas: [],
  };
};

/** Redacted credential-rejection copy - exported for unit tests. */
export const grokAuthRejectedError = (
  status: number | string,
  accessToken: string,
): string =>
  redactSecret(
    `Grok billing endpoint rejected credentials (${String(status)}) - run grok CLI login to refresh authentication`,
    accessToken,
  );

const grokApiHeaders = (accessToken: string): Record<string, string> => ({
  Authorization: `Bearer ${accessToken}`,
  "x-xai-token-auth": "xai-grok-cli",
  Accept: "application/json",
  "User-Agent": "Vellum Command",
});

/** Tier 1: CLI credits proxy JSON billing, plus best-effort plan tier from /v1/settings. */
export const runGrokProxyTier = async (
  accessToken: string,
  email: string | undefined,
  fetchedAt: string,
): Promise<GrokTierOutcome> => {
  try {
    const response = await globalThis.fetch(PROXY_BILLING_URL, {
      method: "GET",
      headers: grokApiHeaders(accessToken),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return {
        kind: "unavailable",
        reason: "cli-error",
        authRejected: true,
        error: grokAuthRejectedError(response.status, accessToken),
      };
    }
    if (!response.ok) {
      return {
        kind: "unavailable",
        reason: "cli-error",
        error: redactSecret(
          `Grok credits proxy request failed with HTTP ${String(response.status)}`,
          accessToken,
        ),
      };
    }
    const payload: unknown = await response.json();
    const snapshot = parseGrokProxyBilling(payload);
    if (snapshot === undefined || snapshot.usedPercent === undefined) {
      return {
        kind: "unavailable",
        reason: "parse-error",
        error: "Grok credits proxy returned no usable usage percent",
      };
    }

    // The billed plan name lives on /v1/settings, not on the billing payload.
    let plan = snapshot.subscriptionTier;
    if (plan === undefined) {
      try {
        const settings = await globalThis.fetch(PROXY_SETTINGS_URL, {
          method: "GET",
          headers: grokApiHeaders(accessToken),
          signal: AbortSignal.timeout(SETTINGS_TIMEOUT_MS),
        });
        if (settings.ok) plan = parseGrokSettingsTier(await settings.json());
      } catch {
        // Plan enrichment is optional; the window ships without it.
      }
    }

    const resetsMs =
      snapshot.resetsAt !== undefined && Number.isFinite(Date.parse(snapshot.resetsAt))
        ? Date.parse(snapshot.resetsAt)
        : undefined;
    const title = grokPrimaryTitle(undefined, resetsMs, Date.now());
    const config =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? ((payload as JsonObject).config as JsonObject | undefined)
        : undefined;
    const capValue =
      config !== undefined && typeof config.onDemandCap === "object" && config.onDemandCap !== null
        ? (config.onDemandCap as JsonObject).val
        : undefined;
    const usedValue =
      config !== undefined && typeof config.onDemandUsed === "object" && config.onDemandUsed !== null
        ? (config.onDemandUsed as JsonObject).val
        : undefined;

    return {
      kind: "ok",
      quota: {
        provider: "grok",
        source: "cli-proxy",
        status: "ok",
        windows: [
          {
            label: "primary",
            usedPercent: snapshot.usedPercent,
            ...(title !== undefined ? { title } : {}),
            ...(snapshot.resetsAt !== undefined
              ? { resetsAt: snapshot.resetsAt, resetDescription: `resets ${snapshot.resetsAt}` }
              : {}),
          },
        ],
        ...(email !== undefined ? { account: email } : {}),
        ...(plan !== undefined ? { plan } : {}),
        updatedAt: fetchedAt,
        extras: {
          capability: "credits",
          endpoint: PROXY_BILLING_URL,
          note: "subscription credits are never converted to dollars - token costs come from local sessions",
          ...(typeof capValue === "number" && Number.isFinite(capValue) ? { onDemandCapCents: capValue } : {}),
          ...(typeof usedValue === "number" && Number.isFinite(usedValue) ? { onDemandUsedCents: usedValue } : {}),
        },
      },
    };
  } catch (error) {
    return {
      kind: "unavailable",
      reason: "cli-error",
      error: redactSecret(error instanceof Error ? error.message : String(error), accessToken),
    };
  }
};

/** Tier 2: grok.com gRPC-web GetGrokCreditsConfig - hand-parsed protobuf, one retry. */
export const runGrokGrpcWebTier = async (
  accessToken: string,
  email: string | undefined,
  fetchedAt: string,
): Promise<GrokTierOutcome> => {
  const requestOnce = async (): Promise<{ status: number; bytes: Uint8Array }> => {
    const response = await globalThis.fetch(GRPC_WEB_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Origin: "https://grok.com",
        Referer: "https://grok.com/?_s=usage",
        Accept: "*/*",
        "Content-Type": "application/grpc-web+proto",
        "x-grpc-web": "1",
        "x-user-agent": "connect-es/2.1.1",
        "User-Agent": "Vellum Command",
      },
      body: new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00]),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
  };

  try {
    let result: { status: number; bytes: Uint8Array };
    try {
      result = await requestOnce();
    } catch {
      // Exactly one retry on transport failure, then a classified error.
      result = await requestOnce();
    }
    if ([408, 502, 503, 504].includes(result.status)) {
      try {
        result = await requestOnce();
      } catch {
        return {
          kind: "unavailable",
          reason: "cli-error",
          error: "grok.com billing request failed after retry",
        };
      }
    }
    if (result.status !== 200) {
      return {
        kind: "unavailable",
        reason: "cli-error",
        error: redactSecret(
          `grok.com billing request failed with HTTP ${String(result.status)}`,
          accessToken,
        ),
      };
    }

    const parsed = parseGrokGrpcWebBilling(result.bytes);
    if (parsed.kind === "error") {
      const classified = classifyGrpcFailure(parsed.message);
      if (classified !== undefined) return classified;
      return {
        kind: "unavailable",
        reason: "parse-error",
        error: redactSecret(`could not parse grok.com billing usage (${parsed.message})`, accessToken),
      };
    }

    const resetsMs =
      parsed.snapshot.resetsAt !== undefined && Number.isFinite(Date.parse(parsed.snapshot.resetsAt))
        ? Date.parse(parsed.snapshot.resetsAt)
        : undefined;
    const title = grokPrimaryTitle(undefined, resetsMs, Date.now());
    const window: UsageWindow = {
      label: "primary",
      usedPercent: parsed.snapshot.usedPercent,
      ...(title !== undefined ? { title } : {}),
      ...(parsed.snapshot.resetsAt !== undefined
        ? { resetsAt: parsed.snapshot.resetsAt, resetDescription: `resets ${parsed.snapshot.resetsAt}` }
        : {}),
    };
    return {
      kind: "ok",
      quota: {
        provider: "grok",
        source: "grpc-web",
        status: "ok",
        windows: [window],
        ...(email !== undefined ? { account: email } : {}),
        updatedAt: fetchedAt,
        extras: {
          capability: "credits",
          endpoint: GRPC_WEB_URL,
          wirePublishedPercent: parsed.snapshot.wirePublished,
        },
      },
    };
  } catch (error) {
    return {
      kind: "unavailable",
      reason: "cli-error",
      error: redactSecret(error instanceof Error ? error.message : String(error), accessToken),
    };
  }
};

/** grpc trailers surface as status/message pairs inside the parsed body path. */
const classifyGrpcFailure = (message: string): GrokTierOutcome | undefined => {
  const lower = message.toLowerCase().trim();
  if (lower.includes("no personal team")) {
    return {
      kind: "unavailable",
      reason: "cli-error",
      error: "Grok team usage is unavailable from the current billing surface",
    };
  }
  if (lower.includes("unauthenticated") || lower.includes("bad-credentials") || lower.includes("no-credentials")) {
    return {
      kind: "unavailable",
      reason: "cli-error",
      authRejected: true,
      error: "grok.com billing rejected credentials - run grok CLI login to refresh xAI authentication",
    };
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Composition root for the source.
// ---------------------------------------------------------------------------

const detectGrok = async (): Promise<boolean> => {
  try {
    if (process.env.GROK_OAUTH_TOKEN !== undefined && process.env.GROK_OAUTH_TOKEN.trim() !== "") {
      return true;
    }
    return existsSync(GROK_AUTH_PATH()) || existsSync(grokHome());
  } catch {
    return false;
  }
};

const fetchGrok = async (): Promise<UsageSnapshot> => {
  const fetchedAt = new Date().toISOString();
  try {
    const resolution = readGrokCredentials();
    const credentials = resolution.kind === "ok" ? resolution.credentials : undefined;
    const outcomes: GrokTierOutcome[] = [];
    if (credentials !== undefined && !isGrokCredentialExpired(credentials)) {
      outcomes.push(await runGrokProxyTier(credentials.accessToken, credentials.email, fetchedAt));
      if (!outcomes.some((outcome) => outcome.kind === "ok")) {
        outcomes.push(await runGrokGrpcWebTier(credentials.accessToken, credentials.email, fetchedAt));
      }
    }

    // Lowest tier, always scanned: local session token aggregates.
    const sessionsAvailable = existsSync(GROK_SESSIONS());
    let sessionsQuota: ProviderQuota | undefined;
    if (sessionsAvailable) {
      const sinceMs = Date.now() - GROK_USAGE_WINDOW_MS;
      const files = listRecentUpdatesFiles(GROK_SESSIONS(), sinceMs);
      const aggregate = aggregateGrokUpdates(files);
      sessionsQuota = buildGrokQuota(aggregate, fetchedAt) ?? undefined;
    }

    return assembleGrokSnapshot(fetchedAt, {
      credentialsMissing: resolution.kind !== "ok",
      ...(resolution.kind !== "ok" ? { credentialsError: resolution.error } : {}),
      outcomes,
      ...(sessionsQuota !== undefined ? { sessionsQuota } : {}),
      sessionsAvailable,
    });
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
