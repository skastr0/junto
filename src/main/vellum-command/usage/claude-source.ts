import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { parseJson } from "../adapters/exec";
import type { ProviderQuota, UsageSnapshot, UsageUnavailableReason, UsageWindow } from "@shared/usage";
import {
  claudeCredentialsResolvable,
  fetchClaudeUsageApi,
  parseClaudeOAuthUsage,
  resolveClaudeAccessToken,
  type ClaudeLiveOutcome,
} from "./claude-oauth";
import type { UsageSource } from "./usage-source";

// Native Claude usage source — LIVE OAuth first, stale cache fallback.
//
// Strategy pipeline:
//   (a) LIVE: access token resolved from Claude Code's local credential store
//       (~/.claude/.credentials.json, then macOS Keychain) → one GET against
//       https://api.anthropic.com/api/oauth/usage. 401/403/network failure
//       folds into the stale path in the SAME call so callers always get the
//       best available data.
//   (b) FALLBACK: ~/.claude.json cachedUsageUtilization — machine-readable
//       mirror of the /usage screen. It refreshes only when the user opens
//       /usage in a live Claude session — we paint last-good honestly (stale
//       is fine; never invent live %).

const CLAUDE_JSON = (): string => join(homedir(), ".claude.json");

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

/** Pure decode of the stale cache — exported for unit tests. */
export const parseClaudeCachedUsage = (
  payload: unknown,
  fetchedAt: string,
): ProviderQuota | undefined => {
  if (!isObject(payload)) return undefined;
  const cached = isObject(payload.cachedUsageUtilization) ? payload.cachedUsageUtilization : undefined;
  if (cached === undefined) return undefined;

  const utilization = isObject(cached.utilization) ? cached.utilization : undefined;
  if (utilization === undefined) return undefined;

  const windows: UsageWindow[] = [];

  const fiveHour = isObject(utilization.five_hour) ? utilization.five_hour : undefined;
  const fivePct = fiveHour !== undefined ? asNumber(fiveHour.utilization) : undefined;
  if (fivePct !== undefined) {
    windows.push({
      label: "primary",
      title: "5h",
      usedPercent: fivePct,
      windowMinutes: 300,
      ...(asString(fiveHour?.resets_at) !== undefined
        ? { resetsAt: asString(fiveHour!.resets_at), resetDescription: `resets ${asString(fiveHour!.resets_at)}` }
        : {}),
    });
  }

  const sevenDay = isObject(utilization.seven_day) ? utilization.seven_day : undefined;
  const sevenPct = sevenDay !== undefined ? asNumber(sevenDay.utilization) : undefined;
  if (sevenPct !== undefined) {
    windows.push({
      label: "secondary",
      title: "7d",
      usedPercent: sevenPct,
      windowMinutes: 10_080,
      ...(asString(sevenDay?.resets_at) !== undefined
        ? { resetsAt: asString(sevenDay!.resets_at), resetDescription: `resets ${asString(sevenDay!.resets_at)}` }
        : {}),
    });
  }

  const limits = Array.isArray(utilization.limits) ? utilization.limits : [];
  for (const limit of limits) {
    if (!isObject(limit)) continue;
    const kind = asString(limit.kind);
    const percent = asNumber(limit.percent);
    if (percent === undefined) continue;
    // five_hour / seven_day already covered by primary/secondary.
    if (kind === "session" || kind === "weekly_all") continue;
    const scope = isObject(limit.scope) ? limit.scope : undefined;
    const model = scope !== undefined && isObject(scope.model) ? scope.model : undefined;
    const modelName = model !== undefined ? asString(model.display_name) : undefined;
    const title =
      modelName !== undefined
        ? modelName.length <= 18
          ? modelName
          : modelName.slice(0, 17)
        : (kind ?? "scoped");
    windows.push({
      label: "extra",
      id: kind ?? "scoped",
      title,
      usedPercent: percent,
      windowMinutes: 10_080,
      ...(asString(limit.resets_at) !== undefined
        ? { resetsAt: asString(limit.resets_at)!, resetDescription: `resets ${asString(limit.resets_at)}` }
        : {}),
    });
  }

  if (windows.length === 0) return undefined;

  const oauth = isObject(payload.oauthAccount) ? payload.oauthAccount : undefined;
  const account =
    (oauth !== undefined ? asString(oauth.emailAddress) : undefined) ??
    asString(cached.accountUuid);

  const spend = isObject(utilization.spend) ? utilization.spend : undefined;
  const spendUsed = spend !== undefined && isObject(spend.used) ? spend.used : undefined;
  const amountMinor = spendUsed !== undefined ? asNumber(spendUsed.amount_minor) : undefined;
  const exponent = spendUsed !== undefined ? asNumber(spendUsed.exponent) : undefined;
  const costUsd =
    amountMinor !== undefined && exponent !== undefined
      ? amountMinor / 10 ** exponent
      : undefined;

  const fetchedAtMs = asNumber(cached.fetchedAtMs);
  const updatedAt =
    fetchedAtMs !== undefined ? new Date(fetchedAtMs).toISOString() : fetchedAt;

  const extras: Record<string, unknown> = {
    capability: "limits",
    sourcePath: "cachedUsageUtilization",
    note: "refreshes when /usage is opened in Claude",
  };
  if (fetchedAtMs !== undefined) extras.fetchedAtMs = fetchedAtMs;
  if (costUsd !== undefined) extras.costUsd = costUsd;
  if (spend !== undefined) {
    const enabled = asBoolean(spend.enabled);
    if (enabled !== undefined) extras.spendEnabled = enabled;
  }

  return {
    provider: "claude",
    source: "claude.json",
    status: "ok",
    windows,
    updatedAt,
    ...(account !== undefined ? { account } : {}),
    extras,
  };
};

