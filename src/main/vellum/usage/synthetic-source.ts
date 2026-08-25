import { Effect } from "effect";
import type { ProviderQuota, UsageSnapshot, UsageUnavailableReason, UsageWindow } from "@shared/usage";
import type { UsageSource } from "./usage-source";

// Native Synthetic usage source (synthetic.new) - API-key quota endpoint.
//
// Wire protocol:
//   GET https://api.synthetic.new/v2/quotas   Authorization: Bearer <key>
// Known quota slots at root or under `data`: rollingFiveHourLimit,
// weeklyTokenLimit, search.hourly. Generic fallback collects any object that
// carries percent or limit/used/remaining fields.
//
// Credential resolution (cheap, local, read-only):
//   1. SYNTHETIC_API_KEY environment variable (quotes stripped)
// TODO: an operator-configured key tier lands with the Providers settings page.
// There is no CLI and no OAuth flow. Every failure folds into the snapshot
// envelope; secrets never reach error strings or logs.

const SYNTHETIC_QUOTAS_URL = "https://api.synthetic.new/v2/quotas";
/** Hard budget for one quota poll so the HUD never stalls on a slow API. */
const USAGE_FETCH_TIMEOUT_MS = 10_000;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const REDACTED = "[redacted]";

/** Replace every occurrence of the secret in an error string. Never log. */
const redactSecret = (text: string, secret: string | undefined): string => {
  if (secret === undefined || secret.length === 0) return text;
  return text.split(secret).join(REDACTED);
};

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

/** Strip surrounding whitespace and one layer of matching quotes. */
export const cleanSyntheticApiKey = (raw: string | undefined): string | undefined => {
  if (typeof raw !== "string") return undefined;
  let value = raw.trim();
  if (value.length === 0) return undefined;
  if (
    (value.startsWith(String.fromCharCode(34)) && value.endsWith(String.fromCharCode(34))) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value.length > 0 ? value : undefined;
};

/** Credential resolution from the environment. */
export const resolveSyntheticApiKey = (env: NodeJS.ProcessEnv = process.env): string | undefined =>
  cleanSyntheticApiKey(env["SYNTHETIC_API_KEY"]);

// ---------------------------------------------------------------------------
// Response decode (pure, unit-tested)
// ---------------------------------------------------------------------------

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const firstString = (payload: JsonObject, keys: ReadonlyArray<string>): string | undefined => {
  for (const key of keys) {
    const value = asString(payload[key]);
    if (value !== undefined) return value;
  }
  return undefined;
};

const firstNumber = (payload: JsonObject, keys: ReadonlyArray<string>): number | undefined => {
  for (const key of keys) {
    const value = asNumber(payload[key]);
    if (value !== undefined) return value;
  }
  return undefined;
};

/** Fractions <= 1 are normalized to percentages. */
const normalizedPercent = (value: number | undefined): number | undefined =>
  value === undefined ? undefined : value <= 1 ? value * 100 : value;

const PERCENT_USED_KEYS = [
  "percentUsed",
  "usedPercent",
  "usagePercent",
  "usage_percent",
  "used_percent",
  "percent_used",
  "percent",
] as const;

const PERCENT_REMAINING_KEYS = [
  "percentRemaining",
  "remainingPercent",
  "remaining_percent",
  "percent_remaining",
] as const;

const LIMIT_KEYS = [
  "limit",
  "messageLimit",
  "message_limit",
  "messages",
  "maxRequests",
  "max_requests",
  "requestLimit",
  "request_limit",
  "quota",
  "max",
  "total",
  "capacity",
  "allowance",
] as const;

const USED_KEYS = [
  "used",
  "usage",
  "usedMessages",
  "used_messages",
  "messagesUsed",
  "messages_used",
  "requests",
  "requestCount",
  "request_count",
  "consumed",
  "spent",
] as const;

const REMAINING_KEYS = ["remaining", "left", "available"] as const;

const RESET_KEYS = [
  "resetAt",
  "reset_at",
  "resetsAt",
  "resets_at",
  "renewAt",
  "renew_at",
  "renewsAt",
  "renews_at",
  "nextTickAt",
  "next_tick_at",
  "nextRegenAt",
  "next_regen_at",
  "periodEnd",
  "period_end",
  "expiresAt",
  "expires_at",
  "endAt",
  "end_at",
] as const;

/** Derive windowMinutes from explicit durations, then labels like "5 hours". */
const windowMinutesOf = (payload: JsonObject): number | undefined => {
  const minutes = firstNumber(payload, [
    "windowMinutes",
    "window_minutes",
    "periodMinutes",
    "period_minutes",
  ]);
  if (minutes !== undefined) return Math.round(minutes);
  const hours = firstNumber(payload, ["windowHours", "window_hours", "periodHours", "period_hours"]);
  if (hours !== undefined) return Math.round(hours * 60);
  const days = firstNumber(payload, ["windowDays", "window_days", "periodDays", "period_days"]);
  if (days !== undefined) return Math.round(days * 1440);
  const seconds = firstNumber(payload, [
    "windowSeconds",
    "window_seconds",
    "periodSeconds",
    "period_seconds",
  ]);
  if (seconds !== undefined) return Math.round(seconds / 60);
  const text = firstString(payload, [
    "window",
    "windowLabel",
    "window_label",
    "period",
    "periodLabel",
    "period_label",
  ]);
  if (text === undefined) return undefined;
  const match = text
    .toLowerCase()
    .replace(/\s/g, "")
    .match(/^([0-9]*\.?[0-9]+)(minutes?|mins?|m|hours?|hrs?|hr|h|days?|d)$/);
  if (match === null) return undefined;
  const multiplier = match[2].startsWith("m") ? 1 : match[2].startsWith("d") ? 1440 : 60;
  return Math.round(Number(match[1]) * multiplier);
};

const windowDescription = (minutes: number | undefined): string | undefined => {
  if (minutes === undefined || minutes <= 0) return undefined;
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} day${days === 1 ? "" : "s"} window`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"} window`;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"} window`;
};

