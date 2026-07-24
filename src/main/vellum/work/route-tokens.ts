/**
 * Route-token store for Tier-3 work-plane admission.
 *
 * A route-token is operator-minted seat identity for callers that have no
 * local process-bind (remote harness / configured route). Plaintext is shown
 * once at mint/rotate; only sha256 is persisted under ~/.vellum/routes/.
 *
 * Work control admits: work-file token + process-bind (Tier 2) OR a live
 * route-token principal (Tier 3). Host-local planes are not on the work socket.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import type { ProcessPrincipal, ProcessPrincipalKind } from "../process-identity";
import {
  CONTROL_DIRECTORY_MODE,
  CONTROL_FILE_MODE,
  prepareControlDirectory,
} from "../control-filesystem";

export const ROUTES_HOME_ENV = "VELLUM_ROUTES_HOME";

/** Default dir: `~/.vellum/routes`. Tests override with `VELLUM_ROUTES_HOME`. */
export const routesControlDir = (home: string): string =>
  `${home}/.vellum/routes`;

export const resolveRoutesHome = (
  home?: string,
  routesHome?: string,
): string => {
  if (routesHome && routesHome.trim().length > 0) return routesHome.trim();
  const env = process.env[ROUTES_HOME_ENV]?.trim();
  if (env) return env;
  return routesControlDir(home ?? homedir());
};

/** Mint input: seat anchor + process-principal-compatible fields. */
export interface RouteTokenMintPrincipal {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly kind: ProcessPrincipalKind;
  readonly agentKey?: string;
  readonly paneId?: string;
  readonly bindingId?: string;
}

export interface RouteTokenRecord {
  readonly id: string;
  /** sha256 hex of the one-time plaintext token (never the token itself). */
  readonly tokenHash: string;
  readonly principal: RouteTokenMintPrincipal;
  readonly createdAt: number;
  readonly revokedAt?: number;
}

export interface MintedRouteToken {
  readonly id: string;
  /** Plaintext shown once; never re-readable from disk. */
  readonly token: string;
}

export class RouteTokenError extends Error {
  readonly _tag = "RouteTokenError";
  constructor(
    readonly code: "not_found" | "revoked" | "invalid" | "io",
    message: string,
  ) {
    super(message);
    this.name = "RouteTokenError";
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)

/** sha256 hex of a route-token plaintext. */
export const hashRouteToken = (plaintext: string): string =>
  createHash("sha256").update(plaintext, "utf8").digest("hex");

/**
 * Timing-safe compare of plaintext against a stored sha256 hex digest.
 * Returns false on malformed hex without throwing.
 */
export const routeTokenHashEquals = (
  plaintext: string,
  expectedHex: string,
): boolean => {
  if (typeof expectedHex !== "string" || expectedHex.length !== 64) return false;
  if (!/^[0-9a-f]+$/i.test(expectedHex)) return false;
  const presented = createHash("sha256").update(plaintext, "utf8").digest();
  const stored = Buffer.from(expectedHex, "hex");
  if (stored.byteLength !== presented.byteLength) return false;
  return timingSafeEqual(presented, stored);
};

export const generateRouteTokenPlaintext = (): string =>
  randomBytes(32).toString("hex");

export const toProcessPrincipal = (
  principal: RouteTokenMintPrincipal,
): ProcessPrincipal => {
  const base: ProcessPrincipal = {
    kind: principal.kind,
    canvasName: principal.canvasName,
    nodeId: principal.nodeId,
    ...(principal.agentKey !== undefined ? { agentKey: principal.agentKey } : {}),
    ...(principal.paneId !== undefined ? { paneId: principal.paneId } : {}),
    ...(principal.bindingId !== undefined
      ? { bindingId: principal.bindingId }
      : {}),
  };
  return Object.freeze(base);
};

const validateMintPrincipal = (
  principal: RouteTokenMintPrincipal,
): RouteTokenMintPrincipal => {
  const canvasName = principal.canvasName?.trim() ?? "";
  const nodeId = principal.nodeId?.trim() ?? "";
  if (canvasName.length === 0 || nodeId.length === 0) {
    throw new RouteTokenError(
      "invalid",
      "route-token principal requires canvasName and nodeId",
    );
  }
  if (
    principal.kind !== "agent" &&
    principal.kind !== "herdr" &&
    principal.kind !== "terminal"
  ) {
    throw new RouteTokenError("invalid", "route-token principal kind is invalid");
  }
  if (principal.kind === "agent" && !principal.agentKey?.trim()) {
    throw new RouteTokenError(
      "invalid",
      "route-token agent principal requires agentKey",
    );
  }
  return Object.freeze({
    kind: principal.kind,
    canvasName,
    nodeId,
    ...(principal.agentKey?.trim()
      ? { agentKey: principal.agentKey.trim() }
      : {}),
    ...(principal.paneId?.trim() ? { paneId: principal.paneId.trim() } : {}),
    ...(principal.bindingId?.trim()
      ? { bindingId: principal.bindingId.trim() }
      : {}),
  });
};

const isRecordShape = (value: unknown): value is RouteTokenRecord => {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || v.id.length === 0) return false;
  if (typeof v.tokenHash !== "string" || v.tokenHash.length !== 64) return false;
  if (typeof v.createdAt !== "number" || !Number.isFinite(v.createdAt)) return false;
  if (v.revokedAt !== undefined) {
    if (typeof v.revokedAt !== "number" || !Number.isFinite(v.revokedAt)) return false;
  }
  if (v.principal === null || typeof v.principal !== "object") return false;
  const p = v.principal as Record<string, unknown>;
  if (typeof p.canvasName !== "string" || typeof p.nodeId !== "string") return false;
  if (p.kind !== "agent" && p.kind !== "herdr" && p.kind !== "terminal") return false;
  return true;
};

