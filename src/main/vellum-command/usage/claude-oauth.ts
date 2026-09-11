import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderQuota, UsageWindow } from "@shared/usage";
import { parseJson, runCli } from "../adapters/exec";

// Live Claude Code subscription usage over the OAuth usage API:
// GET https://api.anthropic.com/api/oauth/usage with the access
// token Claude Code stores locally. The token is resolved best-effort from
// ~/.claude/.credentials.json, then the macOS Keychain item written by
// Claude Code itself. Tokens are used in-memory only — never logged,
// persisted, or included in error copy.

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
// Endpoint budget mirrors the task contract (~10s); keychain probe stays short
// so a hung security prompt never stalls a poll.
const USAGE_FETCH_TIMEOUT_MS = 10_000;
const KEYCHAIN_TIMEOUT_MS = 3_000;
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const CREDENTIALS_FILE = (): string => join(homedir(), ".claude", ".credentials.json");

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Pure decode of either known credential payload shapes:
 *   - `~/.claude/.credentials.json`: `{ claudeAiOauth: { accessToken, ... } }`
 *   - Keychain item body: same JSON, historically with an `oauthAccount` block.
 * Field names are probed defensively; anything else yields undefined.
 */
export const extractClaudeAccessToken = (payload: unknown): string | undefined => {
  if (!isObject(payload)) return undefined;
  const claudeAi = isObject(payload.claudeAiOauth) ? payload.claudeAiOauth : undefined;
  const oauthAccount = isObject(payload.oauthAccount) ? payload.oauthAccount : undefined;
  for (const holder of [claudeAi, oauthAccount, payload]) {
    const token =
      asString(holder?.accessToken) ?? asString(holder?.access_token) ??
      asString(holder?.oauthAccessToken);
    if (token !== undefined) return token;
  }
  return undefined;
};

