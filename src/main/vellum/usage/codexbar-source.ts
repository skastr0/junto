import { Effect, Layer } from "effect";
import type {
  ProviderQuota,
  UsagePace,
  UsageSnapshot,
  UsageUnavailableReason,
  UsageWindow,
  UsageWindowLabel,
} from "@shared/usage";
import { parseJson, runCli } from "../adapters/exec";
import { UsageSources, type UsageSource } from "./usage-source";

// codexbar CLI as a UsageSource. `codexbar usage --json` honors the app's own
// provider toggles and returns one entry per enabled provider (~15s wall for
// a dozen); per-provider failures ride inside the payload as {error:{...}}
// entries and the process still exits 0. Detection is a cheap `--version`
// probe: a missing CLI degrades to a cli-missing envelope (fail open) and
// the renderer hides the HUD entirely.

const DETECT_TIMEOUT_MS = 10_000;
// Observed worst-case fetch is ~20s for 12 enabled providers; 90s leaves
// ample room for slow web sources without risking a wedged poll.
const FETCH_TIMEOUT_MS = 90_000;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const WINDOW_LABELS = ["primary", "secondary", "tertiary"] as const;

// Entry-level passthrough keys (detail-view material; values uninterpreted).
const ENTRY_EXTRAS = ["version", "openaiDashboard"] as const;
// Usage-level passthrough keys.
const USAGE_EXTRAS = ["dataConfidence", "accountOrganization", "providerCost", "ampUsage"] as const;