// ---------------------------------------------------------------------------
// Filesystem store

const recordPath = (routesHome: string, id: string): string =>
  join(routesHome, `${id}.json`);

const ensureRoutesHome = (routesHome: string): void => {
  prepareControlDirectory(routesHome);
};

const writeRecordAtomic = (path: string, record: RouteTokenRecord): void => {
  const temp = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: CONTROL_FILE_MODE,
      flag: "wx",
    });
    try {
      chmodSync(temp, CONTROL_FILE_MODE);
    } catch {
      // best-effort; mode set at create
    }
    renameSync(temp, path);
    const final = lstatSync(path);
    if (
      !final.isFile() ||
      final.isSymbolicLink() ||
      (final.mode & 0o777) !== CONTROL_FILE_MODE
    ) {
      throw new RouteTokenError("io", "route-token record permissions could not be hardened");
    }
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // ignore cleanup
    }
    if (error instanceof RouteTokenError) throw error;
    throw new RouteTokenError(
      "io",
      error instanceof Error ? error.message : String(error),
    );
  }
};

const readRecord = (path: string): RouteTokenRecord | null => {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecordShape(parsed)) return null;
    return Object.freeze({
      id: parsed.id,
      tokenHash: parsed.tokenHash.toLowerCase(),
      principal: Object.freeze({ ...parsed.principal }),
      createdAt: parsed.createdAt,
      ...(parsed.revokedAt !== undefined ? { revokedAt: parsed.revokedAt } : {}),
    });
  } catch {
    return null;
  }
};

const listRecords = (routesHome: string): RouteTokenRecord[] => {
  if (!existsSync(routesHome)) return [];
  let names: string[];
  try {
    names = readdirSync(routesHome);
  } catch {
    return [];
  }
  const out: RouteTokenRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = readRecord(join(routesHome, name));
    if (record) out.push(record);
  }
  return out;
};

export const loadRouteTokenRecord = (
  id: string,
  routesHome?: string,
): RouteTokenRecord | null => {
  const home = resolveRoutesHome(undefined, routesHome);
  const path = recordPath(home, id);
  if (!existsSync(path)) return null;
  const record = readRecord(path);
  if (!record || record.id !== id) return null;
  return record;
};

/**
 * Mint a route-token for a canvas seat. Returns plaintext once; only the hash
 * is stored under the routes home (mode 0600 file, 0700 dir).
 */
