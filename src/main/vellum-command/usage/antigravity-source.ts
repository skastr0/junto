import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { ProviderQuota, UsageSnapshot, UsageWindow } from "@shared/usage";
import { rethrowIfCancelled, timeoutSignal, throwIfAborted } from "../access-signal";
import { runCli } from "../adapters/exec";
import type { UsageSource } from "./usage-source";

// Native Google Antigravity usage. Two planes for v1:
//   1. Localhost probes of a running language_server (desktop app / IDE /
//      warm `agy` CLI server) — gRPC-web JSON endpoints under
//      /exa.language_server_pb.LanguageServerService/, CSRF-token header
//      X-Codeium-Csrf-Token taken from the server's own --csrf_token flag
//      (the CLI server needs none).
//   2. Warm `agy` CLI sessions — same tokenless endpoints against the CLI's
//      already-running embedded server.
// Excluded for v1: the cloudcode-pa.googleapis.com OAuth plane and extracting
// OAuth secrets from installed .app binaries (machine safety). Offline
// fallback counts local conversation databases as an extras-only signal.
// Every failure folds into a TOTAL envelope; nothing throws. Secrets (CSRF
// tokens) are never logged and are redacted from error strings.

const SERVICE_ROOT = "/exa.language_server_pb.LanguageServerService";
const QUOTA_SUMMARY_PATH = `${SERVICE_ROOT}/RetrieveUserQuotaSummary`;
const USER_STATUS_PATH = `${SERVICE_ROOT}/GetUserStatus`;
const COMMAND_MODEL_CONFIG_PATH = `${SERVICE_ROOT}/GetCommandModelConfigs`;
const FETCH_BUDGET_MS = 10_000;
const PS_TIMEOUT_MS = 4_000;
const LSOF_TIMEOUT_MS = 4_000;
const IDENTITY_TIMEOUT_MS = 1_000;
const MAX_PROBED_PROCESSES = 4;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const trimmedNonEmpty = (value: unknown): string | undefined => {
  const text = asString(value)?.trim();
  return text !== undefined && text !== "" ? text : undefined;
};

/** Replace every secret occurrence so tokens never reach logs or envelopes. */
export const redactSecrets = (
  message: string,
  secrets: ReadonlyArray<string>,
): string => {
  let out = message;
  for (const secret of secrets) {
    if (secret.length < 4) continue; // trivially short strings would mangle copy
    while (out.includes(secret)) out = out.replace(secret, "***");
  }
  return out;
};

/** Extract `--flag VALUE` or `--flag=VALUE` from a command line. */
export const extractFlagValue = (flag: string, command: string): string | undefined => {
  const pattern = new RegExp(`${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[=\\s]+([^\\s]+)`, "i");
  return pattern.exec(command)?.[1];
};

export type AntigravityProcessKind = "app" | "ide" | "cli";

/**
 * Classify a command line as the Antigravity app language server, IDE
 * extension language server, or the `agy` CLI language server.
 */
export const classifyAntigravityProcess = (command: string): AntigravityProcessKind | undefined => {
  const lower = command.toLowerCase();
  const isLanguageServer = /(^|[/\\])language(?:_|-)server(?:[_-][a-z0-9]+)*(?:\.exe)?(\s|$)/.test(lower);
  const isAntigravity =
    (lower.includes("--app_data_dir") && lower.includes("antigravity")) ||
    lower.includes("antigravity.app/") ||
    lower.includes("/gemini.app/") ||
    lower.includes("antigravity ide.app/") ||
    lower.includes("/antigravity/");
  if (isLanguageServer && isAntigravity) {
    const isIde =
      lower.includes("antigravity ide.app/") ||
      lower.includes("--app_data_dir antigravity-ide") ||
      lower.includes("--app_data_dir=antigravity-ide") ||
      lower.includes("/extensions/antigravity/bin/language_server");
    return isIde ? "ide" : "app";
  }
  if (/(^|[/\\])(antigravity-cli|antigravity_cli)([\s/\\]|$)/.test(lower)) return "cli";
  if (/(^|[/\\])agy(\s|$)/.test(lower)) return "cli";
  return undefined;
};

