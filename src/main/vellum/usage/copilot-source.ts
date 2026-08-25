import { Effect } from "effect";
import type { ProviderQuota, UsageSnapshot, UsageUnavailableReason, UsageWindow } from "@shared/usage";
import type { UsageSource } from "./usage-source";
import { resolveCopilotToken } from "./copilot-auth";

// Native GitHub Copilot usage source.
//
// One live call against `GET https://api.github.com/copilot_internal/user`
// with VS Code-impersonating headers, plus a best-effort
// identity read from `GET https://api.github.com/user`. Token discovery is
// environment → GitHub CLI → ~/.config/gh/hosts.yml (see copilot-auth.ts).
// OAuth Device Flow is future work. Every failure mode folds into a TOTAL
// envelope; nothing throws and tokens never appear in error text.

const USAGE_URL = "https://api.github.com/copilot_internal/user";
const IDENTITY_URL = "https://api.github.com/user";
const FETCH_TIMEOUT_MS = 10_000;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** GitHub's quota fields arrive as number | numeric string — decode leniently. */
const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Redaction — tokens must never survive into an error string.
// ---------------------------------------------------------------------------

/** Replace every occurrence of `secret` with a placeholder. Pure + exported for tests. */
export const redactSecret = (text: string, secret: string | undefined): string =>
  secret === undefined || secret.length < 8 ? text : text.split(secret).join("[redacted]");

// ---------------------------------------------------------------------------
// Reset-date parsing — fractional ISO8601, plain ISO8601, or bare yyyy-MM-dd
// (UTC midnight).
// ---------------------------------------------------------------------------

export const parseQuotaResetDate = (value: unknown): string | undefined => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}([T ].+)?$/.test(raw)) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
};

// ---------------------------------------------------------------------------
// Quota snapshot decoding (lenient)
// ---------------------------------------------------------------------------

interface DecodedSnapshot {
  readonly entitlement?: number;
  readonly remaining?: number;
  readonly creditsUsed?: number;
  readonly percentRemaining: number;
  readonly hasPercentRemaining: boolean;
  readonly unlimited: boolean;
  /** Placeholder suppression: token-based billing / Business seats ship
   * zero-everything snapshots that would render a fake "0% used" bar. */
  readonly isPlaceholder: boolean;
}

