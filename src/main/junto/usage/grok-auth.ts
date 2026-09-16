import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ~/.grok/auth.json reader for the native Grok usage source.
//
// The file is a map keyed by OIDC scope URL written by `grok login`. We prefer
// the SuperGrok OIDC scope over the legacy session scope and skip stale
// entries that carry no usable bearer key. HARD RULE: we
// never refresh tokens in-process - on expiry or rejection the caller gets an
// outcome that says re-auth via `grok login` is needed. Token material never
// appears in error text; only field names are named.

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed !== "" ? trimmed : undefined;
};

/** OIDC scope prefix used by `grok login` for SuperGrok subscribers. */
export const GROK_OIDC_SCOPE_PREFIX = "https://auth.x.ai::";
/** Legacy/session scope used by older `grok login` flows. */
export const GROK_LEGACY_SESSION_SCOPE = "https://accounts.x.ai/sign-in";

export const grokHome = (env: NodeJS.ProcessEnv = process.env): string => {
  const custom = nonEmpty(env.GROK_HOME);
  if (custom !== undefined) {
    return custom.startsWith("~") ? join(homedir(), custom.slice(1)) : custom;
  }
  return join(homedir(), ".grok");
};

export const GROK_AUTH_PATH = (env: NodeJS.ProcessEnv = process.env): string =>
  join(grokHome(env), "auth.json");

export interface GrokCredentials {
  readonly accessToken: string;
  readonly scope: string;
  readonly authMode?: string;
  readonly email?: string;
  readonly userId?: string;
  readonly teamId?: string;
  /** "team" when the credential is a team principal (billing RPC answers differently). */
  readonly principalType?: string;
  readonly expiresAt?: string;
}

/** True when the credential carries an expires_at already in the past. */
export const isGrokCredentialExpired = (
  credentials: Pick<GrokCredentials, "expiresAt">,
  nowMs: number = Date.now(),
): boolean => {
  if (credentials.expiresAt === undefined) return false;
  const ms = Date.parse(credentials.expiresAt);
  if (!Number.isFinite(ms)) return false;
  return nowMs >= ms;
};

export type GrokAuthOutcome =
  | { readonly kind: "ok"; readonly credentials: GrokCredentials }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly error: string }
  | { readonly kind: "invalid"; readonly error: string };

/**
 * Pure decode of an already-parsed auth.json payload - exported for unit tests.
 * Prefers OIDC-scope entries over legacy sign-in entries; only entries with a
 * non-empty `key` bearer are eligible. Errors name fields, never values.
 */
export const decodeGrokAuthPayload = (payload: unknown): GrokAuthOutcome => {
  if (!isObject(payload)) return { kind: "invalid", error: "auth.json is not an object" };

  let oidc: { scope: string; entry: JsonObject } | undefined;
  let legacy: { scope: string; entry: JsonObject } | undefined;
  for (const [scope, value] of Object.entries(payload)) {
    if (!isObject(value)) continue;
    const key = nonEmpty(asString(value.key));
    // A stale/partial OIDC record without a usable bearer must not shadow a
    // healthy legacy session entry.
    if (key === undefined) continue;
    if (scope.startsWith(GROK_OIDC_SCOPE_PREFIX)) oidc ??= { scope, entry: value };
    else if (scope === GROK_LEGACY_SESSION_SCOPE || scope.includes("/sign-in")) {
      legacy ??= { scope, entry: value };
    }
  }
  const selected = oidc ?? legacy;
  if (selected === undefined) {
    return { kind: "invalid", error: "auth.json has no scope entry carrying a key token" };
  }

  const credentials: GrokCredentials = {
    accessToken: nonEmpty(asString(selected.entry.key))!,
    scope: selected.scope,
    ...(nonEmpty(asString(selected.entry.auth_mode)) !== undefined
      ? { authMode: nonEmpty(asString(selected.entry.auth_mode)) }
      : {}),
    ...(nonEmpty(asString(selected.entry.email)) !== undefined
      ? { email: nonEmpty(asString(selected.entry.email)) }
      : {}),
    ...(nonEmpty(asString(selected.entry.user_id)) !== undefined
      ? { userId: nonEmpty(asString(selected.entry.user_id)) }
      : {}),
    ...(nonEmpty(asString(selected.entry.team_id)) !== undefined
      ? { teamId: nonEmpty(asString(selected.entry.team_id)) }
      : {}),
    ...(nonEmpty(asString(selected.entry.principal_type)) !== undefined
      ? { principalType: nonEmpty(asString(selected.entry.principal_type)) }
      : {}),
    ...(nonEmpty(asString(selected.entry.expires_at)) !== undefined
      ? { expiresAt: nonEmpty(asString(selected.entry.expires_at)) }
      : {}),
  };
  return { kind: "ok", credentials };
};

export type GrokCredentialResolution =
  | { readonly kind: "ok"; readonly credentials: GrokCredentials }
  | { readonly kind: "missing"; readonly error: string };

/**
 * Read-only credential resolution for the fetch pipeline:
 * GROK_OAUTH_TOKEN env override wins, then ~/.grok/auth.json (GROK_HOME-aware).
 * Expired auth.json credentials still resolve but carry their expiry - callers
 * decide to skip network tiers rather than attempting a refresh we do not own.
 */
export const readGrokCredentials = (env: NodeJS.ProcessEnv = process.env): GrokCredentialResolution => {
  const override = nonEmpty(env.GROK_OAUTH_TOKEN);
  if (override !== undefined) {
    return {
      kind: "ok",
      credentials: { accessToken: override, scope: "env:GROK_OAUTH_TOKEN", authMode: "oidc" },
    };
  }
  const path = GROK_AUTH_PATH(env);
  try {
    if (!existsSync(path)) {
      return {
        kind: "missing",
        error: "~/.grok/auth.json not found - run grok CLI login to enable live Grok billing usage",
      };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return { kind: "missing", error: "~/.grok/auth.json is unreadable or not valid JSON" };
    }
    const outcome = decodeGrokAuthPayload(payload);
    if (outcome.kind === "ok") return outcome;
    const detail =
      outcome.kind === "missing" ? "auth.json carries no usable credential" : outcome.error;
    return { kind: "missing", error: `${detail} - run grok CLI login to enable live Grok billing usage` };
  } catch {
    return { kind: "missing", error: "~/.grok/auth.json could not be read" };
  }
};