const isQuotaObject = (payload: unknown): payload is JsonObject =>
  isObject(payload) &&
  ([...PERCENT_USED_KEYS, ...PERCENT_REMAINING_KEYS, ...LIMIT_KEYS, ...USED_KEYS, ...REMAINING_KEYS] as ReadonlyArray<
    string
  >).some((key) => asNumber(payload[key]) !== undefined);

/** Depth-first collection of every quota-shaped object under a candidate node. */
const collectQuotas = (candidate: unknown): JsonObject[] => {
  if (Array.isArray(candidate)) return candidate.flatMap(collectQuotas);
  if (!isObject(candidate)) return [];
  if (isQuotaObject(candidate)) return [candidate];
  return Object.keys(candidate)
    .sort()
    .flatMap((key) => collectQuotas(candidate[key]));
};

const LABEL_KEYS = ["name", "label", "type", "period", "scope", "title", "id"] as const;
const PLAN_KEYS = [
  "plan",
  "planName",
  "plan_name",
  "subscription",
  "subscriptionPlan",
  "tier",
  "package",
  "packageName",
] as const;

const LABEL_BY_SLOT: ReadonlyArray<UsageWindow["label"]> = ["primary", "secondary", "tertiary"];

interface ParsedLane {
  readonly title?: string;
  readonly usedPercent: number;
  readonly windowMinutes?: number;
  readonly resetsAt?: string;
  readonly resetDescription?: string;
}

