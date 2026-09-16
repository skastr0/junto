import { existsSync } from "node:fs";
import { Effect } from "effect";
import type { ProviderQuota, UsageSnapshot, UsageWindow } from "@shared/usage";
import type { UsageUnavailableReason } from "@shared/usage";
import { rethrowIfCancelled, timeoutSignal, throwIfAborted } from "../access-signal";
import type { UsageSource } from "./usage-source";
import {
  cursorAppDbPath,
  cursorConfigCookiePath,
  resolveCursorCredential,
  type CursorCredential,
} from "./cursor-auth";

// Native Cursor usage: cookie-authenticated cursor.com web APIs, fanned out
// concurrently:
//   GET  /api/usage-summary                        - required; plan/onDemand/
//                                                    overall/pooled, cents.
//   GET  /api/auth/me                              - optional identity.
//   POST /api/dashboard/get-sand-usage-status      - optional weekly extra
//                                                    window (Grok Bot); needs
//                                                    an Origin header (CSRF).
//   POST /api/dashboard/get-filtered-usage-events  - paginated cost events;
//                                                    strict total-count
//                                                    reconciliation.
//
// Cost discipline: two DISTINCT numbers, never merged -
//   listPriceEstimate: sum of tokenUsage.totalCents (vendor list price).
//   vendorMetered:     sum of chargedCents (what the plan deducts);
//                      omitted whenever pagination is partial or any valid
//                      event lacks a charged amount, so a partial sum is
//                      never published as a window total.
//
// Every failure folds into the TOTAL envelope (ok:false + reason). Nothing
// throws; credentials are never logged and are scrubbed from error strings.

const CURSOR_BASE_URL = "https://cursor.com";
const FETCH_BUDGET_MS = 10_000;
const SAND_BUDGET_MS = 5_000;
const EVENTS_PAGE_SIZE = 1000;
const EVENTS_MAX_PAGES = 5;
/** Stop the events walk when less than this remains of the fetch budget. */
const EVENTS_TAIL_GUARD_MS = 1_500;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const formatResetDescription = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const hours24 = date.getHours();
  const meridiem = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `Resets ${MONTHS[date.getMonth()]} ${date.getDate()} at ${hours12}:${minutes}${meridiem}`;
};

const minutesBetweenIso = (startIso: string | undefined, endIso: string | undefined): number | undefined => {
  if (startIso === undefined || endIso === undefined) return undefined;
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  const minutes = Math.round((end - start) / 60_000);
  return minutes > 0 ? minutes : undefined;
};

/** Scrub credential material out of any user-visible error string. */
export const redactSecrets = (text: string, secrets: ReadonlyArray<string>): string => {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length >= 8) redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
};

// ---------------------------------------------------------------------------
// Pure decode - usage summary to windows
// ---------------------------------------------------------------------------

export interface CursorProbeData {
  readonly summary: JsonObject;
  readonly userInfo?: JsonObject;
  readonly requestUsage?: JsonObject;
  readonly sandUsage?: JsonObject;
}

interface PlanUsageView {
  readonly usedCents: number;
  readonly limitCents: number;
  readonly autoPercent?: number;
  readonly apiPercent?: number;
  readonly totalPercent?: number;
}

const planUsageView = (summary: JsonObject): PlanUsageView | undefined => {
  const individual = isObject(summary.individualUsage) ? summary.individualUsage : undefined;
  const plan = individual !== undefined && isObject(individual.plan) ? individual.plan : undefined;
  if (plan === undefined) return undefined;
  return {
    usedCents: asNumber(plan.used) ?? 0,
    limitCents: asNumber(plan.limit) ?? 0,
    autoPercent: asNumber(plan.autoPercentUsed),
    apiPercent: asNumber(plan.apiPercentUsed),
    totalPercent: asNumber(plan.totalPercentUsed),
  };
};

