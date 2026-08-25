import { Effect } from "effect";
import { parseJson } from "../adapters/exec";
import type { ProviderQuota, UsageSnapshot, UsageUnavailableReason, UsageWindow } from "@shared/usage";
import type { UsageSource } from "./usage-source";

// Native Ollama Cloud usage source (ollama.com hosted inference).
//
// Two strategies, tried in order:
//
//   (a) WEB — GET https://ollama.com/settings with an ollama.com session
//       cookie (operator settings first, then env OLLAMA_SESSION_COOKIE /
//       OLLAMA_COOKIE, raw Cookie header
//       or bare session token). The settings page embeds the plan name after
//       a "Cloud Usage" label, the account email in #header-email, and usage
//       bars labeled "Session usage" / "Hourly usage" (5h window) and
//       "Weekly usage". Percent comes from "N% used" or the bar width, and
//       resets come from data-time ISO stamps. A redirect to /signin,
//       signin.ollama.com, or WorkOS authorize means the cookie is expired.
//   (b) API KEY — env OLLAMA_API_KEY / OLLAMA_KEY against
//       POST https://ollama.com/api/web_search (validation; 400 is accepted
//       because the empty probe query is rejected while the key is valid) and
//       GET https://ollama.com/api/tags (model catalog count). The public API
//       exposes NO quota/credit surface, so this tier is an honest identity
//       check only - no windows are fabricated.
//
// Ollama Cloud publishes no credits or dollar cost anywhere we read, so
// creditsRemaining is never set. Every failure folds into the envelope.

const SETTINGS_URL = "https://ollama.com/settings";
const TAGS_URL = "https://ollama.com/api/tags";
const WEB_SEARCH_URL = "https://ollama.com/api/web_search";
const USAGE_FETCH_TIMEOUT_MS = 10_000;

const SESSION_WINDOW_MINUTES = 300;
const WEEKLY_WINDOW_MINUTES = 10_080;
const DEFAULT_SESSION_COOKIE_NAME = "__Secure-session";

/** Recognized ollama.com session cookie names. */
const SESSION_COOKIE_NAMES: ReadonlyArray<string> = [
  DEFAULT_SESSION_COOKIE_NAME,
  "session",
  "ollama_session",
  "__Host-ollama_session",
  "wos-session",
  "__Secure-next-auth.session-token",
  "next-auth.session-token",
];

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

/**
 * Scrub every known secret value out of an error string. Secrets never reach
 * logs or envelopes; this runs defensively on every error path.
 */
export const redactSecrets = (message: string, secrets: ReadonlyArray<string>): string => {
  let out = message;
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed.length < 8) continue; // too short to be the credential itself
    out = out.split(trimmed).join("[redacted]");
  }
  return out;
};

/**
 * Normalize a user-supplied cookie credential into a Cookie header. Accepts a
 * full header ("a=b; c=d"), a "Cookie:" prefixed capture, or a bare session
 * token (wrapped under the default session cookie name). Returns undefined
 * when nothing usable remains. Exported for unit tests.
 */
export const normalizeOllamaCookie = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  let value = raw.trim();
  if (value.length === 0) return undefined;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  if (value.length === 0 || /[\r\n]/.test(value)) return undefined;

  let hadCookiePrefix = false;
  if (/^cookie:/i.test(value)) {
    hadCookiePrefix = true;
    value = value.slice(value.indexOf(":") + 1).trim();
  }

  const pairs = value
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.includes("=") && part.indexOf("=") > 0)
    .map((part) => {
      const eq = part.indexOf("=");
      return { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() };
    })
    .filter((pair) => pair.name.length > 0 && pair.value.length > 0);

  if (pairs.length === 0) {
    // Bare session token (or an unusable Cookie: capture).
    return hadCookiePrefix ? undefined : `${DEFAULT_SESSION_COOKIE_NAME}=${value}`;
  }
  if (pairs.some((p) => SESSION_COOKIE_NAMES.some((n) => n.toLowerCase() === p.name.toLowerCase()))) {
    return pairs.map((p) => `${p.name}=${p.value}`).join("; ");
  }
  if (pairs.length > 1) {
    // Multi-pair header without a recognized name - pass through untouched.
    return pairs.map((p) => `${p.name}=${p.value}`).join("; ");
  }
  // Bare session token.
  return `${DEFAULT_SESSION_COOKIE_NAME}=${value}`;
};