/** Decode one quota-shaped object into a lane, or undefined when no percent is derivable. */
const parseLane = (payload: JsonObject): ParsedLane | undefined => {
  let usedPercent = normalizedPercent(firstNumber(payload, PERCENT_USED_KEYS));
  const percentRemaining = normalizedPercent(firstNumber(payload, PERCENT_REMAINING_KEYS));
  if (usedPercent === undefined && percentRemaining !== undefined) usedPercent = 100 - percentRemaining;

  const limit = firstNumber(payload, LIMIT_KEYS);
  let used = firstNumber(payload, USED_KEYS);
  const remaining = firstNumber(payload, REMAINING_KEYS);
  let effectiveLimit = limit;
  if (effectiveLimit === undefined && used !== undefined && remaining !== undefined) {
    effectiveLimit = used + remaining;
  }
  if (used === undefined && effectiveLimit !== undefined && remaining !== undefined) {
    used = effectiveLimit - remaining;
  }
  if (
    usedPercent === undefined &&
    effectiveLimit !== undefined &&
    effectiveLimit > 0 &&
    used !== undefined
  ) {
    usedPercent = (used / effectiveLimit) * 100;
  }
  if (usedPercent === undefined) return undefined;
  usedPercent = Math.max(0, Math.min(100, usedPercent));

  const minutes = windowMinutesOf(payload);
  const resetsAt = firstDate(payload, RESET_KEYS);
  const resetDescription =
    resetsAt !== undefined ? `resets ${resetsAt}` : windowDescription(minutes);
  return {
    ...(firstString(payload, LABEL_KEYS) !== undefined
      ? { title: firstString(payload, LABEL_KEYS) }
      : {}),
    usedPercent,
    ...(minutes !== undefined ? { windowMinutes: minutes } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(resetDescription !== undefined ? { resetDescription } : {}),
  };
};

const firstDate = (payload: JsonObject, keys: ReadonlyArray<string>): string | undefined => {
  for (const key of keys) {
    if (payload[key] === undefined || payload[key] === null) continue;
    const date = parseIsoDate(payload[key]);
    if (date !== undefined) return date;
  }
  return undefined;
};

/** "$36.00" style currency strings become plain numbers. */
const currencyValue = (value: unknown): number | undefined => {
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(/[$,]/g, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return asNumber(value);
};

const parseIsoDate = (value: unknown): string | undefined => {
  const number = asNumber(value);
  if (number !== undefined) {
    const ms = number > 100_000_000_000 ? number : number * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return undefined;
};

/**
 * Pure decode of the /v2/quotas payload into a ProviderQuota. Known lanes map
 * to primary (five-hour), secondary (weekly tokens), tertiary (search hourly).
 * Generic quota collections fill those slots then overflow into `extra`.
 * Returns undefined when the payload carries no derivable quota data.
 */
export const parseSyntheticQuota = (
  payload: unknown,
  fetchedAt: string,
): ProviderQuota | undefined => {
  if (!isObject(payload)) return undefined;
  const root = payload;
  const data = isObject(root.data) ? root.data : undefined;

  // Known Synthetic slots first (root or nested under data).
  const pickSlot = (key: string): JsonObject | undefined => {
    if (isObject(root[key])) return root[key];
    return data !== undefined && isObject(data[key]) ? data[key] : undefined;
  };
  const rolling = pickSlot("rollingFiveHourLimit");
  const weekly = pickSlot("weeklyTokenLimit");
  const searchRoot = pickSlot("search");
  const searchHourly =
    searchRoot !== undefined && isObject(searchRoot.hourly) ? searchRoot.hourly : undefined;
  const searchHourlyObj: JsonObject | undefined = searchHourly;
  const hasKnownSlots = rolling !== undefined || weekly !== undefined || searchHourlyObj !== undefined;

  const knownSlots: Array<{ payload: JsonObject; title: string }> = [];
  if (rolling !== undefined)
    knownSlots.push({ payload: rolling, title: "Rolling five-hour limit" });
  if (weekly !== undefined) knownSlots.push({ payload: weekly, title: "Weekly token limit" });
  if (searchHourlyObj !== undefined)
    knownSlots.push({ payload: searchHourlyObj, title: "Search hourly" });

  let lanes: Array<ParsedLane | undefined>;
  if (hasKnownSlots) {
    lanes = knownSlots.map(({ payload: slotPayload, title }) => {
      const lane = parseLane(slotPayload);
      // A named slot without its own name keeps the canonical slot title.
      if (lane !== undefined && lane.title === undefined) {
        return { ...lane, title };
      }
      return lane;
    });
  } else {
    const candidates = [root.quotas, root.quota, root.limits, root.usage, root.entries, root.subscription, root.data];
    let values: JsonObject[] = [];
    for (const candidate of candidates) {
      values = collectQuotas(candidate);
      if (values.length > 0) break;
    }
    lanes = values.map((entry) => parseLane(entry));
  }

  const windows: UsageWindow[] = [];
  lanes.forEach((lane, index) => {
    if (lane === undefined) return;
    const label = index < LABEL_BY_SLOT.length ? LABEL_BY_SLOT[index] : "extra";
    const { title, ...rest } = lane;
    windows.push({
      label,
      ...rest,
      ...(title !== undefined ? { title } : {}),
    });
  });
  if (windows.length === 0) return undefined;

  const plan =
    firstString(root, PLAN_KEYS) ?? (data !== undefined ? firstString(data, PLAN_KEYS) : undefined);

  // Weekly credit pool: maxCredits / remainingCredits / nextRegenCredits map
  // onto creditsRemaining plus passthrough detail extras.
  let creditsRemaining: number | undefined;
  const creditExtras: Record<string, unknown> = {};
  if (weekly !== undefined) {
    const maxCredits = currencyValue(weekly.maxCredits ?? weekly["max_credits"]);
    const remainingCredits = currencyValue(weekly.remainingCredits ?? weekly["remaining_credits"]);
    const usedCredits = currencyValue(weekly.usedCredits ?? weekly["used_credits"]);
    const regen = currencyValue(weekly.nextRegenCredits ?? weekly["next_regen_credits"]);
    const derivedUsed =
      usedCredits !== undefined
        ? usedCredits
        : remainingCredits !== undefined && maxCredits !== undefined
          ? Math.max(0, maxCredits - remainingCredits)
          : undefined;
    if (remainingCredits !== undefined) {
      creditsRemaining = remainingCredits;
    } else if (derivedUsed !== undefined && maxCredits !== undefined) {
      creditsRemaining = Math.max(0, maxCredits - derivedUsed);
    }
    if (maxCredits !== undefined) creditExtras["creditLimit"] = maxCredits;
    if (derivedUsed !== undefined) creditExtras["creditsUsed"] = derivedUsed;
    if (regen !== undefined) creditExtras["nextRegenAmount"] = regen;
    const creditReset = firstDate(weekly, RESET_KEYS);
    if (creditReset !== undefined) creditExtras["resetsAt"] = creditReset;
  }

  return {
    provider: "synthetic",
    source: "api",
    status: "ok",
    ...(plan !== undefined ? { plan } : {}),
    windows,
    ...(creditsRemaining !== undefined ? { creditsRemaining } : {}),
    ...(Object.keys(creditExtras).length > 0 ? { extras: { weeklyCredits: creditExtras } } : {}),
    updatedAt: fetchedAt,
  };
};

// ---------------------------------------------------------------------------
// Live fetch
// ---------------------------------------------------------------------------

export type SyntheticLiveOutcome =
  | { readonly kind: "ok"; readonly payload: unknown }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "failed"; readonly error: string };

/**
 * One GET against the quota endpoint with a hard timeout. HTTP status,
 * timeout, network, and body failures fold into a typed outcome; this never
 * throws and never echoes the key or the raw response body.
 */
export const fetchSyntheticUsageApi = async (
  apiKey: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<SyntheticLiveOutcome> => {
  try {
    const response = await fetchImpl(SYNTHETIC_QUOTAS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { kind: "unauthorized" };
      }
      return { kind: "failed", error: `Synthetic quotas endpoint returned ${response.status}` };
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { kind: "failed", error: "Synthetic quotas endpoint returned non-JSON body" };
    }
    return { kind: "ok", payload: parsed };
  } catch (error) {
    return {
      kind: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

// ---------------------------------------------------------------------------
// Source assembly
// ---------------------------------------------------------------------------

const envelope = (
  fetchedAt: string,
  reason: UsageUnavailableReason,
  error: string,
): UsageSnapshot => ({
  source: "synthetic",
  fetchedAt,
  ok: false,
  reason,
  error,
  quotas: [],
});

/** Injectable dependencies so tests stay hermetic (no network, no host files). */
export interface SyntheticSourceDeps {
  readonly resolveApiKey?: () => string | undefined;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Build the Synthetic usage source. The default instance resolves
 * SYNTHETIC_API_KEY and uses global fetch.
 */
export const makeSyntheticSource = (deps: SyntheticSourceDeps = {}): UsageSource => {
  const resolveApiKey = deps.resolveApiKey ?? (() => resolveSyntheticApiKey());
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  /** Cheap local presence probe: credential resolvable, no network. */
  const detectSynthetic = async (): Promise<boolean> => resolveApiKey() !== undefined;

  /** TOTAL fetch - every failure mode folds into the snapshot envelope. */
  const fetchSynthetic = async (): Promise<UsageSnapshot> => {
    const fetchedAt = new Date().toISOString();
    try {
      const apiKey = resolveApiKey();
      if (apiKey === undefined) {
        return envelope(
          fetchedAt,
          "source-missing",
          "Synthetic API key not found - set SYNTHETIC_API_KEY to enable the Synthetic source",
        );
      }
      const outcome = await fetchSyntheticUsageApi(apiKey, fetchImpl);
      if (outcome.kind === "unauthorized") {
        return envelope(
          fetchedAt,
          "cli-error",
          redactSecret("Synthetic API rejected the stored credentials (HTTP 401/403)", apiKey),
        );
      }
      if (outcome.kind === "failed") {
        return envelope(fetchedAt, "cli-error", redactSecret(outcome.error, apiKey));
      }
      const quota = parseSyntheticQuota(outcome.payload, fetchedAt);
      if (quota === undefined) {
        return envelope(
          fetchedAt,
          "parse-error",
          redactSecret("Synthetic quotas response carried no derivable quota data", apiKey),
        );
      }
      return {
        source: "synthetic",
        fetchedAt,
        ok: true,
        dataConfidence: "live",
        quotas: [quota],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return envelope(fetchedAt, "cli-error", redactSecret(message, resolveApiKey()));
    }
  };

  return {
    id: "synthetic",
    detect: Effect.promise(detectSynthetic),
    fetch: Effect.promise(fetchSynthetic),
  };
};

export const syntheticSource: UsageSource = makeSyntheticSource();