const parsePace = (value: unknown): UsagePace | undefined => {
  if (!isObject(value)) return undefined;
  const stage = asString(value.stage);
  const deltaPercent = asNumber(value.deltaPercent);
  if (stage === undefined || deltaPercent === undefined) return undefined;
  const expectedUsedPercent = asNumber(value.expectedUsedPercent);
  const summary = asString(value.summary);
  return {
    stage,
    deltaPercent,
    ...(expectedUsedPercent !== undefined ? { expectedUsedPercent } : {}),
    ...(typeof value.willLastToReset === "boolean" ? { willLastToReset: value.willLastToReset } : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
};

const parseWindow = (label: UsageWindowLabel, value: unknown, pace: unknown): UsageWindow | undefined => {
  if (!isObject(value)) return undefined;
  const usedPercent = asNumber(value.usedPercent);
  if (usedPercent === undefined) return undefined;
  const windowMinutes = asNumber(value.windowMinutes);
  const resetsAt = asString(value.resetsAt);
  const resetDescription = asString(value.resetDescription);
  const parsedPace = parsePace(pace);
  return {
    label,
    usedPercent,
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(resetDescription !== undefined ? { resetDescription } : {}),
    ...(parsedPace !== undefined ? { pace: parsedPace } : {}),
  };
};

// Tolerant per-entry decode: an entry without a provider name is skipped; an
// entry with an error payload (or an unusable usage payload) degrades to a
// status:"error" quota. One malformed entry never drops the whole fetch.
const parseEntry = (entry: JsonObject, fetchedAt: string): ProviderQuota | undefined => {
  const provider = asString(entry.provider);
  if (provider === undefined) return undefined;
  const source = asString(entry.source) ?? "auto";

  const errorPayload = isObject(entry.error) ? entry.error : undefined;
  if (errorPayload !== undefined) {
    return {
      provider,
      source,
      status: "error",
      error: asString(errorPayload.message) ?? "provider error",
      windows: [],
      updatedAt: fetchedAt,
    };
  }

  const usage = isObject(entry.usage) ? entry.usage : undefined;
  if (usage === undefined) {
    return {
      provider,
      source,
      status: "error",
      error: "unparseable entry: no usage payload",
      windows: [],
      updatedAt: fetchedAt,
    };
  }

  const pace = isObject(entry.pace) ? entry.pace : undefined;
  const windows: UsageWindow[] = [];
  for (const label of WINDOW_LABELS) {
    const window = parseWindow(label, usage[label], pace?.[label]);
    if (window !== undefined) windows.push(window);
  }
  if (Array.isArray(usage.extraRateWindows)) {
    for (const extra of usage.extraRateWindows) {
      if (!isObject(extra)) continue;
      const window = parseWindow("extra", extra.window, undefined);
      if (window === undefined) continue;
      const id = asString(extra.id);
      const title = asString(extra.title);
      windows.push({
        ...window,
        ...(id !== undefined ? { id } : {}),
        ...(title !== undefined ? { title } : {}),
      });
    }
  }

  const identity = isObject(usage.identity) ? usage.identity : undefined;
  const account = asString(usage.accountEmail) ?? (identity !== undefined ? asString(identity.accountEmail) : undefined);
  const plan = asString(usage.loginMethod) ?? (identity !== undefined ? asString(identity.loginMethod) : undefined);

  // Credits: codex `credits.remaining`, else the dashboard's creditsRemaining.
  const dashboard = isObject(entry.openaiDashboard) ? entry.openaiDashboard : undefined;
  const creditsRemaining =
    (isObject(entry.credits) ? asNumber(entry.credits.remaining) : undefined) ??
    (dashboard !== undefined ? asNumber(dashboard.creditsRemaining) : undefined);

  const extras: Record<string, unknown> = {};
  for (const key of ENTRY_EXTRAS) {
    const value = entry[key];
    if (value !== undefined && value !== null) extras[key] = value;
  }
  for (const key of USAGE_EXTRAS) {
    const value = usage[key];
    if (value !== undefined && value !== null) extras[key] = value;
  }

  return {
    provider,
    source,
    status: "ok",
    windows,
    updatedAt: asString(usage.updatedAt) ?? fetchedAt,
    ...(account !== undefined ? { account } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(creditsRemaining !== undefined ? { creditsRemaining } : {}),
    ...(Object.keys(extras).length > 0 ? { extras } : {}),
  };
};

export const parseCodexbarPayload = (payload: unknown, fetchedAt: string): ReadonlyArray<ProviderQuota> => {
  if (!Array.isArray(payload)) return [];
  const quotas: ProviderQuota[] = [];
  for (const entry of payload) {
    if (!isObject(entry)) continue;
    const quota = parseEntry(entry, fetchedAt);
    if (quota !== undefined) quotas.push(quota);
  }
  return quotas;
};

export type CodexbarOutcome =
  | { readonly kind: "ok"; readonly quotas: ReadonlyArray<ProviderQuota> }
  | { readonly kind: "unavailable"; readonly reason: UsageUnavailableReason; readonly error: string };

// Pure envelope (buildTowerBundle pattern): every unavailable mode carries a
// machine-readable reason so the renderer can distinguish "install codexbar"
// (hide) from a transient fetch failure (also hidden today, badge tomorrow).
export const buildCodexbarSnapshot = (fetchedAt: string, outcome: CodexbarOutcome): UsageSnapshot =>
  outcome.kind === "ok"
    ? { source: "codexbar", fetchedAt, ok: true, quotas: outcome.quotas }
    : { source: "codexbar", fetchedAt, ok: false, reason: outcome.reason, error: outcome.error, quotas: [] };

// Codex multi-account: the default multi-provider call returns only the
// active Codex account. Account selection flags require a single provider, so
// we fan a second call with --provider codex --all-accounts and splice codex
// rows. Other providers stay on the multi-provider payload.
export const mergeCodexAllAccounts = (
  enabled: ReadonlyArray<ProviderQuota>,
  codexAccounts: ReadonlyArray<ProviderQuota>,
): ReadonlyArray<ProviderQuota> => {
  if (codexAccounts.length === 0) return enabled;
  const rest = enabled.filter((quota) => quota.provider.toLowerCase() !== "codex");
  return [...rest, ...codexAccounts];
};

const parseUsageStdout = (
  stdout: string,
  fetchedAt: string,
): { readonly ok: true; readonly quotas: ReadonlyArray<ProviderQuota> } | { readonly ok: false; readonly reason: UsageUnavailableReason; readonly error: string } => {
  const parsed = parseJson<unknown>(stdout);
  if (parsed === undefined) {
    return { ok: false, reason: "parse-error", error: "codexbar returned non-JSON output" };
  }
  return { ok: true, quotas: parseCodexbarPayload(parsed, fetchedAt) };
};

// Last primary (enabled-providers) quotas — enrich re-merges multi-account
// codex on top without re-running the full multi-provider poll.
let lastPrimaryQuotas: ReadonlyArray<ProviderQuota> = [];
let cliPresent: boolean | undefined;

const detectCli = async (): Promise<boolean> => {
  if (cliPresent !== undefined) return cliPresent;
  const detected = await runCli("codexbar", ["--version"], DETECT_TIMEOUT_MS);
  cliPresent = detected.ok;
  return cliPresent;
};

// Primary path only: one `usage --json` call. Multi-account is `enrich` so the
// HUD can paint as soon as the first payload lands instead of waiting on a
// second slow all-accounts fan-out.
const fetchCodexbar = async (): Promise<UsageSnapshot> => {
  const fetchedAt = new Date().toISOString();
  try {
    if (!(await detectCli())) {
      return buildCodexbarSnapshot(fetchedAt, {
        kind: "unavailable",
        reason: "cli-missing",
        error: "codexbar CLI not found on PATH",
      });
    }

    // codexbar often exits 1 when *some* providers error while still printing
    // a full JSON array on stdout — recover from stdout before hard-fail.
    const enabledResult = await runCli("codexbar", ["usage", "--json"], FETCH_TIMEOUT_MS);
    const enabledParsed = enabledResult.stdout.trim()
      ? parseUsageStdout(enabledResult.stdout, fetchedAt)
      : null;
    if (!enabledParsed || !enabledParsed.ok) {
      return buildCodexbarSnapshot(fetchedAt, {
        kind: "unavailable",
        reason: enabledResult.stdout.trim()
          ? (enabledParsed && !enabledParsed.ok ? enabledParsed.reason : "parse-error")
          : enabledResult.ok
            ? "parse-error"
            : "cli-error",
        error:
          (enabledParsed && !enabledParsed.ok ? enabledParsed.error : undefined) ??
          enabledResult.error ??
          "codexbar usage failed",
      });
    }

    lastPrimaryQuotas = enabledParsed.quotas;
    return buildCodexbarSnapshot(fetchedAt, {
      kind: "ok",
      quotas: enabledParsed.quotas,
    });
  } catch (error) {
    return buildCodexbarSnapshot(fetchedAt, {
      kind: "unavailable",
      reason: "cli-error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// Second stage: every managed Codex account. Best-effort; never undoes a good
// primary paint if this call fails or is empty.
const enrichCodexbar = async (): Promise<UsageSnapshot | undefined> => {
  if (lastPrimaryQuotas.length === 0) return undefined;
  const fetchedAt = new Date().toISOString();
  try {
    if (!(await detectCli())) return undefined;
    const result = await runCli(
      "codexbar",
      ["usage", "--json", "--provider", "codex", "--all-accounts"],
      FETCH_TIMEOUT_MS,
    );
    if (!result.stdout.trim()) return undefined;
    const parsed = parseUsageStdout(result.stdout, fetchedAt);
    if (!parsed.ok) return undefined;
    const codexAccounts = parsed.quotas.filter((quota) => quota.provider.toLowerCase() === "codex");
    if (codexAccounts.length === 0) return undefined;
    return buildCodexbarSnapshot(fetchedAt, {
      kind: "ok",
      quotas: mergeCodexAllAccounts(lastPrimaryQuotas, codexAccounts),
    });
  } catch {
    return undefined;
  }
};

export const codexbarSource: UsageSource = {
  id: "codexbar",
  detect: Effect.promise(detectCli),
  fetch: Effect.promise(fetchCodexbar),
  enrich: Effect.promise(enrichCodexbar),
};

// Registry contribution. The composition root (live.ts) merges this with the
// service layer; a future vellum-native source appends to this array.
export const CodexBarSourcesLive = Layer.succeed(UsageSources, [codexbarSource]);