export interface OllamaParsedSettings {
  readonly planName?: string;
  readonly accountEmail?: string;
  readonly sessionUsedPercent?: number;
  readonly sessionResetsAt?: string;
  readonly weeklyUsedPercent?: number;
  readonly weeklyResetsAt?: string;
}

export type OllamaHtmlClass =
  | { readonly kind: "ok"; readonly parsed: OllamaParsedSettings }
  | { readonly kind: "signed-out" }
  | { readonly kind: "no-usage" };

interface UsageBlock {
  readonly usedPercent: number;
  readonly resetsAt?: string;
}

const PRIMARY_USAGE_LABELS = ["Session usage", "Hourly usage"];
const ALL_USAGE_LABELS = [...PRIMARY_USAGE_LABELS, "Weekly usage"];

const firstCapture = (text: string, pattern: RegExp): string | undefined => {
  const match = pattern.exec(text);
  return match !== null && match[1] !== undefined ? match[1] : undefined;
};

const parsePlanName = (html: string): string | undefined => {
  const raw = firstCapture(html, /Cloud Usage\s*<\/span>\s*<span[^>]*>([^<]+)</);
  const trimmed = raw?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
};

const parseAccountEmail = (html: string): string | undefined => {
  const raw = firstCapture(html, /id="header-email"[^>]*>([^<]+)</);
  const trimmed = raw?.trim();
  return trimmed !== undefined && trimmed.includes("@") ? trimmed : undefined;
};

const parsePercent = (text: string): number | undefined => {
  const usedRaw = firstCapture(text, /([0-9]+(?:\.[0-9]+)?)\s*%\s*used/i);
  if (usedRaw !== undefined) {
    const value = Number(usedRaw);
    if (Number.isFinite(value)) return value;
  }
  const widthRaw = firstCapture(text, /width:\s*([0-9]+(?:\.[0-9]+)?)%/i);
  if (widthRaw !== undefined) {
    const value = Number(widthRaw);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
};

const parseIsoStamp = (text: string): string | undefined => {
  const raw = firstCapture(text, /data-time="([^"]+)"/);
  if (raw === undefined) return undefined;
  const parsedMs = Date.parse(raw);
  return Number.isFinite(parsedMs) ? new Date(parsedMs).toISOString() : undefined;
};

const parseUsageBlock = (label: string, html: string): UsageBlock | undefined => {
  const labelIndex = html.indexOf(label);
  if (labelIndex < 0) return undefined;
  const tailStart = labelIndex + label.length;
  let end = html.length;
  for (const other of ALL_USAGE_LABELS) {
    if (other === label) continue;
    const idx = html.indexOf(other, tailStart);
    if (idx >= 0 && idx < end) end = idx;
  }
  const windowText = html.slice(tailStart, Math.min(end, tailStart + 4000));
  const usedPercent = parsePercent(windowText);
  if (usedPercent === undefined) return undefined;
  const resetsAt = parseIsoStamp(windowText);
  return { usedPercent, ...(resetsAt !== undefined ? { resetsAt } : {}) };
};

/**
 * Heuristic sign-in page detection: auth forms pointing at
 * login/signin routes or carrying email/password fields.
 */
const looksSignedOut = (html: string): boolean => {
  const lower = html.toLowerCase();
  const hasAuthForm = lower.includes("<form");
  if (!hasAuthForm) return false;
  const hasAuthEndpoint =
    lower.includes("/api/auth/signin") ||
    lower.includes("/auth/signin") ||
    lower.includes('action="/login"') ||
    lower.includes("action='/login'") ||
    lower.includes('href="/login"') ||
    lower.includes("href='/login'") ||
    lower.includes('action="/signin"') ||
    lower.includes("action='/signin'") ||
    lower.includes('href="/signin"') ||
    lower.includes("href='/signin'");
  const hasPasswordField =
    lower.includes('type="password"') ||
    lower.includes("type='password'") ||
    lower.includes('name="password"') ||
    lower.includes("name='password'");
  const hasEmailField =
    lower.includes('type="email"') ||
    lower.includes("type='email'") ||
    lower.includes('name="email"') ||
    lower.includes("name='email'");
  const hasSignInHeading = lower.includes("sign in to ollama") || lower.includes("log in to ollama");
  if (hasSignInHeading && (hasEmailField || hasPasswordField || hasAuthEndpoint)) return true;
  if (hasAuthEndpoint) return true;
  return hasPasswordField && hasEmailField;
};