/**
 * Pure fold of a live outcome plus the raw stale-cache payload into the one
 * snapshot callers see. Live success wins when it decodes; any live failure
 * (including 401/403) falls back to the stale quota so the best available
 * data always ships. Exported for unit tests.
 */
export const assembleClaudeSnapshot = (
  outcome: ClaudeLiveOutcome | undefined,
  stalePayload: unknown,
  fetchedAt: string,
): UsageSnapshot => {
  if (outcome?.kind === "ok") {
    const liveQuota = parseClaudeOAuthUsage(outcome.payload, fetchedAt);
    if (liveQuota !== undefined) {
      return {
        source: "claude",
        fetchedAt,
        ok: true,
        quotas: [liveQuota],
        dataConfidence: "live",
      };
    }
    // Unusable live payload — degrade to the stale path below.
  }

  const staleQuota =
    stalePayload !== undefined ? parseClaudeCachedUsage(stalePayload, fetchedAt) : undefined;
  if (staleQuota !== undefined) {
    return {
      source: "claude",
      fetchedAt,
      ok: true,
      quotas: [staleQuota],
      dataConfidence: "stale-cache",
    };
  }

  let reason: UsageUnavailableReason;
  let error: string;
  if (outcome === undefined) {
    reason = "source-missing";
    error = "no local Claude Code credentials and no ~/.claude.json cache";
  } else if (outcome.kind === "unauthorized") {
    reason = "cli-error";
    error = `usage endpoint rejected credentials (${outcome.status})`;
  } else if (outcome.kind === "failed") {
    reason = "cli-error";
    error = outcome.error;
  } else {
    reason = "parse-error";
    error = "usage endpoint returned an unrecognized payload";
  }
  return { source: "claude", fetchedAt, ok: false, reason, error, quotas: [] };
};

const readStaleCachePayload = (): unknown | undefined => {
  try {
    const path = CLAUDE_JSON();
    if (!existsSync(path)) return undefined;
    return parseJson(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

const detectClaude = async (): Promise<boolean> => {
  try {
    if (existsSync(CLAUDE_JSON())) return true;
    if (claudeCredentialsResolvable()) return true;
    // Keychain presence probe stays cheap and best-effort; no network.
    const token = await resolveClaudeAccessToken();
    return token !== undefined;
  } catch {
    return false;
  }
};

const fetchClaude = async (): Promise<UsageSnapshot> => {
  const fetchedAt = new Date().toISOString();
  try {
    const token = await resolveClaudeAccessToken();
    const outcome =
      token !== undefined ? await fetchClaudeUsageApi(token) : undefined;
    return assembleClaudeSnapshot(outcome, readStaleCachePayload(), fetchedAt);
  } catch (error) {
    return {
      source: "claude",
      fetchedAt,
      ok: false,
      reason: "cli-error",
      error: error instanceof Error ? error.message : String(error),
      quotas: [],
    };
  }
};

export const claudeSource: UsageSource = {
  id: "claude",
  detect: Effect.promise(detectClaude),
  fetch: Effect.promise(fetchClaude),
};
