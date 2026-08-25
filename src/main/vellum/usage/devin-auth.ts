import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Credential discovery for the native Devin usage source.
//
// Protocol reference: CodexBar Sources/CodexBarCore/Providers/Devin/.
// Devin exposes daily/weekly ACU quota windows at
// `GET https://app.devin.ai/api/<organization>/billing/quota/usage`,
// authenticated with the app.devin.ai browser session bearer (`auth1_…`)
// plus an optional `x-cog-org-id` header selecting the internal organization.
//
// Discovery tiers (read-only, never logged):
//   1. Environment overrides — DEVIN_BEARER_TOKEN / DEVIN_AUTHORIZATION,
//      organization from DEVIN_ORGANIZATION / DEVIN_ORG.
//   2. Chromium localStorage byte scan (Google Chrome, CodexBar parity:
//      browserCookieOrder = [.chrome]) for the `auth1_session` token and
//      organization metadata under the app.devin.ai origin.
//
// Tokens NEVER leave this module in error text or logs.

type JsonObject = Record<string, unknown>;

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** True when the value looks like a usable bearer credential. */
export const plausibleToken = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length >= 20;

/**
 * Normalize an organization reference to the wire form used in the usage
 * path: `org/<slug>` for external slugs, `organizations/<id>` for internal
 * `org-…`/`org_…` IDs. Accepts bare slugs, full URLs, prefixed forms.
 */
export const normalizeOrganization = (raw: string | undefined): string | undefined => {
  let value = raw?.trim();
  if (value === undefined || value === "") return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host === "devin.ai" || host.endsWith(".devin.ai")) {
      const parts = url.pathname.split("/").filter((p) => p !== "");
      if (parts.length >= 2 && parts[0] === "org") value = `org/${parts[1]}`;
      else if (parts.length >= 2 && parts[0] === "organizations") value = `organizations/${parts[1]}`;
    }
  } catch {
    // Not a URL — treat as a bare reference below.
  }
  value = value.replace(/^\/+|\/+$/g, "");
  if (value.startsWith("org/") || value.startsWith("organizations/")) return value;
  if (isInternalOrganizationId(value)) return `organizations/${value}`;
  return `org/${value}`;
};

/** Internal organization IDs look like `org-XXXXXXXX` / `org_XXXXXXXX`. */
export const isInternalOrganizationId = (value: string): boolean =>
  /^org[-_][A-Za-z0-9]{6,}$/.test(value);

/** The internal ID carried by an already-normalized organization, if any. */
export const internalOrganizationIdOf = (
  normalized: string | undefined,
): string | undefined =>
  normalized !== undefined && normalized.startsWith("organizations/")
    ? normalized.slice("organizations/".length)
    : undefined;

/** Display form for the quota row account field: the bare slug/id. */
export const displayOrganization = (raw: string | undefined): string | undefined => {
  const normalized = normalizeOrganization(raw);
  if (normalized === undefined) return undefined;
  if (normalized.startsWith("org/")) return normalized.slice(4);
  if (normalized.startsWith("organizations/")) return normalized.slice("organizations/".length);
  return normalized;
};

/** Strip `Authorization:` / `Bearer ` decoration from a pasted header value. */
export const extractBearer = (raw: string | undefined): string | undefined => {
  let value = raw?.trim();
  if (value === undefined || value === "") return undefined;
  if (value.toLowerCase().startsWith("authorization:")) {
    value = value.slice(value.indexOf(":") + 1).trim();
  }
  if (value.toLowerCase().startsWith("bearer ")) {
    value = value.slice(7).trim();
  }
  return value !== "" ? value : undefined;
};

export interface DevinCredential {
  /** Bearer token for app.devin.ai API calls. */
  readonly bearerToken: string;
  /** Normalized organization (`org/<slug>` or `organizations/<internal id>`). */
  readonly organization?: string;
  /** Internal organization ID for the `x-cog-org-id` header, when known. */
  readonly internalOrganizationId?: string;
  /** Where this credential came from (diagnostics only, never secrets). */
  readonly origin: "env" | "browser";
}

export type DevinCredentialOutcome =
  | { readonly kind: "ok"; readonly credential: DevinCredential }
  | { readonly kind: "missing" };

/**
 * Tier 1 — environment overrides. Pure over the passed env record so tests
 * stay hermetic.
 */
export const resolveEnvCredential = (env: NodeJS.ProcessEnv): DevinCredentialOutcome => {
  const token =
    extractBearer(asString(env.DEVIN_BEARER_TOKEN)) ??
    extractBearer(asString(env.DEVIN_AUTHORIZATION)) ??
    extractBearer(asString(env.DEVIN_API_TOKEN));
  if (!plausibleToken(token)) return { kind: "missing" };
  const organization = normalizeOrganization(
    asString(env.DEVIN_ORGANIZATION) ?? asString(env.DEVIN_ORG),
  );
  return {
    kind: "ok",
    credential: {
      bearerToken: token.trim(),
      ...(organization !== undefined
        ? { organization, ...(internalOrganizationIdOf(organization) !== undefined
            ? { internalOrganizationId: internalOrganizationIdOf(organization) }
            : {}) }
        : {}),
      origin: "env",
    },
  };
};

