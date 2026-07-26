import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { ProviderQuota, UsageSnapshot, UsageWindow } from "@shared/usage";
import type { UsageSource } from "./usage-source";

// Native Claude usage: ~/.claude.json → cachedUsageUtilization.
// Machine-readable mirror of the /usage screen (five_hour / seven_day / limits).
// Cache refreshes only when the user opens /usage in a live Claude session —
// we paint last-good honestly (stale is fine; never invent live %).

const CLAUDE_JSON = (): string => join(homedir(), ".claude.json");

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

/** Pure decode — exported for unit tests. */
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

const detectClaude = async (): Promise<boolean> => {
  try {
    return existsSync(CLAUDE_JSON());
  } catch {
    return false;
  }
};

const fetchClaude = async (): Promise<UsageSnapshot> => {
  const fetchedAt = new Date().toISOString();
  const path = CLAUDE_JSON();
  try {
    if (!existsSync(path)) {
      return {
        source: "claude",
        fetchedAt,
        ok: false,
        reason: "source-missing",
        error: "~/.claude.json not found",
        quotas: [],
      };
    }
    const raw = readFileSync(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        source: "claude",
        fetchedAt,
        ok: false,
        reason: "parse-error",
        error: "~/.claude.json is not valid JSON",
        quotas: [],
      };
    }
    const quota = parseClaudeCachedUsage(parsed, fetchedAt);
    if (quota === undefined) {
      return {
        source: "claude",
        fetchedAt,
        ok: false,
        reason: "source-missing",
        error: "cachedUsageUtilization absent (open /usage in Claude to populate)",
        quotas: [],
      };
    }
    return {
      source: "claude",
      fetchedAt,
      ok: true,
      quotas: [quota],
    };
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