/**
 * Pure decode of one ollama.com/settings HTML body. Exported for unit tests.
 */
export const classifyOllamaSettingsHtml = (html: string): OllamaHtmlClass => {
  const session = PRIMARY_USAGE_LABELS.map((label) => parseUsageBlock(label, html)).find(
    (block) => block !== undefined,
  );
  const weekly = parseUsageBlock("Weekly usage", html);

  if (session === undefined && weekly === undefined) {
    return looksSignedOut(html) ? { kind: "signed-out" } : { kind: "no-usage" };
  }

  return {
    kind: "ok",
    parsed: {
      ...(parsePlanName(html) !== undefined ? { planName: parsePlanName(html)! } : {}),
      ...(parseAccountEmail(html) !== undefined ? { accountEmail: parseAccountEmail(html)! } : {}),
      ...(session !== undefined ? { sessionUsedPercent: clampPercent(session.usedPercent) } : {}),
      ...(session?.resetsAt !== undefined ? { sessionResetsAt: session.resetsAt } : {}),
      ...(weekly !== undefined ? { weeklyUsedPercent: clampPercent(weekly.usedPercent) } : {}),
      ...(weekly?.resetsAt !== undefined ? { weeklyResetsAt: weekly.resetsAt } : {}),
    },
  };
};

const makeOllamaWindows = (parsed: OllamaParsedSettings): UsageWindow[] => {
  const windows: UsageWindow[] = [];
  if (parsed.sessionUsedPercent !== undefined) {
    windows.push({
      label: "primary",
      title: "Session",
      usedPercent: parsed.sessionUsedPercent,
      windowMinutes: SESSION_WINDOW_MINUTES,
      ...(parsed.sessionResetsAt !== undefined ? { resetsAt: parsed.sessionResetsAt } : {}),
    });
  }
  if (parsed.weeklyUsedPercent !== undefined) {
    windows.push({
      label: "secondary",
      title: "Weekly",
      usedPercent: parsed.weeklyUsedPercent,
      windowMinutes: WEEKLY_WINDOW_MINUTES,
      ...(parsed.weeklyResetsAt !== undefined ? { resetsAt: parsed.weeklyResetsAt } : {}),
    });
  }
  return windows;
};

export type OllamaWebOutcome =
  | { readonly kind: "ok"; readonly parsed: OllamaParsedSettings }
  | { readonly kind: "signed-out" }
  | { readonly kind: "http"; readonly status: number }
  | { readonly kind: "failed"; readonly error: string };

export type OllamaApiOutcome =
  | { readonly kind: "ok"; readonly modelCount: number }
  | { readonly kind: "unauthorized"; readonly status: number }
  | { readonly kind: "failed"; readonly error: string };

/**
 * Pure fold of the web + api-key strategy outcomes into the one snapshot
 * callers see. Web quota success wins; any web failure falls to the API-key
 * identity tier; total failure folds into ok:false + reason. Error strings
 * are scrubbed against `secrets`. Exported for unit tests.
 */