const decodeQuotaSnapshot = (raw: unknown): DecodedSnapshot | undefined => {
  if (!isObject(raw)) return undefined;
  const entitlementRaw = raw.entitlement;
  const remainingRaw = raw.remaining;
  const entitlement = asNumber(entitlementRaw);
  const remaining = asNumber(remainingRaw);
  const creditsUsed = asNumber(raw.credits_used);
  const unlimited = raw.unlimited === true;

  let percentRemaining = 0;
  let hasPercentRemaining = false;
  const percentDecoded = asNumber(raw.percent_remaining);
  if (unlimited) {
    percentRemaining = 100;
    hasPercentRemaining = true;
  } else if (percentDecoded !== undefined) {
    percentRemaining = percentDecoded;
    hasPercentRemaining = true;
  } else if (entitlement !== undefined && entitlement > 0 && remaining !== undefined) {
    percentRemaining = (remaining / entitlement) * 100;
    hasPercentRemaining = true;
  }

  const zeroPlaceholder =
    entitlement === 0 &&
    remaining === 0 &&
    percentRemaining === 0 &&
    !hasPercentRemaining;
  const explicitZeroPair =
    entitlementRaw !== undefined && remainingRaw !== undefined && entitlement === 0 && remaining === 0;

  return {
    ...(entitlement !== undefined ? { entitlement } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(creditsUsed !== undefined ? { creditsUsed } : {}),
    percentRemaining,
    hasPercentRemaining,
    unlimited,
    isPlaceholder: !unlimited && (zeroPlaceholder || explicitZeroPair),
  };
};

const carriesCreditsCounter = (snapshot: DecodedSnapshot | undefined): boolean =>
  snapshot?.creditsUsed !== undefined;

/**
 * Select premium_interactions / chat with tiered fallbacks:
 * direct keys first, legacy monthly_quotas/limited_user_quotas counts as
 * synthetic snapshots, then dynamic-key name matching (chat / premium /
 * completion / code). Exported for unit tests.
 */
export const selectQuotaSnapshots = (payload: JsonObject): {
  readonly premium?: DecodedSnapshot;
  readonly chat?: DecodedSnapshot;
  readonly legacyShape: boolean;
} => {
  const usable = (snapshot: DecodedSnapshot | undefined): DecodedSnapshot | undefined =>
    snapshot !== undefined && !snapshot.isPlaceholder && snapshot.hasPercentRemaining ? snapshot : undefined;

  // Tier 1: direct snapshots (placeholders without a credit counter drop).
  const directRaw = isObject(payload.quota_snapshots) ? payload.quota_snapshots : undefined;
  let premium = usable(directRaw !== undefined ? decodeQuotaSnapshot(directRaw.premium_interactions) : undefined);
  let chat = usable(directRaw !== undefined ? decodeQuotaSnapshot(directRaw.chat) : undefined);

  // Tier 2: legacy monthly count shapes → synthetic percentage snapshots.
  if (premium === undefined && chat === undefined) {
    const monthly = isObject(payload.monthly_quotas) ? payload.monthly_quotas : undefined;
    const limited = isObject(payload.limited_user_quotas) ? payload.limited_user_quotas : undefined;
    const synthetic = (quota: unknown, used: unknown): DecodedSnapshot | undefined => {
      const entitlement = asNumber(quota);
      const remaining = asNumber(used);
      if (entitlement === undefined || entitlement <= 0 || remaining === undefined) return undefined;
      return {
        entitlement,
        remaining: Math.max(0, remaining),
        percentRemaining: Math.max(0, Math.min(100, (Math.max(0, remaining) / entitlement) * 100)),
        hasPercentRemaining: true,
        unlimited: false,
        isPlaceholder: false,
      };
    };
    const syntheticPremium = synthetic(monthly?.completions, limited?.completions);
    const syntheticChat = synthetic(monthly?.chat, limited?.chat);
    if (syntheticPremium !== undefined || syntheticChat !== undefined) {
      return {
        ...(syntheticPremium !== undefined ? { premium: syntheticPremium } : {}),
        ...(syntheticChat !== undefined ? { chat: syntheticChat } : {}),
        legacyShape: true,
      };
    }
  }

  // Tier 3: unknown dynamic snapshot keys matched by name.
  if (directRaw !== undefined && (premium === undefined || chat === undefined)) {
    for (const [key, value] of Object.entries(directRaw)) {
      const decoded = usable(decodeQuotaSnapshot(value));
      if (decoded === undefined) continue;
      const name = key.toLowerCase();
      if (chat === undefined && name.includes("chat")) {
        chat = decoded;
        continue;
      }
      if (
        premium === undefined &&
        (name.includes("premium") || name.includes("completion") || name.includes("code"))
      ) {
        premium = decoded;
      }
    }
  }

  return {
    ...(premium !== undefined ? { premium } : {}),
    ...(chat !== undefined ? { chat } : {}),
    legacyShape: false,
  };
};

const windowFromSnapshot = (
  snapshot: DecodedSnapshot,
  label: UsageWindow["label"],
  title: string,
  resetsAt: string | undefined,
): UsageWindow => {
  const usedPercent = Math.max(0, 100 - snapshot.percentRemaining);
  const overQuota = usedPercent > 100;
  const resetDescription = overQuota
    ? `${Math.round(usedPercent)}% used`
    : resetsAt !== undefined
      ? `resets ${resetsAt}`
      : undefined;
  return {
    label,
    title,
    usedPercent,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(resetDescription !== undefined ? { resetDescription } : {}),
  };
};

/**
 * Pure decode of the copilot_internal/user payload — exported for unit
 * tests. Returns undefined when nothing honest can be painted (no windows
 * AND no plan-level signal); token-based billing plans surface plan-only
 * rows instead of fake 0% bars.
 */
export const parseCopilotUsage = (
  payload: unknown,
  fetchedAt: string,
  identity?: { readonly account?: string; readonly tokenOrigin: string },
): ProviderQuota | undefined => {
  if (!isObject(payload)) return undefined;

  const { premium, chat, legacyShape } = selectQuotaSnapshots(payload);
  const resetsAt = parseQuotaResetDate(payload.quota_reset_date);
  const plan = asString(payload.copilot_plan);
  const tokenBasedBilling = payload.token_based_billing === true;
  const anyUnlimited = premium?.unlimited === true || chat?.unlimited === true;

  const windows: UsageWindow[] = [];
  if (premium !== undefined && !premium.unlimited && !premium.isPlaceholder && premium.hasPercentRemaining) {
    windows.push(windowFromSnapshot(premium, "primary", "Premium", resetsAt));
  }
  if (chat !== undefined && !chat.unlimited && !chat.isPlaceholder && chat.hasPercentRemaining) {
    windows.push(windowFromSnapshot(chat, "secondary", "Chat", resetsAt));
  }

  const creditsUsed = premium?.creditsUsed ?? chat?.creditsUsed;
  const creditsRemaining = premium?.remaining ?? chat?.remaining;

  // Nothing metered to show: omit honestly unless there is at least a plan /
  // billing signal worth surfacing. Never paint a fake 0% bar.
  if (windows.length === 0 && plan === undefined && creditsUsed === undefined && !tokenBasedBilling) {
    return undefined;
  }

  const extras: Record<string, unknown> = {
    endpoint: "copilot_internal/user",
    ...(identity !== undefined ? { tokenOrigin: identity.tokenOrigin } : {}),
    ...(legacyShape ? { note: "legacy monthly quota shape decoded" } : {}),
    ...(tokenBasedBilling ? { tokenBasedBilling: true } : {}),
    ...(anyUnlimited ? { unlimitedQuota: true } : {}),
    ...(creditsUsed !== undefined ? { creditsUsed } : {}),
  };

  const readMode = identity?.tokenOrigin === "cli" ? "cli" : "oauth";
  return {
    provider: "copilot",
    source: readMode,
    status: "ok",
    windows,
    updatedAt: fetchedAt,
    ...(identity?.account !== undefined ? { account: identity.account } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(creditsRemaining !== undefined ? { creditsRemaining } : {}),
    extras,
  };
};

// ---------------------------------------------------------------------------
// Envelope builder (same shape as the codex source)
// ---------------------------------------------------------------------------

export type CopilotOutcome =
  | { readonly kind: "ok"; readonly quotas: ReadonlyArray<ProviderQuota> }
  | {
      readonly kind: "unavailable";
      readonly reason: UsageUnavailableReason;
      readonly error: string;
    };

export const buildCopilotSnapshot = (fetchedAt: string, outcome: CopilotOutcome): UsageSnapshot =>
  outcome.kind === "ok"
    ? { source: "copilot", fetchedAt, ok: true, quotas: outcome.quotas, dataConfidence: "live" }
    : { source: "copilot", fetchedAt, ok: false, reason: outcome.reason, error: outcome.error, quotas: [] };

// ---------------------------------------------------------------------------
// Live fetch
// ---------------------------------------------------------------------------

const VS_CODE_EDITOR_VERSION = "vscode/1.96.2";
const COPILOT_PLUGIN_VERSION = "copilot-chat/0.26.7";

const copilotHeaders = (token: string): Record<string, string> => ({
  Authorization: `token ${token}`,
  Accept: "application/json",
  "Editor-Version": VS_CODE_EDITOR_VERSION,
  "Editor-Plugin-Version": COPILOT_PLUGIN_VERSION,
  "User-Agent": `GitHubCopilotChat/${COPILOT_PLUGIN_VERSION.split("/")[1]}`,
  "X-Github-Api-Version": "2025-04-01",
});

const fetchJson = async (url: string, token: string): Promise<{ status: number; body: unknown }> => {
  const response = await globalThis.fetch(url, {
    method: "GET",
    headers: copilotHeaders(token),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
};

const fetchIdentityLogin = async (token: string): Promise<string | undefined> => {
  try {
    // Best-effort only — identity loss never blocks the quota payload.
    const { status, body } = await fetchJson(IDENTITY_URL, token);
    if (status !== 200 || !isObject(body)) return undefined;
    return asString(body.login);
  } catch {
    return undefined;
  }
};

const fetchCopilot = async (): Promise<UsageSnapshot> => {
  const fetchedAt = new Date().toISOString();
  try {
    const auth = await resolveCopilotToken();
    if (auth.kind !== "ok") {
      return buildCopilotSnapshot(fetchedAt, {
        kind: "unavailable",
        reason: "source-missing",
        error: auth.error,
      });
    }

    let status: number;
    let body: unknown;
    try {
      ({ status, body } = await fetchJson(USAGE_URL, auth.token));
    } catch (error) {
      return buildCopilotSnapshot(fetchedAt, {
        kind: "unavailable",
        reason: "cli-error",
        error: redactSecret(
          error instanceof Error ? error.message : String(error),
          auth.token,
        ),
      });
    }

    if (status === 401 || status === 403) {
      return buildCopilotSnapshot(fetchedAt, {
        kind: "unavailable",
        reason: "cli-error",
        error: `GitHub rejected credentials (${status}) — run \`gh auth login\` or refresh COPILOT_API_TOKEN`,
      });
    }
    if (status !== 200) {
      return buildCopilotSnapshot(fetchedAt, {
        kind: "unavailable",
        reason: "cli-error",
        error: `usage endpoint returned HTTP ${status}`,
      });
    }

    const login = await fetchIdentityLogin(auth.token);
    const quota = parseCopilotUsage(body, fetchedAt, {
      ...(login !== undefined ? { account: login } : {}),
      tokenOrigin: auth.origin,
    });
    if (quota !== undefined) {
      return buildCopilotSnapshot(fetchedAt, { kind: "ok", quotas: [quota] });
    }
    return buildCopilotSnapshot(fetchedAt, {
      kind: "unavailable",
      reason: "parse-error",
      error: "usage endpoint returned no decodable Copilot quota snapshots",
    });
  } catch (error) {
    // Belt-and-braces TOTAL fold — resolve/token paths above already degrade.
    return buildCopilotSnapshot(fetchedAt, {
      kind: "unavailable",
      reason: "cli-error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const detectCopilot = async (): Promise<boolean> => {
  try {
    // Cheap local probe: env vars, gh CLI credential store, hosts.yml. The
    // gh call is a local read (`gh auth token`) bounded by its own timeout.
    return (await resolveCopilotToken()).kind === "ok";
  } catch {
    return false;
  }
};

export const copilotSource: UsageSource = {
  id: "copilot",
  detect: Effect.promise(detectCopilot),
  fetch: Effect.promise(fetchCopilot),
};