const centsRatioPercent = (
  summary: JsonObject,
  path: ReadonlyArray<string>,
): { readonly usedCents: number; readonly limitCents: number } | undefined => {
  let node: unknown = summary;
  for (const key of path) {
    node = isObject(node) ? node[key] : undefined;
  }
  if (!isObject(node)) return undefined;
  const usedCents = asNumber(node.used);
  const limitCents = asNumber(node.limit);
  if (usedCents === undefined || limitCents === undefined || limitCents <= 0) return undefined;
  return { usedCents, limitCents };
};

/**
 * Headline "Total" precedence (first match wins):
 * plan.totalPercentUsed -> averaged auto+api lanes -> either lane alone ->
 * plan cents ratio -> individualUsage.overall ratio -> teamUsage.pooled ratio.
 */
export const computePrimaryPercent = (summary: JsonObject): number => {
  const plan = planUsageView(summary);
  const norm = (value: number | undefined): number | undefined =>
    value === undefined ? undefined : clampPercent(value);
  if (plan?.totalPercent !== undefined) return clampPercent(plan.totalPercent);
  const auto = plan?.autoPercent;
  const api = plan?.apiPercent;
  const autoNorm = auto !== undefined ? norm(auto) : undefined;
  const apiNorm = api !== undefined ? norm(api) : undefined;
  if (autoNorm !== undefined && apiNorm !== undefined) return clampPercent((autoNorm + apiNorm) / 2);
  if (api !== undefined) return clampPercent(api);
  if (auto !== undefined) return clampPercent(auto);
  if (plan !== undefined && plan.limitCents > 0) {
    return clampPercent((plan.usedCents / plan.limitCents) * 100);
  }
  const overall = centsRatioPercent(summary, ["individualUsage", "overall"]);
  if (overall !== undefined) return clampPercent((overall.usedCents / overall.limitCents) * 100);
  const pooled = centsRatioPercent(summary, ["teamUsage", "pooled"]);
  if (pooled !== undefined) return clampPercent((pooled.usedCents / pooled.limitCents) * 100);
  return 0;
};

interface LegacyRequestUsage {
  readonly used: number;
  readonly limit: number;
}

const legacyRequestUsage = (requestUsage: JsonObject | undefined): LegacyRequestUsage | undefined => {
  if (requestUsage === undefined) return undefined;
  const gpt4 = isObject(requestUsage["gpt-4"]) ? requestUsage["gpt-4"] : undefined;
  if (gpt4 === undefined) return undefined;
  const limit = asNumber(gpt4.maxRequestUsage);
  if (limit === undefined || limit <= 0) return undefined;
  const used = asNumber(gpt4.numRequestsTotal) ?? asNumber(gpt4.numRequests);
  if (used === undefined) return undefined;
  return { used, limit };
};