/**
 * Resolve the CSRF token a matched process must present, or undefined when
 * the match must be skipped. Desktop/IDE servers require --csrf_token (a
 * tokenless match is skipped so a later valid server can win); the CLI
 * server needs none, so an empty token is allowed there.
 */
export const resolveProcessCsrfToken = (
  kind: AntigravityProcessKind,
  command: string,
): string | undefined => {
  const token = extractFlagValue("--csrf_token", command);
  if (token !== undefined) return token;
  return kind === "cli" ? "" : undefined;
};

export interface ProcessInfo {
  readonly pid: number;
  readonly kind: AntigravityProcessKind;
  readonly csrfToken: string;
}

/** Parse `ps -ax -o pid=,command=` output into probed process candidates. */
export const parseAntigravityProcesses = (output: string): ProcessInfo[] => {
  const results: ProcessInfo[] = [];
  let sawTokenlessDesktop = false;
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceAt = trimmed.indexOf(" ");
    if (spaceAt <= 0) continue;
    const pid = Number(trimmed.slice(0, spaceAt));
    if (!Number.isInteger(pid)) continue;
    const command = trimmed.slice(spaceAt + 1);
    const kind = classifyAntigravityProcess(command);
    if (kind === undefined) continue;
    const token = resolveProcessCsrfToken(kind, command);
    if (token === undefined) {
      sawTokenlessDesktop = true;
      continue;
    }
    results.push({ pid, kind, csrfToken: token });
  }
  // Desktop servers (with tokens) rank ahead of tokenless CLI servers.
  results.sort((a, b) => Number(a.kind === "cli") - Number(b.kind === "cli"));
  if (results.length === 0 && sawTokenlessDesktop) return [];
  return results.slice(0, MAX_PROBED_PROCESSES);
};