export const mintRouteToken = (
  principal: RouteTokenMintPrincipal,
  routesHome?: string,
  now: () => number = Date.now,
): MintedRouteToken => {
  const home = resolveRoutesHome(undefined, routesHome);
  ensureRoutesHome(home);
  const validated = validateMintPrincipal(principal);
  const id = ulid();
  const token = generateRouteTokenPlaintext();
  const record: RouteTokenRecord = Object.freeze({
    id,
    tokenHash: hashRouteToken(token),
    principal: validated,
    createdAt: now(),
  });
  writeRecordAtomic(recordPath(home, id), record);
  return Object.freeze({ id, token });
};

/**
 * Rotate the plaintext for an existing route id. Old plaintext no longer
 * resolves; same seat principal is retained.
 */
export const rotateRouteToken = (
  id: string,
  routesHome?: string,
  now: () => number = Date.now,
): MintedRouteToken => {
  const home = resolveRoutesHome(undefined, routesHome);
  ensureRoutesHome(home);
  const existing = loadRouteTokenRecord(id, home);
  if (!existing) {
    throw new RouteTokenError("not_found", `route-token "${id}" not found`);
  }
  if (existing.revokedAt !== undefined) {
    throw new RouteTokenError("revoked", `route-token "${id}" is revoked`);
  }
  const token = generateRouteTokenPlaintext();
  const record: RouteTokenRecord = Object.freeze({
    id: existing.id,
    tokenHash: hashRouteToken(token),
    principal: existing.principal,
    createdAt: existing.createdAt,
    // rotation is not a revoke — clear any accidental revokedAt
  });
  void now;
  writeRecordAtomic(recordPath(home, id), record);
  return Object.freeze({ id, token });
};

/** Soft-revoke: resolve fails; record retained with revokedAt. */
export const revokeRouteToken = (
  id: string,
  routesHome?: string,
  now: () => number = Date.now,
): void => {
  const home = resolveRoutesHome(undefined, routesHome);
  ensureRoutesHome(home);
  const existing = loadRouteTokenRecord(id, home);
  if (!existing) {
    throw new RouteTokenError("not_found", `route-token "${id}" not found`);
  }
  if (existing.revokedAt !== undefined) return;
  const record: RouteTokenRecord = Object.freeze({
    ...existing,
    principal: existing.principal,
    revokedAt: now(),
  });
  writeRecordAtomic(recordPath(home, id), record);
};

/**
 * Resolve a presented plaintext to a ProcessPrincipal when the token is live
 * (hash match, not revoked). Timing-safe hash compare per candidate record.
 */
export const resolveRouteToken = (
  plaintext: string,
  routesHome?: string,
): ProcessPrincipal | null => {
  if (typeof plaintext !== "string" || plaintext.length === 0) return null;
  const home = resolveRoutesHome(undefined, routesHome);
  const records = listRecords(home);
  for (const record of records) {
    if (record.revokedAt !== undefined) continue;
    if (!routeTokenHashEquals(plaintext, record.tokenHash)) continue;
    return toProcessPrincipal(record.principal);
  }
  return null;
};

/**
 * Resolve with route id for occupant labeling (admission). Same auth rules as
 * resolveRouteToken; returns null when not admitted.
 */
export const resolveRouteTokenDetailed = (
  plaintext: string,
  routesHome?: string,
): { readonly id: string; readonly principal: ProcessPrincipal } | null => {
  if (typeof plaintext !== "string" || plaintext.length === 0) return null;
  const home = resolveRoutesHome(undefined, routesHome);
  const records = listRecords(home);
  for (const record of records) {
    if (record.revokedAt !== undefined) continue;
    if (!routeTokenHashEquals(plaintext, record.tokenHash)) continue;
    return Object.freeze({
      id: record.id,
      principal: toProcessPrincipal(record.principal),
    });
  }
  return null;
};

/** Test / install helper: directory mode after prepare. */
export const ensureRoutesDirectory = (routesHome?: string): string => {
  const home = resolveRoutesHome(undefined, routesHome);
  ensureRoutesHome(home);
  return home;
};

export { CONTROL_DIRECTORY_MODE, CONTROL_FILE_MODE };