const parseSandWindow = (sandUsage: JsonObject | undefined): UsageWindow | undefined => {
  if (sandUsage === undefined) return undefined;
  // Render only when the account has a nonzero included Bot allowance.
  if (sandUsage.hasNonZeroIncludedLimit !== true) return undefined;
  const usedPercent = asNumber(sandUsage.usagePercent);
  if (usedPercent === undefined) return undefined;
  const resetsAt = asString(sandUsage.nextResetTimestampUtc);
  const windowMinutes = minutesBetweenIso(
    asString(sandUsage.currentPeriodStart),
    resetsAt,
  );
  return {
    label: "extra",
    id: "cursor-grok-bot",
    title: "Grok Bot",
    usedPercent: clampPercent(usedPercent),
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
};

const PLAN_LABELS: Record<string, string> = {
  enterprise: "Cursor Enterprise",
  express: "Cursor Start",
  free: "Cursor Free",
  free_trial: "Cursor Pro Trial",
  hobby: "Cursor Hobby",
  pro: "Cursor Pro",
  pro_student: "Cursor Pro",
  pro_plus: "Cursor Pro+",
  team: "Cursor Team",
  ultra: "Cursor Ultra",
};

const formatPlanName = (membershipType: string | undefined): string | undefined => {
  if (membershipType === undefined) return undefined;
  return PLAN_LABELS[membershipType.toLowerCase()] ?? `Cursor ${membershipType}`;
};

const cycleWindowFields = (
  summary: JsonObject,
): { readonly windowMinutes?: number; readonly resetsAt?: string; readonly resetDescription?: string } => {
  const resetsAt = asString(summary.billingCycleEnd);
  const windowMinutes = minutesBetweenIso(asString(summary.billingCycleStart), resetsAt);
  const resetDescription = resetsAt !== undefined ? formatResetDescription(resetsAt) : undefined;
  return {
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(resetDescription !== undefined && resetDescription !== "" ? { resetDescription } : {}),
  };
};

const onDemandExtras = (node: unknown): JsonObject | undefined => {
  if (!isObject(node)) return undefined;
  const extras: JsonObject = {};
  if (typeof node.enabled === "boolean") extras.enabled = node.enabled;
  const used = asNumber(node.used);
  const limit = asNumber(node.limit);
  const remaining = asNumber(node.remaining);
  if (used !== undefined) extras.usedCents = used;
  if (limit !== undefined) extras.limitCents = limit;
  if (remaining !== undefined) extras.remainingCents = remaining;
  return Object.keys(extras).length > 0 ? extras : undefined;
};

/**
 * Pure decode of one probe fan-out into the Cursor provider quota. Exported
 * for unit tests. Always returns a quota when a decoded summary exists.
 */
export const buildCursorQuota = (
  data: CursorProbeData,
  costs: CursorEventCosts | undefined,
  fetchedAt: string,
  identityFallback?: { readonly email?: string; readonly sub?: string },
): ProviderQuota => {
  const { summary } = data;
  const legacy = legacyRequestUsage(data.requestUsage);
  const cycle = cycleWindowFields(summary);

  const primaryPercent =
    legacy !== undefined ? clampPercent((legacy.used / legacy.limit) * 100) : computePrimaryPercent(summary);
  const primary: UsageWindow = {
    label: "primary",
    usedPercent: primaryPercent,
    ...cycle,
    ...(legacy !== undefined
      ? { resetDescription: `${legacy.used} / ${legacy.limit} requests`, resetsAt: cycle.resetsAt }
      : {}),
  };

  // Legacy request plans have no token-based Auto/API lanes - hide them there.
  const plan = planUsageView(summary);
  const secondary: UsageWindow | undefined =
    legacy === undefined && plan?.autoPercent !== undefined
      ? { label: "secondary", title: "Auto", usedPercent: clampPercent(plan.autoPercent), ...cycle }
      : undefined;
  const tertiary: UsageWindow | undefined =
    legacy === undefined && plan?.apiPercent !== undefined
      ? { label: "tertiary", title: "API", usedPercent: clampPercent(plan.apiPercent), ...cycle }
      : undefined;

  const sandWindow = parseSandWindow(data.sandUsage);

  const windows: UsageWindow[] = [primary];
  if (secondary !== undefined) windows.push(secondary);
  if (tertiary !== undefined) windows.push(tertiary);
  if (sandWindow !== undefined) windows.push(sandWindow);

  const userInfo = data.userInfo;
  const email = asString(userInfo?.email) ?? identityFallback?.email;
  const account = email ?? asString(userInfo?.sub) ?? identityFallback?.sub;
  const planName = formatPlanName(asString(summary.membershipType));

  const extras: JsonObject = {};
  const onDemand = onDemandExtras(
    (isObject(summary.individualUsage) ? summary.individualUsage : {}).onDemand,
  );
  if (onDemand !== undefined) extras.onDemand = onDemand;
  const teamOnDemand = onDemandExtras(
    (isObject(summary.teamUsage) ? summary.teamUsage : {}).onDemand,
  );
  if (teamOnDemand !== undefined) extras.teamOnDemand = teamOnDemand;
  const pooled = onDemandExtras((isObject(summary.teamUsage) ? summary.teamUsage : {}).pooled);
  if (pooled !== undefined) extras.teamPooled = pooled;
  const overall = onDemandExtras(
    (isObject(summary.individualUsage) ? summary.individualUsage : {}).overall,
  );
  if (overall !== undefined) extras.overallCap = overall;
  if (costs !== undefined) {
    extras.costs = {
      listPriceEstimate: {
        provenance: "listPriceEstimate",
        totalCents: costs.listPriceCents,
        ...(costs.complete ? {} : { partial: true }),
      },
      // Metered spend publishes only when the walk completed AND every valid
      // event carried chargedCents. Never merged with the list-price figure.
      ...(costs.meteredCents !== undefined
        ? { vendorMetered: { provenance: "vendorMetered", totalCents: costs.meteredCents } }
        : {}),
    };
  }

  return {
    provider: "cursor",
    source: "web",
    status: "ok",
    windows,
    updatedAt: fetchedAt,
    ...(account !== undefined ? { account } : {}),
    ...(planName !== undefined ? { plan: planName } : {}),
    ...(Object.keys(extras).length > 0 ? { extras } : {}),
  };
};

// ---------------------------------------------------------------------------
// Pure decode - usage events pagination + cost sums
// ---------------------------------------------------------------------------

export interface CursorEventsPageData {
  readonly usageEventsDisplay: ReadonlyArray<unknown>;
  readonly totalUsageEventsCount?: number;
}

export interface ReconciledEvents {
  readonly events: ReadonlyArray<JsonObject>;
  /** True only after an empty/short page proved the end of the result set. */
  readonly complete: boolean;
}

const boundaryOverlap = (
  previousPage: ReadonlyArray<JsonObject>,
  currentPage: ReadonlyArray<JsonObject>,
): number => {
  const limit = Math.min(previousPage.length, currentPage.length);
  for (let count = limit; count >= 1; count -= 1) {
    let equal = true;
    for (let i = 0; i < count; i += 1) {
      if (JSON.stringify(previousPage[previousPage.length - count + i]) !== JSON.stringify(currentPage[i])) {
        equal = false;
        break;
      }
    }
    if (equal) return count;
  }
  return 0;
};

/**
 * Port of the reference pagination discipline: authoritative
 * totalUsageEventsCount must stay consistent across pages, completion needs
 * an empty/short page (a full page at the safety cap is ambiguous), and
 * duplicate rows at page boundaries are removed only up to the exact surplus
 * the reported count proves. Any inconsistency degrades to partial coverage.
 */
export const reconcileEventPages = (
  pages: ReadonlyArray<CursorEventsPageData>,
  pageSize: number = EVENTS_PAGE_SIZE,
  maxPages: number = EVENTS_MAX_PAGES,
): ReconciledEvents => {
  const pageRows: Array<Array<JsonObject>> = [];
  let expectedTotal: number | undefined;
  let complete = false;
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const rows = page.usageEventsDisplay.filter(isObject);
    if (page.totalUsageEventsCount !== undefined) {
      if (expectedTotal !== undefined && expectedTotal !== page.totalUsageEventsCount) {
        return { events: pageRows.flat(), complete: false };
      }
      expectedTotal = page.totalUsageEventsCount;
    }
    if (rows.length === 0) {
      complete = true;
      break;
    }
    pageRows.push(rows);
    if (rows.length < pageSize || index + 1 >= maxPages) {
      complete = rows.length < pageSize;
      break;
    }
  }
  const raw = pageRows.flat();
  if (!complete) return { events: raw, complete: false };
  if (expectedTotal === undefined) return { events: raw, complete: true };
  if (raw.length < expectedTotal) return { events: raw, complete: false };
  if (raw.length === expectedTotal) return { events: raw, complete: true };

  let removalsRemaining = raw.length - expectedTotal;
  const reconciled: Array<JsonObject> = [...pageRows[0]];
  for (let index = 1; index < pageRows.length; index += 1) {
    const overlap = boundaryOverlap(pageRows[index - 1], pageRows[index]);
    const removalCount = Math.min(overlap, removalsRemaining);
    reconciled.push(...pageRows[index].slice(removalCount));
    removalsRemaining -= removalCount;
  }
  if (removalsRemaining !== 0 || reconciled.length !== expectedTotal) {
    return { events: raw, complete: false };
  }
  return { events: reconciled, complete: true };
};

