import { Effect } from "effect";
import type { ProviderQuota, UsageSnapshot, UsageWindow } from "@shared/usage";
import { rethrowIfCancelled, timeoutSignal, throwIfAborted } from "../access-signal";
import type { UsageSource } from "./usage-source";
import { detectCodexAuth, readCodexAuth } from "./codex-auth";

// Native OpenAI Codex subscription usage: ChatGPT backend
// `GET https://chatgpt.com/backend-api/wham/usage`, bearer from the Codex
// CLI's own ~/.codex/auth.json (read-only). We NEVER refresh tokens here —
// on 401/403 the envelope says re-auth via `codex` CLI login is needed.
// Every failure mode folds into a TOTAL envelope; nothing throws.

const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const FETCH_TIMEOUT_MS = 10_000;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Lane derivation from `limit_window_seconds` (Codex wire convention):
 * ~5h → session, ~weekly → weekly, ~monthly → monthly.
 */
export const deriveWindowTitle = (limitWindowSeconds: number): string => {
  if (!Number.isFinite(limitWindowSeconds) || limitWindowSeconds <= 0) return "";
  const minutes = limitWindowSeconds / 60;
  if (minutes <= 6 * 60) return "session"; // 5h session lane
  if (minutes <= 14 * 24 * 60) return "weekly"; // 7d weekly lane
  return "monthly";
};