export const assembleOllamaSnapshot = (
  web: OllamaWebOutcome | undefined,
  api: OllamaApiOutcome | undefined,
  fetchedAt: string,
  secrets: ReadonlyArray<string>,
): UsageSnapshot => {
  const redact = (message: string): string => redactSecrets(message, secrets);

  if (web?.kind === "ok") {
    const windows = makeOllamaWindows(web.parsed);
    if (windows.length > 0) {
      const quota: ProviderQuota = {
        provider: "ollama",
        source: "web",
        status: "ok",
        ...(web.parsed.accountEmail !== undefined ? { account: web.parsed.accountEmail } : {}),
        ...(web.parsed.planName !== undefined ? { plan: web.parsed.planName } : {}),
        windows,
        updatedAt: fetchedAt,
        extras: {
          capability: "limits",
          note: "session and weekly cloud quotas from the ollama.com settings page - no credits or cost published",
          partial: false,
        },
      };
      return { source: "ollama", fetchedAt, ok: true, quotas: [quota], dataConfidence: "live" };
    }
    // Settings page decoded but carried no usage blocks - fall to the api tier.
  }

  if (api?.kind === "ok") {
    const quota: ProviderQuota = {
      provider: "ollama",
      source: "api",
      status: "ok",
      windows: [],
      updatedAt: fetchedAt,
      extras: {
        capability: "identity",
        partial: true,
        note: "API key verified via ollama.com - the public API publishes no quota or credit surface",
        modelCount: api.modelCount,
      },
    };
    return { source: "ollama", fetchedAt, ok: true, quotas: [quota], dataConfidence: "live" };
  }

  let reason: UsageUnavailableReason;
  let error: string;
  if (web === undefined && api === undefined) {
    reason = "source-missing";
    error =
      "no Ollama Cloud credentials - set OLLAMA_SESSION_COOKIE (or OLLAMA_COOKIE) for cloud quotas, or OLLAMA_API_KEY for identity only";
  } else if (api?.kind === "unauthorized") {
    reason = "cli-error";
    error = `Ollama API key rejected by ollama.com (${api.status})`;
  } else if (web?.kind === "signed-out") {
    reason = "cli-error";
    error = "Ollama session expired - sign in at ollama.com and refresh OLLAMA_SESSION_COOKIE";
  } else if (web?.kind === "http") {
    reason = "cli-error";
    error = `ollama.com settings returned HTTP ${web.status}`;
  } else if (web?.kind === "failed") {
    reason = "cli-error";
    error = redact(`Ollama settings fetch failed: ${web.error}`);
  } else {
    // web decoded but empty (api tier absent or failed non-auth).
    if (api?.kind === "failed") {
      reason = "cli-error";
      error = redact(`Ollama API check failed: ${api.error}`);
    } else {
      reason = "parse-error";
      error = "ollama.com settings page carried no usage data";
    }
  }

  return { source: "ollama", fetchedAt, ok: false, reason, error: redact(error), quotas: [] };
};

/** Operator tier from Settings > Providers - highest precedence in the chain. */
export interface OllamaOperatorCredentials {
  readonly sessionCookie?: string;
  readonly apiKey?: string;
}

/**
 * Session-cookie resolution: operator setting first (deliberate intent),
 * then OLLAMA_SESSION_COOKIE / OLLAMA_COOKIE. Injectable env for tests.
 */
export const resolveSessionCookie = (
  operator?: OllamaOperatorCredentials,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined =>
  normalizeOllamaCookie(
    operator?.sessionCookie ??
      env.OLLAMA_SESSION_COOKIE ??
      env.OLLAMA_COOKIE,
  );

/** API-key resolution: operator setting first, then OLLAMA_API_KEY / OLLAMA_KEY. */
export const resolveApiKey = (
  operator?: OllamaOperatorCredentials,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  if (operator?.apiKey !== undefined) {
    const operatorValue = operator.apiKey.trim();
    if (operatorValue.length > 0) return operatorValue;
  }
  for (const key of ["OLLAMA_API_KEY", "OLLAMA_KEY"]) {
    const raw = env[key];
    if (raw === undefined) continue;
    let value = raw.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1).trim();
    }
    if (value.length > 0) return value;
  }
  return undefined;
};

/** True when the redirect target is an Ollama / WorkOS sign-in flow. */
const isSignInLocation = (location: string | null): boolean => {
  if (location === null) return false;
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return false;
  }
  const host = url.host.toLowerCase();
  const path = url.pathname.toLowerCase();
  if ((host === "ollama.com" || host === "www.ollama.com") && path === "/signin") return true;
  if (host === "signin.ollama.com") return true;
  return host.endsWith(".workos.com") && path.startsWith("/user_management/authorize");
};

/**
 * One GET against the ollama.com settings page with the session cookie.
 * Any failure - redirect to sign-in, HTTP status, timeout, network - folds
 * into a typed outcome; this function never throws and never echoes the
 * cookie or raw body.
 */