export interface CursorEventCosts {
  readonly complete: boolean;
  /** Vendor list-price estimate: sum of tokenUsage.totalCents. */
  readonly listPriceCents: number;
  /** Metered deduction: sum of chargedCents; undefined unless provable. */
  readonly meteredCents?: number;
}

/** Two distinct cost numbers from one event set - never merged. */
export const summarizeEventCosts = (
  events: ReadonlyArray<JsonObject>,
  complete: boolean,
): CursorEventCosts => {
  let listPriceCents = 0;
  let meteredTotal = 0;
  let sawValidEvent = false;
  let meteredProvable = true;
  for (const event of events) {
    const timestamp = asNumber(event.timestamp);
    if (timestamp === undefined || timestamp <= 0) continue; // invalid rows never count
    sawValidEvent = true;
    const tokenUsage = isObject(event.tokenUsage) ? event.tokenUsage : undefined;
    const totalCents = tokenUsage !== undefined ? asNumber(tokenUsage.totalCents) : undefined;
    if (totalCents !== undefined && totalCents >= 0) listPriceCents += totalCents;
    const chargedCents = asNumber(event.chargedCents);
    if (chargedCents === undefined || chargedCents < 0) {
      meteredProvable = false;
    } else {
      meteredTotal += chargedCents;
    }
  }
  return {
    complete,
    listPriceCents,
    ...(complete && meteredProvable && sawValidEvent ? { meteredCents: meteredTotal } : {}),
  };
};