const readTokenFromFile = (): string | undefined => {
  try {
    const path = CREDENTIALS_FILE();
    if (!existsSync(path)) return undefined;
    return extractClaudeAccessToken(parseJson(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
};

// Best-effort only: any failure (missing binary, locked keychain, user deny)
// degrades to undefined. stdout (which carries the secret) never surfaces.
const readTokenFromKeychain = async (): Promise<string | undefined> => {
  try {
    const result = await runCli(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      KEYCHAIN_TIMEOUT_MS,
    );
    if (!result.ok) return undefined;
    return extractClaudeAccessToken(parseJson(result.stdout.trim()));
  } catch {
    return undefined;
  }
};

/** Resolve the local Claude Code OAuth access token, file first, then Keychain. */
export const resolveClaudeAccessToken = async (): Promise<string | undefined> => {
  const fromFile = readTokenFromFile();
  if (fromFile !== undefined) return fromFile;
  return readTokenFromKeychain();
};

/** True when a credential could be present locally (no network). */
export const claudeCredentialsResolvable = (): boolean => {
  try {
    if (existsSync(CREDENTIALS_FILE())) return true;
  } catch {
    // fall through to keychain probe
  }
  return false;
};

export type ClaudeLiveOutcome =
  | { readonly kind: "ok"; readonly payload: unknown }
  | { readonly kind: "unauthorized"; readonly status: number }
  | { readonly kind: "failed"; readonly error: string };

interface UsageWindowShape {
  readonly utilization?: unknown;
  readonly resets_at?: unknown;
}

const windowPercent = (value: unknown): number | undefined => {
  if (!isObject(value)) return undefined;
  return asNumber((value as UsageWindowShape).utilization);
};

const resetsAtOf = (value: unknown): string | undefined => {
  if (!isObject(value)) return undefined;
  return asString((value as UsageWindowShape).resets_at);
};

const pushWindow = (
  windows: UsageWindow[],
  label: UsageWindow["label"],
  options: {
    id?: string;
    title?: string;
    percent?: number;
    windowMinutes?: number;
    resetsAt?: string;
  },
): void => {
  if (options.percent === undefined) return; // never fabricate a percentage
  windows.push({
    label,
    ...(options.id !== undefined ? { id: options.id } : {}),
    ...(options.title !== undefined ? { title: options.title } : {}),
    usedPercent: options.percent,
    ...(options.windowMinutes !== undefined ? { windowMinutes: options.windowMinutes } : {}),
    ...(options.resetsAt !== undefined
      ? { resetsAt: options.resetsAt, resetDescription: `resets ${options.resetsAt}` }
      : {}),
  });
};

const MODEL_WINDOW_TITLES: ReadonlyArray<readonly [keyof JsonObject, string]> = [
  ["seven_day_oauth_apps", "OAuth apps weekly"],
  ["seven_day_sonnet", "Sonnet weekly"],
  ["seven_day_opus", "Opus weekly"],
];

/**
 * Pure decode of the OAuth usage endpoint payload into plan windows:
 * five_hour → primary (300m), seven_day → secondary (10080m), model-specific
 * weeklies + scoped limits + extra-usage spend cap → extra windows. Unknown
 * fields are omitted; empty payloads yield undefined.
 */
export const parseClaudeOAuthUsage = (
  payload: unknown,
  fetchedAt: string,
): ProviderQuota | undefined => {
  if (!isObject(payload)) return undefined;
  const windows: UsageWindow[] = [];

  pushWindow(windows, "primary", {
    title: "5h",
    percent: windowPercent(payload.five_hour),
    windowMinutes: 300,
    resetsAt: resetsAtOf(payload.five_hour),
  });

  pushWindow(windows, "secondary", {
    title: "7d",
    percent: windowPercent(payload.seven_day),
    windowMinutes: 10_080,
    resetsAt: resetsAtOf(payload.seven_day),
  });

  for (const [key, title] of MODEL_WINDOW_TITLES) {
    const value = payload[key];
    pushWindow(windows, "extra", {
      id: String(key),
      title,
      percent: windowPercent(value),
      windowMinutes: 10_080,
      resetsAt: resetsAtOf(value),
    });
  }

  // Scoped weekly limits (kind/group/percent/resets_at/scope.model).
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  for (const limit of limits) {
    if (!isObject(limit)) continue;
    const kind = asString(limit.kind) ?? "scoped";
    const scope = isObject(limit.scope) ? limit.scope : undefined;
    const model = scope !== undefined && isObject(scope.model) ? scope.model : undefined;
    const modelName = model !== undefined ? asString(model.display_name) : undefined;
    pushWindow(windows, "extra", {
      id: modelName !== undefined ? `${kind}:${modelName}` : kind,
      title: modelName ?? kind,
      percent: asNumber(limit.percent),
      windowMinutes: 10_080,
      resetsAt: asString(limit.resets_at),
    });
  }

  // Extra usage spend cap (prepaid credit utilization), when exposed.
  const extraUsage = isObject(payload.extra_usage) ? payload.extra_usage : undefined;
  let extraUsageEnabled: boolean | undefined;
  let extraUsageExtras: Record<string, unknown> | undefined;
  if (extraUsage !== undefined) {
    extraUsageEnabled = typeof extraUsage.is_enabled === "boolean" ? extraUsage.is_enabled : undefined;
    const spendUtil = asNumber(extraUsage.utilization);
    pushWindow(windows, "extra", {
      id: "extra-usage-spend",
      title: "Spend cap",
      percent: spendUtil,
      resetsAt: resetsAtOf(extraUsage),
    });
    const usedCredits = asNumber(extraUsage.used_credits);
    const monthlyLimit = asNumber(extraUsage.monthly_limit);
    const currency = asString(extraUsage.currency);
    extraUsageExtras = {
      ...(extraUsageEnabled !== undefined ? { enabled: extraUsageEnabled } : {}),
      ...(usedCredits !== undefined ? { usedCredits } : {}),
      ...(monthlyLimit !== undefined ? { monthlyLimit } : {}),
      ...(currency !== undefined ? { currency } : {}),
    };
  }

  if (windows.length === 0) return undefined;

  return {
    provider: "claude",
    source: "oauth",
    status: "ok",
    windows,
    updatedAt: fetchedAt,
    extras: {
      capability: "live",
      sourcePath: "oauth-usage-api",
      ...(extraUsageExtras !== undefined ? { extraUsage: extraUsageExtras } : {}),
    },
  };
};

/**
 * One GET against the OAuth usage endpoint with a short timeout. Any failure
 — HTTP status, timeout, network, unparseable body — folds into a typed
 * outcome; this function never throws and never echoes the token or raw body.
 */
export const fetchClaudeUsageApi = async (
  accessToken: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ClaudeLiveOutcome> => {
  try {
    const response = await fetchImpl(CLAUDE_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/2.1.0",
        accept: "application/json",
      },
      signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { kind: "unauthorized", status: response.status };
      }
      return { kind: "failed", error: `usage endpoint returned ${response.status}` };
    }
    const text = await response.text();
    const parsed = parseJson<unknown>(text);
    if (parsed === undefined) {
      return { kind: "failed", error: "usage endpoint returned non-JSON body" };
    }
    return { kind: "ok", payload: parsed };
  } catch (error) {
    return {
      kind: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
