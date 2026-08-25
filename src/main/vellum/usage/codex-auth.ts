import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ~/.codex/auth.json reader for the native Codex usage source.
//
// HARD RULE: we NEVER refresh tokens in-process. The Codex
// CLI owns the rotation lifecycle of its own auth file; a rotated response
// written back here would strand the CLI. On any auth failure the caller gets
// an outcome that says re-auth (Codex CLI login) is needed — no process spawn,
// no refresh endpoint, no writes. (CLI-mediated rotation is future work.)

export const CODEX_AUTH_PATH = (): string => join(homedir(), ".codex", "auth.json");

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

// A plausible bearer credential: non-empty string that is not an obvious
// placeholder. Tokens themselves never leave this module in error text.
const plausibleToken = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length >= 8;

export type CodexAuthOutcome =
  | {
      readonly kind: "ok";
      /** Bearer token for chatgpt.com backend calls (access_token preferred, API key fallback). */
      readonly bearerToken: string;
      readonly accountId?: string;
      readonly email?: string;
    }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly error: string }
  | { readonly kind: "invalid"; readonly error: string };

/** Pure decode of an already-parsed auth.json payload — exported for unit tests. */
export const decodeCodexAuth = (payload: unknown): CodexAuthOutcome => {
  if (!isObject(payload)) return { kind: "invalid", error: "auth.json is not an object" };

  const tokens = isObject(payload.tokens) ? payload.tokens : undefined;
  // access_token preferred; legacy flat shapes tolerated; OPENAI_API_KEY (PAT)
  // is a valid last-resort bearer for the same usage endpoints.
  const candidate =
    (tokens !== undefined ? asString(tokens.access_token) : undefined) ??
    asString(payload.access_token) ??
    (tokens !== undefined ? asString(tokens.id_token) : undefined) ??
    asString(payload.id_token) ??
    asString(payload.OPENAI_API_KEY);
  if (!plausibleToken(candidate)) {
    return { kind: "invalid", error: "auth.json has no usable token fields" };
  }

  const accountId =
    (tokens !== undefined ? asString(tokens.account_id) : undefined) ?? asString(payload.account_id);
  const claims = decodeIdTokenClaims(tokens !== undefined ? asString(tokens.id_token) : undefined);
  return {
    kind: "ok",
    bearerToken: candidate.trim(),
    ...(accountId !== undefined ? { accountId } : claims?.accountId !== undefined ? { accountId: claims.accountId } : {}),
    ...(claims?.email !== undefined ? { email: claims.email } : {}),
  };
};

// Base64url JWT payload claims (`https://api.openai.com/auth` → account id).
// Tolerant: anything undecodable yields undefined, never a throw.
const decodeIdTokenClaims = (idToken: string | undefined): { accountId?: string; email?: string } | undefined => {
  if (!plausibleToken(idToken)) return undefined;
  const parts = idToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const json = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    if (!isObject(json)) return undefined;
    const openaiAuth = isObject(json["https://api.openai.com/auth"]) ? json["https://api.openai.com/auth"] : undefined;
    const accountId = asString(json.chat_account_id) ??
      (openaiAuth !== undefined ? asString(openaiAuth.chat_account_id) : undefined) ??
      (openaiAuth !== undefined ? asString(openaiAuth.account_id) : undefined);
    const email = asString(json.email);
    return {
      ...(accountId !== undefined ? { accountId } : {}),
      ...(email !== undefined ? { email } : {}),
    };
  } catch {
    return undefined;
  }
};

/** Filesystem read + decode. Missing/unreadable/invalid all fail closed. */
export const readCodexAuth = (): CodexAuthOutcome => {
  let raw: string;
  try {
    raw = readFileSync(CODEX_AUTH_PATH(), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", error: code !== undefined ? `auth.json unreadable (${code})` : "auth.json unreadable" };
  }
  try {
    return decodeCodexAuth(JSON.parse(raw));
  } catch {
    return { kind: "invalid", error: "auth.json is not valid JSON" };
  }
};

/**
 * True when a Codex credential is present AND plausible. Detect never reads
 * the network and never surfaces token material.
 */
export const detectCodexAuth = async (): Promise<boolean> => readCodexAuth().kind === "ok";