/** Epoch-seconds → ISO, tolerant of absent/garbage values. */
const isoFromEpochSeconds = (value: unknown): string | undefined => {
  const seconds = asNumber(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  const ms = seconds * 1000;
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
};

const parseRateLimitWindow = (
  label: "primary" | "secondary" | "extra",
  value: unknown,
): UsageWindow | undefined => {
  if (!isObject(value)) return undefined;
  const usedPercent = asNumber(value.used_percent) ?? asNumber(value.usedPercent);
  if (usedPercent === undefined) return undefined;
  const limitWindowSeconds = asNumber(value.limit_window_seconds);
  const windowMinutes = limitWindowSeconds !== undefined && limitWindowSeconds > 0
    ? Math.round(limitWindowSeconds / 60)
    : undefined;
  const resetsAt = isoFromEpochSeconds(value.reset_at);
  const title = limitWindowSeconds !== undefined ? deriveWindowTitle(limitWindowSeconds) : "";
  return {
    label,
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(title !== "" ? { title } : {}),
    usedPercent,
    ...(resetsAt !== undefined ? { resetsAt, resetDescription: `resets ${resetsAt}` } : {}),
  };
};

// additional_rate_limits[] — named extra windows (e.g. GPT-5.x-Codex-Spark).
// One malformed entry never drops its siblings.
const parseAdditionalWindows = (payload: JsonObject): UsageWindow[] => {
  const rateLimit = isObject(payload.rate_limit) ? payload.rate_limit : {};
  const additional = Array.isArray(rateLimit.additional_rate_limits)
    ? rateLimit.additional_rate_limits
    : [];
  const windows: UsageWindow[] = [];
  for (const entry of additional) {
    if (!isObject(entry)) continue;
    const parsed = parseRateLimitWindow("extra", entry);
    if (parsed === undefined) continue;
    const id = asString(entry.limit_id) ?? asString(entry.id);
    windows.push({ ...parsed, label: "extra", ...(id !== undefined ? { id } : {}) });
  }
  return windows;
};

// credits.balance (number or numeric string); unlimited/absent → omitted.
const parseCreditsRemaining = (payload: JsonObject): number | undefined => {
  const rateLimit = isObject(payload.rate_limit) ? payload.rate_limit : {};
  const credits =
    (isObject(rateLimit.credits) ? rateLimit.credits : undefined) ??
    (isObject(payload.credits) ? payload.credits : undefined);
  if (credits === undefined) return undefined;
  if (credits.unlimited === true || credits.has_credits === false) return undefined;
  const balance = asNumber(credits.balance);
  if (balance !== undefined) return balance;
  const text = asString(credits.balance);
  if (text !== undefined && text.trim() !== "") {
    const numeric = Number(text);
    if (Number.isFinite(numeric)) return numeric;
  }
  return undefined;
};

const parsePlanType = (payload: JsonObject): string | undefined => {
  const rateLimit = isObject(payload.rate_limit) ? payload.rate_limit : {};
  return asString(payload.plan_type) ?? asString(rateLimit.plan_type);
};

/**
 * Pure decode of the wham/usage response — exported for unit tests.
 * Returns undefined when no usable rate-limit windows exist (caller degrades
 * honestly instead of painting an invented bar).
 */
export const parseWhamUsage = (
  payload: unknown,
  fetchedAt: string,
  identity?: { readonly accountId?: string; readonly email?: string },
): ProviderQuota | undefined => {
  if (!isObject(payload)) return undefined;
  const rateLimit = isObject(payload.rate_limit) ? payload.rate_limit : undefined;

  const primary = rateLimit !== undefined ? parseRateLimitWindow("primary", rateLimit.primary_window) : undefined;
  const secondary = rateLimit !== undefined ? parseRateLimitWindow("secondary", rateLimit.secondary_window) : undefined;
  const windows: UsageWindow[] = [
    ...(primary !== undefined ? [primary] : []),
    ...(secondary !== undefined ? [secondary] : []),
    ...parseAdditionalWindows(payload),
  ];
  if (windows.length === 0) return undefined;

  const creditsRemaining = parseCreditsRemaining(payload);
  const plan = parsePlanType(payload);
  const account = identity?.accountId ?? identity?.email;

  return {
    provider: "codex",
    source: "wham",
    status: "ok",
    windows,
    updatedAt: fetchedAt,
    ...(account !== undefined ? { account } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(creditsRemaining !== undefined ? { creditsRemaining } : {}),
  };
};

export type CodexOutcome =
  | { readonly kind: "ok"; readonly quotas: ReadonlyArray<ProviderQuota> }
  | {
      readonly kind: "unavailable";
      readonly reason: "cli-error" | "parse-error" | "source-missing";
      readonly error: string;
    };

// Envelope builder: every unavailable mode carries a machine-readable reason
// so the renderer can fail open.
export const buildCodexSnapshot = (fetchedAt: string, outcome: CodexOutcome): UsageSnapshot =>
  outcome.kind === "ok"
    ? { source: "codex", fetchedAt, ok: true, quotas: outcome.quotas }
    : { source: "codex", fetchedAt, ok: false, reason: outcome.reason, error: outcome.error, quotas: [] };

const fetchWhamUsage = async (
  bearerToken: string,
  accountId: string | undefined,
  signal?: AbortSignal,
): Promise<Response> => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearerToken}`,
    Accept: "application/json",
    "User-Agent": "Vellum Command",
  };
  // ChatGPT-Account-Id selects the workspace when the credential spans several.
  if (accountId !== undefined) headers["ChatGPT-Account-Id"] = accountId;
  return globalThis.fetch(WHAM_USAGE_URL, {
    method: "GET",
    headers,
    signal: timeoutSignal(FETCH_TIMEOUT_MS, signal),
  });
};

const fetchCodex = async (signal?: AbortSignal): Promise<UsageSnapshot> => {
  const fetchedAt = new Date().toISOString();
  try {
    // No credential → honest empty (same contract as the old stub, now keyed
    // on auth.json plausibility instead of bare ~/.codex existence).
    const auth = readCodexAuth();
    throwIfAborted(signal);
    if (auth.kind !== "ok") {
      const error =
        auth.kind === "missing"
          ? "~/.codex/auth.json not found — run codex CLI login to enable live Codex usage"
          : `${auth.error} — run codex CLI login to enable live Codex usage`;
      return buildCodexSnapshot(fetchedAt, { kind: "unavailable", reason: "source-missing", error });
    }

    const response = await fetchWhamUsage(auth.bearerToken, auth.accountId, signal);
    if (response.status === 401 || response.status === 403) {
      // Never refresh in-process: the Codex CLI owns rotation. Tell the
      // operator to re-authenticate; do not spawn or redeem anything.
      return buildCodexSnapshot(fetchedAt, {
        kind: "unavailable",
        reason: "cli-error",
        error: `ChatGPT backend rejected credentials (${response.status}) — run codex CLI login to refresh authentication`,
      });
    }
    if (!response.ok) {
      return buildCodexSnapshot(fetchedAt, {
        kind: "unavailable",
        reason: "cli-error",
        error: `wham/usage request failed with HTTP ${response.status}`,
      });
    }

    const payload = await response.json();
    const quota = parseWhamUsage(payload, fetchedAt, { accountId: auth.accountId, email: auth.email });
    if (quota === undefined) {
      return buildCodexSnapshot(fetchedAt, {
        kind: "unavailable",
        reason: "parse-error",
        error: "wham/usage returned no usable rate-limit windows",
      });
    }
    return buildCodexSnapshot(fetchedAt, { kind: "ok", quotas: [quota] });
  } catch (error) {
    rethrowIfCancelled(error, signal);
    return buildCodexSnapshot(fetchedAt, {
      kind: "unavailable",
      reason: "cli-error",
      // Error messages may carry URLs/statuses but never header material.
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

/** Capability note for doctor / HUD partial labeling — the fetch path is live. */
export const CODEX_LIMITS_STATUS = "live — chatgpt.com/backend-api/wham/usage via ~/.codex/auth.json (no in-process token refresh)";

export const codexSource: UsageSource = {
  id: "codex",
  detect: Effect.promise(detectCodexAuth),
  fetch: Effect.promise(fetchCodex),
};