// ---------------------------------------------------------------------------
// Snapshot envelope
// ---------------------------------------------------------------------------

export type CursorOutcome =
  | { readonly kind: "ok"; readonly quotas: ReadonlyArray<ProviderQuota> }
  | {
      readonly kind: "unavailable";
      readonly reason: UsageUnavailableReason;
      readonly error: string;
    };

export const buildCursorSnapshot = (fetchedAt: string, outcome: CursorOutcome): UsageSnapshot =>
  outcome.kind === "ok"
    ? { source: "cursor", fetchedAt, ok: true, quotas: outcome.quotas, dataConfidence: "live" }
    : {
        source: "cursor",
        fetchedAt,
        ok: false,
        reason: outcome.reason,
        error: outcome.error,
        quotas: [],
      };

// ---------------------------------------------------------------------------
// Network plane
// ---------------------------------------------------------------------------

/** Structural fetch seam - injectable in tests, globalThis.fetch in production. */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CursorHttpDeps {
  readonly fetch: FetchLike;
}

class CursorAuthRejectedError extends Error {
  constructor(readonly status: number) {
    super(`auth rejected (${status})`);
  }
}

class CursorHttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

class CursorParseError extends Error {}

const requestJson = async (
  deps: CursorHttpDeps,
  path: string,
  init: RequestInit,
): Promise<unknown> => {
  const response = await deps.fetch(`${CURSOR_BASE_URL}${path}`, init);
  if (response.status === 401 || response.status === 403) throw new CursorAuthRejectedError(response.status);
  if (!response.ok) throw new CursorHttpStatusError(response.status);
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new CursorParseError(`invalid JSON from ${path}`);
  }
};

const classifySummaryFailure = (error: unknown): CursorOutcome => {
  if (error instanceof CursorAuthRejectedError) {
    return {
      kind: "unavailable",
      reason: "cli-error",
      error:
        `cursor.com rejected credentials (${error.status}) - refresh your Cursor session ` +
        "(log in again or update CURSOR_COOKIE)",
    };
  }
  if (error instanceof CursorParseError) {
    return { kind: "unavailable", reason: "parse-error", error: error.message };
  }
  return {
    kind: "unavailable",
    reason: "cli-error",
    error: error instanceof Error ? error.message : String(error),
  };
};