/** Parse `lsof -nP -iTCP -sTCP:LISTEN` output into sorted listening ports. */
export const parseListeningPorts = (output: string): number[] => {
  const ports = new Set<number>();
  for (const match of output.matchAll(/:(\d+)\s+\(LISTEN\)/g)) {
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
};

/** Epoch seconds/milliseconds or ISO8601 to ISO, tolerant of garbage. */
export const parseResetTime = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  const text = asString(value);
  if (text === undefined || text.trim() === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(text.trim())) {
    const num = Number(text.trim());
    const ms = num < 1e12 ? num * 1000 : num;
    return new Date(ms).toISOString();
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
};

export type QuotaBucketKind = "session" | "weekly" | "other";

const SESSION_ALIASES = new Set(["session", "5h", "5-hour", "five hour", "five-hour"]);

/** 5-hour vs weekly cadence from bucket id/display name aliases. */
export const quotaBucketKind = (...labels: ReadonlyArray<string>): QuotaBucketKind => {
  const candidates = new Set<string>();
  for (const raw of labels) {
    const normalized = raw.trim().toLowerCase().replaceAll("_", "-");
    if (normalized === "") continue;
    const stripped = normalized.endsWith(" limit") ? normalized.slice(0, -" limit".length) : normalized;
    candidates.add(normalized);
    candidates.add(stripped);
    for (const alias of [...SESSION_ALIASES, "weekly"]) {
      if (stripped.endsWith(`-${alias}`)) {
        candidates.add(alias);
      }
    }
  }
  for (const alias of SESSION_ALIASES) {
    if (candidates.has(alias)) return "session";
  }
  return candidates.has("weekly") ? "weekly" : "other";
};

export interface SummaryBucket {
  readonly bucketId: string;
  readonly displayName: string;
  readonly remainingFraction?: number;
  readonly resetTime?: string;
  readonly resetDescription?: string;
  readonly disabled: boolean;
}

export interface SummaryGroup {
  readonly displayName: string;
  readonly buckets: ReadonlyArray<SummaryBucket>;
}

export interface DecodedQuotaSummary {
  readonly groups: ReadonlyArray<SummaryGroup>;
}

const decodeRemainingOneof = (remaining: unknown): number | undefined => {
  if (!isObject(remaining)) return undefined;
  if (remaining.case === "remainingFraction") return asNumber(remaining.value);
  return asNumber(remaining.remainingFraction);
};

const decodeBucket = (payload: unknown): SummaryBucket | undefined => {
  if (!isObject(payload)) return undefined;
  const bucketId = trimmedNonEmpty(payload.bucketId);
  if (bucketId === undefined) return undefined;
  const remainingFraction =
    asNumber(payload.remainingFraction) ?? decodeRemainingOneof(payload.remaining);
  return {
    bucketId,
    displayName: trimmedNonEmpty(payload.displayName) ?? bucketId,
    ...(remainingFraction !== undefined ? { remainingFraction } : {}),
    ...(parseResetTime(payload.resetTime) !== undefined
      ? { resetTime: parseResetTime(payload.resetTime) }
      : {}),
    ...(trimmedNonEmpty(payload.description) !== undefined
      ? { resetDescription: trimmedNonEmpty(payload.description) }
      : {}),
    disabled: payload.disabled === true,
  };
};

/**
 * Pure decode of RetrieveUserQuotaSummary. Payload accepted under
 * `response` | `summary` | root `groups` (protobuf JSON wrappers vary).
 */
export const decodeQuotaSummary = (payload: unknown): DecodedQuotaSummary | undefined => {
  if (!isObject(payload)) return undefined;
  const code = payload.code;
  const codeOk =
    code === undefined ||
    code === 0 ||
    (typeof code === "string" && ["ok", "success", "0"].includes(code.toLowerCase()));
  if (!codeOk) return undefined;
  const container = isObject(payload.response)
    ? payload.response
    : isObject(payload.summary)
      ? payload.summary
      : payload;
  const groupPayloads = Array.isArray(container.groups) ? container.groups : [];
  const groups: SummaryGroup[] = [];
  for (const groupPayload of groupPayloads) {
    if (!isObject(groupPayload)) continue;
    const bucketPayloads = Array.isArray(groupPayload.buckets) ? groupPayload.buckets : [];
    const buckets = bucketPayloads
      .map(decodeBucket)
      .filter((bucket): bucket is SummaryBucket => bucket !== undefined);
    if (buckets.length === 0) continue;
    groups.push({
      displayName: trimmedNonEmpty(groupPayload.displayName) ?? "Quota",
      buckets,
    });
  }
  return groups.length > 0 ? { groups } : undefined;
};

const clampPercent = (value: number): number => Math.max(0, Math.min(100, Math.round(value * 100) / 100));

const groupTitle = (name: string): string => {
  const lower = name.toLowerCase();
  if (lower.includes("gemini")) return "Gemini";
  if (lower.includes("claude") || lower.includes("gpt")) return "Claude/GPT";
  return name.trim() === "" ? "Quota" : name.trim();
};

const bucketTitle = (bucket: SummaryBucket): string => {
  switch (quotaBucketKind(bucket.bucketId, bucket.displayName)) {
    case "session":
      return "5-hour";
    case "weekly":
      return "weekly";
    case "other":
      return bucket.displayName;
  }
};

/**
 * Quota-summary buckets to labeled usage windows. Buckets lacking a numeric
 * remainingFraction are omitted rather than painted as fake 0% used; they
 * stay visible through the quota extras passthrough.
 */
export const windowsFromQuotaSummary = (decoded: DecodedQuotaSummary): UsageWindow[] => {
  const groupRank = (name: string): number => {
    const lower = name.toLowerCase();
    if (lower.includes("gemini")) return 0;
    if (lower.includes("claude") || lower.includes("gpt")) return 1;
    return 2;
  };
  const kindRank = (kind: QuotaBucketKind): number =>
    kind === "session" ? 0 : kind === "weekly" ? 1 : 2;

  const sortedGroups = [...decoded.groups].sort(
    (a, b) => groupRank(a.displayName) - groupRank(b.displayName),
  );

  const windows: UsageWindow[] = [];
  for (const group of sortedGroups) {
    const sortedBuckets = [...group.buckets].sort((a, b) => {
      const rankDiff =
        kindRank(quotaBucketKind(a.bucketId, a.displayName)) -
        kindRank(quotaBucketKind(b.bucketId, b.displayName));
      return rankDiff !== 0 ? rankDiff : a.bucketId.localeCompare(b.bucketId);
    });
    for (const bucket of sortedBuckets) {
      if (bucket.disabled || bucket.remainingFraction === undefined) continue;
      const kind = quotaBucketKind(bucket.bucketId, bucket.displayName);
      const resetsAt = bucket.resetTime;
      windows.push({
        label: "extra",
        id: `antigravity-quota-summary-${bucket.bucketId}`,
        title: `${groupTitle(group.displayName)} ${bucketTitle(bucket)}`,
        usedPercent: clampPercent(100 - bucket.remainingFraction * 100),
        ...(kind === "session" ? { windowMinutes: 300 } : kind === "weekly" ? { windowMinutes: 10080 } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        ...(bucket.resetDescription !== undefined
          ? { resetDescription: bucket.resetDescription }
          : resetsAt !== undefined
            ? { resetDescription: `resets ${resetsAt}` }
            : {}),
      });
    }
  }
  return windows;
};

/**
 * Promote the most-exhausted Gemini window to primary and the most-exhausted
 * Claude/GPT window to secondary; everything else stays extra.
 */
export const assignPoolLabels = (windows: UsageWindow[]): UsageWindow[] => {
  const worstMatching = (predicate: (title: string) => boolean): UsageWindow | undefined =>
    windows
      .filter((w) => predicate(w.title?.toLowerCase() ?? ""))
      .reduce<UsageWindow | undefined>(
        (worst, w) => (worst === undefined || w.usedPercent > worst.usedPercent ? w : worst),
        undefined,
      );
  const primary = worstMatching((title) => title.includes("gemini"));
  const secondary = worstMatching((title) => title.includes("claude") || title.includes("gpt"));
  return windows.map((w) => {
    if (primary !== undefined && w.id === primary.id) return { ...w, label: "primary" as const };
    if (secondary !== undefined && w.id === secondary.id) return { ...w, label: "secondary" as const };
    return w;
  });
};

export interface ModelQuotaRow {
  readonly model: string;
  readonly label: string;
  readonly remainingFraction?: number;
  readonly resetTime?: string;
}

export interface DecodedUserStatus {
  readonly email?: string;
  readonly plan?: string;
  readonly modelQuotas: ReadonlyArray<ModelQuotaRow>;
}

type ModelFamily = "claude" | "gpt" | "geminiPro" | "geminiFlash" | "unknown";

const modelFamily = (text: string): ModelFamily => {
  const lower = text.toLowerCase();
  if (lower.includes("claude")) return "claude";
  if (lower.includes("gpt") || lower.includes("openai")) return "gpt";
  if (lower.includes("gemini") && lower.includes("pro")) return "geminiPro";
  if (lower.includes("gemini") && lower.includes("flash")) return "geminiFlash";
  return "unknown";
};

const decodeModelQuotaRows = (configs: unknown): ModelQuotaRow[] => {
  if (!Array.isArray(configs)) return [];
  const rows: ModelQuotaRow[] = [];
  for (const entry of configs) {
    if (!isObject(entry)) continue;
    const alias = isObject(entry.modelOrAlias) ? entry.modelOrAlias : undefined;
    const model = trimmedNonEmpty(alias?.model) ?? trimmedNonEmpty(entry.model);
    if (model === undefined) continue;
    const quotaInfo = isObject(entry.quotaInfo) ? entry.quotaInfo : undefined;
    const remainingFraction = quotaInfo !== undefined ? asNumber(quotaInfo.remainingFraction) : undefined;
    rows.push({
      model,
      label: trimmedNonEmpty(entry.label) ?? model,
      ...(remainingFraction !== undefined ? { remainingFraction } : {}),
      ...(quotaInfo !== undefined && parseResetTime(quotaInfo.resetTime) !== undefined
        ? { resetTime: parseResetTime(quotaInfo.resetTime) }
        : {}),
    });
  }
  return rows;
};

/** Pure decode of GetUserStatus (identity + legacy cascade model quotas). */
export const decodeUserStatus = (payload: unknown): DecodedUserStatus | undefined => {
  if (!isObject(payload)) return undefined;
  const userStatus = isObject(payload.userStatus) ? payload.userStatus : undefined;
  if (userStatus === undefined) return undefined;
  const tierName =
    isObject(userStatus.userTier) === true ? trimmedNonEmpty(userStatus.userTier.name) : undefined;
  const planInfo =
    isObject(userStatus.planStatus) && isObject(userStatus.planStatus.planInfo)
      ? userStatus.planStatus.planInfo
      : undefined;
  const plan =
    tierName ??
    (planInfo !== undefined
      ? (trimmedNonEmpty(planInfo.planDisplayName) ??
        trimmedNonEmpty(planInfo.displayName) ??
        trimmedNonEmpty(planInfo.productName) ??
        trimmedNonEmpty(planInfo.planName))
      : undefined);
  const cascade = isObject(userStatus.cascadeModelConfigData) ? userStatus.cascadeModelConfigData : undefined;
  const modelQuotas = cascade !== undefined ? decodeModelQuotaRows(cascade.clientModelConfigs) : [];
  const email = trimmedNonEmpty(userStatus.email);
  if (email === undefined && plan === undefined && modelQuotas.length === 0) return undefined;
  return {
    ...(email !== undefined ? { email } : {}),
    ...(plan !== undefined ? { plan } : {}),
    modelQuotas,
  };
};

/** Pure decode of GetCommandModelConfigs (final legacy fallback shape). */
export const decodeCommandModelConfigs = (payload: unknown): ModelQuotaRow[] | undefined => {
  if (!isObject(payload)) return undefined;
  const rows = decodeModelQuotaRows(payload.clientModelConfigs);
  return rows.length > 0 ? rows : undefined;
};

/**
 * Legacy model quotas to pool windows: the most-constrained Gemini quota is
 * primary, the most-constrained Claude/GPT quota is secondary, and each
 * decodable model also surfaces as an extra window.
 */
export const quotaFromModelQuotas = (
  rows: ReadonlyArray<ModelQuotaRow>,
  fetchedAt: string,
  source: string,
  identity?: { readonly email?: string; readonly plan?: string },
): ProviderQuota | undefined => {
  const poolRepresentative = (families: ReadonlyArray<ModelFamily>): ModelQuotaRow | undefined =>
    rows
      .filter((row) => row.remainingFraction !== undefined && families.includes(modelFamily(row.model)))
      .reduce<ModelQuotaRow | undefined>((worst, row) => {
        if (worst === undefined) return row;
        return (row.remainingFraction ?? 1) < (worst.remainingFraction ?? 1) ? row : worst;
      }, undefined);

  const gemini = poolRepresentative(["geminiPro", "geminiFlash"]);
  const claudeGpt = poolRepresentative(["claude", "gpt"]);

  const poolWindow = (row: ModelQuotaRow, label: "primary" | "secondary"): UsageWindow => ({
    label,
    id: `antigravity-pool-${label}`,
    title: label === "primary" ? "Gemini pool" : "Claude/GPT pool",
    usedPercent: clampPercent(100 - (row.remainingFraction ?? 0) * 100),
    ...(row.resetTime !== undefined ? { resetsAt: row.resetTime } : {}),
  });

  const extras = rows
    .filter((row) => row.remainingFraction !== undefined)
    .map<UsageWindow>((row) => ({
      label: "extra",
      id: row.model,
      title: row.label,
      usedPercent: clampPercent(100 - (row.remainingFraction ?? 0) * 100),
      ...(row.resetTime !== undefined ? { resetsAt: row.resetTime } : {}),
    }));

  const windows: UsageWindow[] = [
    ...(gemini !== undefined ? [poolWindow(gemini, "primary")] : []),
    ...(claudeGpt !== undefined ? [poolWindow(claudeGpt, "secondary")] : []),
    ...extras,
  ];
  if (windows.length === 0) return undefined;
  return {
    provider: "antigravity",
    source,
    status: "ok",
    windows,
    updatedAt: fetchedAt,
    ...(identity?.email !== undefined ? { account: identity.email } : {}),
    ...(identity?.plan !== undefined ? { plan: identity.plan } : {}),
    extras: {
      capability: "model-quotas",
      models: rows.map((row) => ({
        model: row.model,
        label: row.label,
        ...(row.remainingFraction !== undefined ? { remainingFraction: row.remainingFraction } : {}),
      })),
    },
  };
};

/** Offline fallback: count conversation .db files under the Gemini home. */
export const countOfflineConversations = (
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): number => {
  const override = env["GEMINI_CLI_HOME"]?.trim();
  const base = override !== undefined && override !== "" ? override : join(home, ".gemini");
  let count = 0;
  for (const dir of [
    join(base, "antigravity-cli", "conversations"),
    join(base, "antigravity", "conversations"),
  ]) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    count += entries.filter((name) => name.toLowerCase().endsWith(".db")).length;
  }
  return count;
};

export interface LocalEndpoint {
  readonly scheme: "https" | "http";
  readonly port: number;
  readonly csrfToken: string;
  readonly requiresCsrf: boolean;
}

export const endpointsForPorts = (
  ports: ReadonlyArray<number>,
  csrfToken: string,
  requiresCsrf: boolean,
): LocalEndpoint[] =>
  ports.flatMap((port) =>
    (["https", "http"] as const).map((scheme) => ({
      scheme,
      port,
      csrfToken,
      requiresCsrf,
    })),
  );

export type SendFn = (
  endpoint: LocalEndpoint,
  path: string,
  body: unknown,
  timeoutMs: number,
) => Promise<unknown>;

export type ProbeOutcome =
  | { readonly kind: "ok"; readonly quota: ProviderQuota }
  | { readonly kind: "error"; readonly error: string };

const hasUsableBuckets = (decoded: DecodedQuotaSummary): boolean =>
  decoded.groups.some((group) =>
    group.buckets.some((bucket) => !bucket.disabled && bucket.remainingFraction !== undefined),
  );

/**
 * Endpoint orchestration (fetch order): quota summary first
 * (with a best-effort GetUserStatus identity merge), then legacy GetUserStatus
 * model quotas, then GetCommandModelConfigs. Injected `send` keeps this pure
 * and unit-testable.
 */
export const probeEndpoints = async (
  send: SendFn,
  endpoints: ReadonlyArray<LocalEndpoint>,
  fetchedAt: string,
  source: string,
): Promise<ProbeOutcome> => {
  if (endpoints.length === 0) return { kind: "error", error: "no reachable Antigravity endpoint" };
  let lastError = "";

  const attempt = async (path: string, body: unknown, timeoutMs: number): Promise<unknown> => {
    let lastUnknown: unknown;
    for (const endpoint of endpoints) {
      try {
        return await send(endpoint, path, body, timeoutMs);
      } catch (error) {
        lastUnknown = error;
      }
    }
    throw lastUnknown instanceof Error ? lastUnknown : new Error(String(lastUnknown ?? "request failed"));
  };

  // Tier 1: quota summary (+ optional identity merge).
  try {
    const payload = await attempt(QUOTA_SUMMARY_PATH, { forceRefresh: true }, 5_000);
    const decoded = decodeQuotaSummary(payload);
    if (decoded === undefined || !hasUsableBuckets(decoded)) {
      lastError = "quota summary had no usable quota buckets";
    } else {
      let identity: { readonly email?: string; readonly plan?: string } | undefined;
      try {
        const status = await send(endpoints[0]!, USER_STATUS_PATH, defaultRequestBody(), IDENTITY_TIMEOUT_MS);
        identity = decodeUserStatus(status);
      } catch {
        // Identity is best-effort; the summary alone still paints bars.
      }
      const windows = assignPoolLabels(windowsFromQuotaSummary(decoded));
      const quota: ProviderQuota = {
        provider: "antigravity",
        source,
        status: "ok",
        windows,
        updatedAt: fetchedAt,
        ...(identity?.email !== undefined ? { account: identity.email } : {}),
        ...(identity?.plan !== undefined ? { plan: identity.plan } : {}),
        extras: {
          capability: "quota-summary",
          groups: decoded.groups.map((group) => ({
            displayName: group.displayName,
            buckets: group.buckets.map((bucket) => ({
              bucketId: bucket.bucketId,
              displayName: bucket.displayName,
              disabled: bucket.disabled,
              ...(bucket.remainingFraction !== undefined
                ? { remainingFraction: bucket.remainingFraction }
                : {}),
            })),
          })),
        },
      };
      return { kind: "ok", quota };
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }

  // Tier 2: legacy GetUserStatus cascade model quotas (also carries identity).
  try {
    const payload = await attempt(USER_STATUS_PATH, defaultRequestBody(), 4_000);
    const decoded = decodeUserStatus(payload);
    if (decoded !== undefined) {
      const quota = quotaFromModelQuotas(decoded.modelQuotas, fetchedAt, source, decoded);
      if (quota !== undefined) return { kind: "ok", quota };
      lastError = "user status carried no usable model quotas";
    } else {
      lastError = "user status was not decodable";
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }

  // Tier 3: GetCommandModelConfigs (legacy shape, no identity).
  try {
    const payload = await attempt(COMMAND_MODEL_CONFIG_PATH, defaultRequestBody(), 4_000);
    const rows = decodeCommandModelConfigs(payload);
    if (rows !== undefined) {
      const quota = quotaFromModelQuotas(rows, fetchedAt, source);
      if (quota !== undefined) return { kind: "ok", quota };
    }
    lastError = "command model configs carried no usable quotas";
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }

  return { kind: "error", error: lastError };
};

const defaultRequestBody = (): JsonObject => ({
  metadata: {
    ideName: "antigravity",
    extensionName: "antigravity",
    ideVersion: "unknown",
    locale: "en",
  },
});

const requestJson = async (
  endpoint: LocalEndpoint,
  path: string,
  body: unknown,
  timeoutMs: number,
  secrets: ReadonlyArray<string>,
  signal?: AbortSignal,
): Promise<unknown> => {
  let response: Response;
  try {
    response = await globalThis.fetch(`${endpoint.scheme}://127.0.0.1:${endpoint.port}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        ...(endpoint.requiresCsrf && endpoint.csrfToken !== ""
          ? { "X-Codeium-Csrf-Token": endpoint.csrfToken }
          : {}),
      },
      body: JSON.stringify(body),
      signal: timeoutSignal(timeoutMs, signal),
    });
  } catch (error) {
    // Abort/timeouts and TLS failures degrade to plain messages; never echo
    // header material back.
    throw new Error(redactSecrets(error instanceof Error ? error.message : String(error), secrets));
  }
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {
      detail = "";
    }
    const authFlavored =
      response.status === 401 || response.status === 403
        ? " — local server rejected Vellum Command (auth)"
        : "";
    throw new Error(
      redactSecrets(`HTTP ${response.status}${authFlavored}: ${detail}` || `HTTP ${response.status}`, secrets),
    );
  }
  return response.json();
};

const lsofBinary = (): string | undefined => {
  for (const candidate of ["/usr/sbin/lsof", "/usr/bin/lsof"]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
};

const listeningPortsForPid = async (pid: number, signal?: AbortSignal): Promise<number[]> => {
  const lsof = lsofBinary();
  if (lsof === undefined) return [];
  const result = await runCli(
    lsof,
    ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid)],
    LSOF_TIMEOUT_MS,
    signal,
  );
  return result.ok ? parseListeningPorts(result.stdout) : [];
};

export type AntigravityOutcome =
  | { readonly kind: "ok"; readonly quotas: ReadonlyArray<ProviderQuota>; readonly confidence: "live" | "derived" }
  | {
      readonly kind: "unavailable";
      readonly reason: "cli-error" | "parse-error" | "source-missing";
      readonly error: string;
    };

export const buildAntigravitySnapshot = (fetchedAt: string, outcome: AntigravityOutcome): UsageSnapshot =>
  outcome.kind === "ok"
    ? {
        source: "antigravity",
        fetchedAt,
        ok: true,
        dataConfidence: outcome.confidence,
        quotas: outcome.quotas,
      }
    : {
        source: "antigravity",
        fetchedAt,
        ok: false,
        reason: outcome.reason,
        error: outcome.error,
        quotas: [],
      };

const fetchAntigravity = async (signal?: AbortSignal): Promise<UsageSnapshot> => {
  const fetchedAt = new Date().toISOString();
  try {
    const secrets: string[] = [];
    let probeError = "";

    const ps = await runCli("/bin/ps", ["-ax", "-o", "pid=,command="], PS_TIMEOUT_MS, signal);
    const processes = ps.ok ? parseAntigravityProcesses(ps.stdout) : [];

    for (const info of processes) {
      throwIfAborted(signal);
      if (info.csrfToken.length >= 4) secrets.push(info.csrfToken);
      const ports = await listeningPortsForPid(info.pid, signal);
      if (ports.length === 0) continue;
      const endpoints = endpointsForPorts(ports, info.csrfToken, info.kind !== "cli");
      const outcome = await probeEndpoints(
        (endpoint, path, body, timeoutMs) =>
          requestJson(endpoint, path, body, timeoutMs, secrets, signal),
        endpoints,
        fetchedAt,
        info.kind === "cli" ? "cli" : "local-server",
      );
      if (outcome.kind === "ok") {
        return buildAntigravitySnapshot(fetchedAt, { kind: "ok", quotas: [outcome.quota], confidence: "live" });
      }
      probeError = outcome.error;
    }

    throwIfAborted(signal);
    // Offline fallback: local conversation databases as an extras-only signal
    // so the HUD can show honest derived presence instead of hiding entirely.
    const conversations = countOfflineConversations();
    if (conversations > 0) {
      return buildAntigravitySnapshot(fetchedAt, {
        kind: "ok",
        confidence: "derived",
        quotas: [
          {
            provider: "antigravity",
            source: "local-file",
            status: "ok",
            windows: [],
            updatedAt: fetchedAt,
            extras: {
              capability: "offline-presence",
              partial: true,
              note: "no live quota probe available - local conversation count only",
              conversations,
            },
          },
        ],
      });
    }

    return buildAntigravitySnapshot(fetchedAt, {
      kind: "unavailable",
      reason: processes.length === 0 ? "source-missing" : "cli-error",
      error:
        processes.length === 0
          ? "no Antigravity language server running - open Antigravity or run the agy CLI to enable live quota reads"
          : redactSecrets(probeError, secrets),
    });
  } catch (error) {
    rethrowIfCancelled(error, signal);
    return buildAntigravitySnapshot(fetchedAt, {
      kind: "unavailable",
      reason: "cli-error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const detectAntigravity = async (): Promise<boolean> => {
  try {
    return existsSync(join(homedir(), ".gemini"));
  } catch {
    return false;
  }
};

/** Capability note for doctor / HUD partial labeling. */
export const ANTIGRAVITY_LIMITS_STATUS =
  "live - localhost language_server probes (quota summary, user status, command model configs) plus warm agy CLI reuse; remote OAuth plane excluded for v1";

export const antigravitySource: UsageSource = {
  id: "antigravity",
  detect: Effect.promise(detectAntigravity),
  fetch: Effect.promise(fetchAntigravity),
};