export const fetchOllamaSettingsPage = async (
  cookieHeader: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<OllamaWebOutcome> => {
  try {
    const response = await fetchImpl(SETTINGS_URL, {
      method: "GET",
      redirect: "manual",
      headers: {
        Cookie: cookieHeader,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
        referer: SETTINGS_URL,
      },
      signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      if (isSignInLocation(response.headers.get("location"))) return { kind: "signed-out" };
      return { kind: "http", status: response.status };
    }
    if (response.status === 401 || response.status === 403) return { kind: "signed-out" };
    if (!response.ok) return { kind: "http", status: response.status };
    const html = await response.text();
    const classified = classifyOllamaSettingsHtml(html);
    if (classified.kind === "ok") return { kind: "ok", parsed: classified.parsed };
    if (classified.kind === "signed-out") return { kind: "signed-out" };
    return { kind: "http", status: response.status };
  } catch (error) {
    return {
      kind: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * API-key tier: validate the key against the web_search endpoint (400 is
 * acceptable - the empty probe query is rejected while the key authorizes),
 * then count the model catalog. Never throws, never echoes the key.
 */
export const fetchOllamaApiKeyUsage = async (
  apiKey: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<OllamaApiOutcome> => {
  try {
    const validateResponse = await fetchImpl(WEB_SEARCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "" }),
      signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
    });
    if (validateResponse.status === 401 || validateResponse.status === 403) {
      return { kind: "unauthorized", status: validateResponse.status };
    }
    if (!(validateResponse.ok || validateResponse.status === 400)) {
      return { kind: "failed", error: `ollama.com validation endpoint returned ${validateResponse.status}` };
    }

    const tagsResponse = await fetchImpl(TAGS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
    });
    if (tagsResponse.status === 401 || tagsResponse.status === 403) {
      return { kind: "unauthorized", status: tagsResponse.status };
    }
    if (!tagsResponse.ok) {
      return { kind: "failed", error: `ollama.com model catalog returned ${tagsResponse.status}` };
    }
    const payload = parseJson<unknown>(await tagsResponse.text());
    if (!isObject(payload) || !Array.isArray(payload.models)) {
      return { kind: "failed", error: "ollama.com model catalog returned an unrecognized payload" };
    }
    return { kind: "ok", modelCount: payload.models.length };
  } catch (error) {
    return {
      kind: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const collectSecrets = (operator?: OllamaOperatorCredentials): string[] => {
  const values: string[] = [];
  if (operator?.sessionCookie !== undefined && operator.sessionCookie.length > 0) {
    values.push(operator.sessionCookie);
  }
  const cookie = process.env.OLLAMA_SESSION_COOKIE ?? process.env.OLLAMA_COOKIE;
  if (cookie !== undefined) values.push(cookie);
  const apiKey = resolveApiKey(operator);
  if (apiKey !== undefined) values.push(apiKey);
  return values;
};

const detectOllama = async (operator?: OllamaOperatorCredentials): Promise<boolean> => {
  try {
    return (
      resolveSessionCookie(operator) !== undefined ||
      resolveApiKey(operator) !== undefined
    );
  } catch {
    return false;
  }
};

const fetchOllama = async (operator?: OllamaOperatorCredentials): Promise<UsageSnapshot> => {
  const fetchedAt = new Date().toISOString();
  const secrets = collectSecrets(operator);
  try {
    const cookieHeader = resolveSessionCookie(operator);
    const apiKey = resolveApiKey(operator);
    if (cookieHeader === undefined && apiKey === undefined) {
      return assembleOllamaSnapshot(undefined, undefined, fetchedAt, secrets);
    }
    const web =
      cookieHeader !== undefined ? await fetchOllamaSettingsPage(cookieHeader) : undefined;
    const api = apiKey !== undefined ? await fetchOllamaApiKeyUsage(apiKey) : undefined;
    return assembleOllamaSnapshot(web, api, fetchedAt, secrets);
  } catch (error) {
    return {
      source: "ollama",
      fetchedAt,
      ok: false,
      reason: "cli-error",
      error: redactSecrets(error instanceof Error ? error.message : String(error), secrets),
      quotas: [],
    };
  }
};

/**
 * Build the Ollama Cloud usage source over an operator-credential reader.
 * `readOperator` returns the Settings > Providers ollama section (raw
 * values, main-process only).
 */
export const makeOllamaSource = (
  readOperator: () => OllamaOperatorCredentials | undefined = () => undefined,
): UsageSource => ({
  id: "ollama",
  detect: Effect.promise(() => detectOllama(readOperator())),
  fetch: Effect.promise(() => fetchOllama(readOperator())),
});

/** Default instance: no operator tier (env vars only). */
export const ollamaSource: UsageSource = makeOllamaSource();