const decodeEventsPage = (payload: unknown): CursorEventsPageData | undefined => {
  if (!isObject(payload)) return undefined;
  const display = payload.usageEventsDisplay;
  if (!Array.isArray(display)) return undefined;
  const totalCount = asNumber(payload.totalUsageEventsCount);
  return {
    usageEventsDisplay: display,
    ...(totalCount !== undefined ? { totalUsageEventsCount: Math.trunc(totalCount) } : {}),
  };
};

/**
 * Live probe against cursor.com with one resolved credential. Exported for
 * unit tests with an injected transport - production passes globalThis.fetch.
 */
export const probeCursorUsage = async (
  cookieHeader: string,
  deps: Partial<CursorHttpDeps> = {},
  signal?: AbortSignal,
): Promise<UsageSnapshot> => {
  const http: CursorHttpDeps = { fetch: deps.fetch ?? ((input, init) => globalThis.fetch(input, init)) };
  const fetchedAt = new Date().toISOString();
  const secrets = [cookieHeader];
  const deadline = Date.now() + FETCH_BUDGET_MS;
  const budgetMs = (cap?: number): number =>
    Math.max(1, Math.min(deadline - Date.now(), cap ?? FETCH_BUDGET_MS));
  const signalFor = (cap?: number): AbortSignal => timeoutSignal(budgetMs(cap), signal);

  const headers = (): Record<string, string> => ({
    Cookie: cookieHeader,
    Accept: "application/json",
    "User-Agent": "Junto",
  });

  try {
    const [summarySettled, meSettled, sandSettled] = await Promise.allSettled([
      requestJson(http, "/api/usage-summary", { headers: headers(), signal: signalFor() }),
      requestJson(http, "/api/auth/me", { headers: headers(), signal: signalFor() }),
      requestJson(http, "/api/dashboard/get-sand-usage-status", {
        method: "POST",
        headers: {
          ...headers(),
          "Content-Type": "application/json",
          // Cursor enforces CSRF on dashboard POSTs: Origin must match.
          Origin: CURSOR_BASE_URL,
        },
        body: "{}",
        signal: signalFor(SAND_BUDGET_MS),
      }),
    ]);

    if (summarySettled.status === "rejected") {
      return buildCursorSnapshot(fetchedAt, classifySummaryFailure(summarySettled.reason));
    }
    const summary = summarySettled.value;
    if (!isObject(summary)) {
      return buildCursorSnapshot(fetchedAt, {
        kind: "unavailable",
        reason: "parse-error",
        error: "usage-summary returned an unrecognized payload",
      });
    }
    const userInfo = meSettled.status === "fulfilled" && isObject(meSettled.value) ? meSettled.value : undefined;
    const sandUsage =
      sandSettled.status === "fulfilled" && isObject(sandSettled.value) ? sandSettled.value : undefined;

    throwIfAborted(signal);

    // Legacy request-based plans: GET /api/usage?user=<sub>, best-effort.
    let requestUsage: JsonObject | undefined;
    const subject = asString(userInfo?.sub);
    if (subject !== undefined && Date.now() + 250 < deadline) {
      try {
        const legacyPayload = await requestJson(http, `/api/usage?user=${encodeURIComponent(subject)}`, {
          headers: headers(),
          signal: signalFor(),
        });
        if (isObject(legacyPayload)) requestUsage = legacyPayload;
      } catch {
        // Not all plans expose this endpoint; ignore silently.
      }
    }

    // Cost events: bounded walk, best-effort. A slow or failing events feed
    // degrades cost extras to partial instead of failing the quota snapshot.
    const pages: CursorEventsPageData[] = [];
    let eventsComplete = false;
    let pagesUsable = false;
    for (let page = 1; page <= EVENTS_MAX_PAGES; page += 1) {
      throwIfAborted(signal);
      if (Date.now() + EVENTS_TAIL_GUARD_MS > deadline) break;
      try {
        const payload = await requestJson(http, "/api/dashboard/get-filtered-usage-events", {
          method: "POST",
          headers: {
            ...headers(),
            "Content-Type": "application/json",
            Origin: CURSOR_BASE_URL,
          },
          body: JSON.stringify({ page, pageSize: EVENTS_PAGE_SIZE }),
          signal: signalFor(),
        });
        const decoded = decodeEventsPage(payload);
        if (decoded === undefined) break;
        pagesUsable = true;
        pages.push(decoded);
        const rowCount = decoded.usageEventsDisplay.length;
        if (rowCount === 0 || rowCount < EVENTS_PAGE_SIZE) {
          eventsComplete = true;
          break;
        }
      } catch {
        break;
      }
    }

    let costs: CursorEventCosts | undefined;
    if (pagesUsable) {
      const reconciled = reconcileEventPages(pages);
      costs = summarizeEventCosts(reconciled.events, reconciled.complete);
    }

    const quota = buildCursorQuota({ summary, userInfo, requestUsage, sandUsage }, costs, fetchedAt);
    return buildCursorSnapshot(fetchedAt, { kind: "ok", quotas: [quota] });
  } catch (error) {
    rethrowIfCancelled(error, signal);
    return buildCursorSnapshot(fetchedAt, {
      kind: "unavailable",
      reason: "cli-error",
      // Error text may carry URLs/statuses but never header material.
      error: redactSecrets(error instanceof Error ? error.message : String(error), secrets),
    });
  }
};