// ---------------------------------------------------------------------------
// Tier 2 — Chromium localStorage byte scan (app.devin.ai session).
// ---------------------------------------------------------------------------

/** Chromium profile roots holding `<profile>/Local Storage/leveldb`. */
export const chromiumLevelDbRoots = (): string[] => {
  const home = homedir();
  switch (process.platform) {
    case "darwin":
      return [join(home, "Library", "Application Support", "Google", "Chrome")];
    case "linux":
      return [
        join(home, ".config", "google-chrome"),
        join(home, ".config", "chromium"),
      ];
    default:
      return [];
  }
};

const PROFILE_PREFIXES = ["Default", "Profile ", "user-"];

/** Candidate leveldb directories across profiles, sorted for determinism. */
export const levelDbCandidates = (roots: string[]): string[] => {
  const out: string[] = [];
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    const profiles = entries.filter(
      (name) =>
        PROFILE_PREFIXES.some((prefix) => name.startsWith(prefix)),
    ).sort();
    for (const profile of profiles) {
      const dir = join(root, profile, "Local Storage", "leveldb");
      if (existsSync(dir)) out.push(dir);
    }
  }
  return out;
};

// Caps keep the scan bounded even when leveldb carries large compaction files.
const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;

export interface BrowserSessionCandidate {
  readonly bearerToken: string;
  readonly organization?: string;
  readonly internalOrganizationId?: string;
}

const AUTH1_TOKEN_RE = /auth1_[A-Za-z0-9_-]{16,}/;
const EXTERNAL_ORG_RE = /last-internal-org-for-external-org-v1-([A-Za-z0-9_-]+)/;
const INTERNAL_ORG_RE = /org[-_][A-Za-z0-9]{8,}/g;

/**
 * Extract session material from the decoded text of localStorage storage
 * files. Best-effort: anything undecodable yields undefined, never a throw.
 */
export const scanSessionMaterial = (
  text: string,
): BrowserSessionCandidate | undefined => {
  const tokenMatch = AUTH1_TOKEN_RE.exec(text);
  if (tokenMatch === null) return undefined;

  const externalOrgMatch = EXTERNAL_ORG_RE.exec(text);
  let organization: string | undefined;
  let internalOrganizationId: string | undefined;

  if (externalOrgMatch !== null) {
    const slug = externalOrgMatch[1];
    if (slug !== "null" && slug !== "") {
      organization = `org/${slug}`;
      // The internal id usually sits right after the marker's value entry.
      const tail = text.slice(externalOrgMatch.index, externalOrgMatch.index + 2048);
      INTERNAL_ORG_RE.lastIndex = 0;
      const idMatch = INTERNAL_ORG_RE.exec(tail);
      if (idMatch !== null && isInternalOrganizationId(idMatch[0])) {
        internalOrganizationId = idMatch[0];
      }
    }
  }

  return {
    bearerToken: tokenMatch[0],
    ...(organization !== undefined ? { organization } : {}),
    ...(internalOrganizationId !== undefined ? { internalOrganizationId } : {}),
  };
};

/**
 * Tier 2 — scan Chromium localStorage for the app.devin.ai session.
 * Read-only, byte-capped, silent on any filesystem failure.
 */
export const resolveBrowserCredential = (): DevinCredentialOutcome => {
  const dirs = levelDbCandidates(chromiumLevelDbRoots());
  let best: BrowserSessionCandidate | undefined;
  const score = (c: BrowserSessionCandidate): number =>
    (c.organization !== undefined ? 1 : 0) + (c.internalOrganizationId !== undefined ? 2 : 0);
  let budget = MAX_TOTAL_BYTES;
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".log") && !file.endsWith(".ldb")) continue;
      let size = 0;
      try {
        size = statSync(join(dir, file)).size;
      } catch {
        continue;
      }
      if (size <= 0 || size > MAX_FILE_BYTES || size > budget) continue;
      budget -= size;
      let text: string;
      try {
        // latin1 keeps byte offsets stable and never throws on binary pages.
        text = readFileSync(join(dir, file), "latin1");
      } catch {
        continue;
      }
      const found = scanSessionMaterial(text);
      if (found !== undefined && (best === undefined || score(found) > score(best))) {
        best = found;
      }
    }
  }
  if (best === undefined) return { kind: "missing" };
  return { kind: "ok", credential: { ...best, origin: "browser" } };
};

/** Ordered credential pipeline: explicit env overrides, then the browser. */
export const resolveDevinCredential = (env: NodeJS.ProcessEnv = process.env): DevinCredentialOutcome => {
  const fromEnv = resolveEnvCredential(env);
  if (fromEnv.kind === "ok") return fromEnv;
  return resolveBrowserCredential();
};

/**
 * Cheap presence probe for `detect` — NO network, NO heavy scan. True when
 * an env credential resolves or any Chromium leveldb directory exists.
 */
export const detectDevinCredential = async (): Promise<boolean> => {
  if (resolveEnvCredential(process.env).kind === "ok") return true;
  return levelDbCandidates(chromiumLevelDbRoots()).length > 0;
};