const detectCursor = async (
  readOperator: () => CursorOperatorCredentials | undefined,
): Promise<boolean> => {
  try {
    const operatorCookie = readOperator()?.cookieHeader;
    if (operatorCookie !== undefined && operatorCookie.trim() !== "") return true;
    if (process.env.CURSOR_COOKIE?.trim() !== undefined && process.env.CURSOR_COOKIE.trim() !== "") {
      return true;
    }
    return resolveCredentialPresence();
  } catch {
    return false;
  }
};

const resolveCredentialPresence = (): boolean => {
  if (existsSync(cursorConfigCookiePath())) return true;
  return existsSync(cursorAppDbPath());
};

const makeFetchCursor =
  (readOperator: () => CursorOperatorCredentials | undefined) =>
  async (signal?: AbortSignal): Promise<UsageSnapshot> =>
    fetchCursor(readOperator()?.cookieHeader, signal);

const fetchCursor = async (
  operatorCookieHeader?: string,
  signal?: AbortSignal,
): Promise<UsageSnapshot> => {
  const fetchedAt = new Date().toISOString();
  try {
    const outcome = resolveCursorCredential({ operatorCookieHeader });
    if (outcome.kind === "missing") {
      return buildCursorSnapshot(fetchedAt, { kind: "unavailable", reason: "source-missing", error: outcome.error });
    }
    throwIfAborted(signal);
    const credential: CursorCredential = outcome.credential;
    return await probeCursorUsage(credential.cookieHeader, {}, signal);
  } catch (error) {
    rethrowIfCancelled(error, signal);
    return buildCursorSnapshot(fetchedAt, {
      kind: "unavailable",
      reason: "cli-error",
      error: redactSecrets(error instanceof Error ? error.message : String(error), []),
    });
  }
};

/** Capability note for doctor surfaces. */
export const CURSOR_LIMITS_STATUS =
  "live - cursor.com web APIs via CURSOR_COOKIE, ~/.junto/config/cursor-cookie, or the Cursor app session database";

/** Operator tier from Settings > Providers - highest precedence in the chain. */
export interface CursorOperatorCredentials {
  readonly cookieHeader?: string;
}

/**
 * Build the Cursor usage source over an operator-credential reader.
 * `readOperator` returns the Settings > Providers cursor section (raw
 * values, main-process only).
 */
export const makeCursorSource = (
  readOperator: () => CursorOperatorCredentials | undefined = () => undefined,
): UsageSource => ({
  id: "cursor",
  detect: Effect.promise(() => detectCursor(readOperator)),
  fetch: Effect.promise(makeFetchCursor(readOperator)),
});

/** Default instance: no operator tier (env var / config file / app database). */
export const cursorSource: UsageSource = makeCursorSource();
