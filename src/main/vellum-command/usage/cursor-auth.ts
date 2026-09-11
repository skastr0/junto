import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Cursor credential discovery (read-only), cheapest first:
//   0. operator settings (Settings > Providers) - a full Cookie header,
//      deliberate operator intent in Vellum Command.
//   1. CURSOR_COOKIE env var - a full Cookie header copied from cursor.com.
//   2. ~/.vellum-command/config/cursor-cookie - same Cookie header format,
//      operator-managed. Vellum Command never writes this file.
//   3. The Cursor desktop app's own session database (state.vscdb), read
//      with a dependency-free read-only SQLite walker - no sqlite package,
//      no CLI spawn. Browser-cookie import flows are future work.
//
// Secrets never leak: callers pass the raw credential only into request
// headers, and error strings are scrubbed through redactSecrets().

export const CURSOR_COOKIE_ENV = "CURSOR_COOKIE";

/** Operator-managed cookie file (raw Cookie header text, read-only). */
export const cursorConfigCookiePath = (home: string = homedir()): string =>
  join(home, ".vellum-command", "config", "cursor-cookie");

/** Cursor desktop app session store location (macOS / Linux layouts). */
export const cursorAppDbPath = (home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string => {
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg !== undefined && xdg.startsWith("/") ? xdg : join(home, ".config");
  return join(base, "Cursor", "User", "globalStorage", "state.vscdb");
};

export interface CursorCredential {
  /** Complete Cookie header value ready for request injection. */
  readonly cookieHeader: string;
  readonly origin: "operator-settings" | "env" | "config-file" | "app-database";
}

export type CursorCredentialOutcome =
  | { readonly kind: "ok"; readonly credential: CursorCredential }
  | { readonly kind: "missing"; readonly error: string };

export interface ResolveCursorCredentialOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly configPath?: string;
  readonly appDbPath?: string;
  /** Settings > Providers tier - checked before CURSOR_COOKIE. */
  readonly operatorCookieHeader?: string;
}

// ---------------------------------------------------------------------------
// JWT helpers (Cursor app access tokens are WorkOS-issued JWTs).
// ---------------------------------------------------------------------------

export interface CursorJwtIdentity {
  readonly sub?: string;
  readonly email?: string;
  readonly exp?: number;
}

/** Base64url-decode a JWT payload segment. Returns undefined on any garbage. */
export const decodeCursorJwtPayload = (jwt: string): CursorJwtIdentity | undefined => {
  const parts = jwt.split(".");
  if (parts.length < 2) return undefined;
  try {
    const json = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined;
    const record = json as Record<string, unknown>;
    const identity: { sub?: string; email?: string; exp?: number } = {};
    if (typeof record.sub === "string") identity.sub = record.sub;
    if (typeof record.email === "string") identity.email = record.email;
    if (typeof record.exp === "number" && Number.isFinite(record.exp)) identity.exp = record.exp;
    return identity;
  } catch {
    return undefined;
  }
};

const USER_ID_ALLOWED = /^[A-Za-z0-9._-]+$/;

/**
 * Rebuild the browser-style session cookie from the app's access token:
 * `WorkosCursorSessionToken=<userID>%3A%3A<jwt>` (the literal `%3A%3A`
 * separator mirrors what cursor.com sets in browsers). Returns undefined
 * when the token is unusable (no user id, or past its exp claim).
 */
export const buildAppAuthCookieHeader = (
  accessToken: string,
  nowMs: number = Date.now(),
): string | undefined => {
  const identity = decodeCursorJwtPayload(accessToken);
  if (identity === undefined) return undefined;
  if (identity.exp !== undefined && identity.exp * 1000 <= nowMs + 60_000) return undefined;
  const subject = identity.sub ?? "";
  const userID = subject.split("|").filter((part) => part !== "").pop();
  if (userID === undefined || userID === "" || !USER_ID_ALLOWED.test(userID)) return undefined;
  return `WorkosCursorSessionToken=${userID}%3A%3A${accessToken}`;
};

// ---------------------------------------------------------------------------
// Dependency-free read-only SQLite walker (single table, single-key lookup).
// Reads only checkpointed main-file bytes via node:fs - it never opens a
// writer, never creates sidecars, and treats a live WAL as merely-stale data.
// ---------------------------------------------------------------------------

const SQLITE_MAGIC = "SQLite format 3\u0000";
const MAX_PAGES_VISITED = 4096;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

interface DbLayout {
  readonly data: Buffer;
  readonly pageSize: number;
  readonly usableSize: number;
}

const openLayout = (dbPath: string): DbLayout | undefined => {
  let data: Buffer;
  try {
    data = readFileSync(dbPath);
  } catch {
    return undefined;
  }
  if (data.length < 100 || !data.subarray(0, 16).equals(Buffer.from(SQLITE_MAGIC, "latin1"))) {
    return undefined;
  }
  let pageSize = data.readUInt16BE(16);
  if (pageSize === 1) pageSize = 65536;
  if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) return undefined;
  const reserved = data[20];
  if (reserved >= pageSize - 480) return undefined;
  const encoding = data.readUInt32BE(56);
  if (encoding !== 1) return undefined; // UTF-8 databases only.
  return { data, pageSize, usableSize: pageSize - reserved };
};

const readVarint = (data: Buffer, offset: number): [number, number] | undefined => {
  let value = 0;
  for (let i = 0; i < 9; i += 1) {
    const byte = data[offset + i];
    if (byte === undefined) return undefined;
    if (i === 8) return [value * 256 + byte, offset + 9];
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return [value, offset + i + 1];
  }
  return undefined;
};

const SERIAL_INT_SIZES: Record<number, number> = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 6, 6: 8 };

/** Decode one record body's columns into strings (text/blob/int-as-string). */
const parseRecordColumns = (payload: Buffer): string[] | undefined => {
  const headerLen = readVarint(payload, 0);
  if (headerLen === undefined || headerLen[0] < 1 || headerLen[0] > payload.length) return undefined;
  let headerOffset = headerLen[1];
  let bodyOffset = headerLen[0];
  const columns: string[] = [];
  while (headerOffset < headerLen[0]) {
    const serial = readVarint(payload, headerOffset);
    if (serial === undefined) return undefined;
    headerOffset = serial[1];
    const type = serial[0];
    let size: number;
    let value: string;
    if (type === 0) {
      size = 0;
      value = "";
    } else if (SERIAL_INT_SIZES[type] !== undefined) {
      size = SERIAL_INT_SIZES[type];
      let numeric = 0;
      for (let i = 0; i < size; i += 1) numeric = numeric * 256 + payload[bodyOffset + i];
      value = String(numeric);
    } else if (type === 7) {
      size = 8;
      value = String(payload.readDoubleBE(bodyOffset));
    } else if (type === 8 || type === 9) {
      size = 0;
      value = type === 8 ? "0" : "1";
    } else if (type >= 12) {
      size = Math.floor((type - 12) / 2);
      value = "";
    } else {
      return undefined;
    }
    if (bodyOffset + size > payload.length) return undefined;
    columns.push(type >= 12 ? payload.subarray(bodyOffset, bodyOffset + size).toString("utf8") : value);
    bodyOffset += size;
  }
  return columns;
};

/** Read one table-leaf cell, following the overflow chain when present. */
const readLeafCellPayload = (db: DbLayout, cellOffset: number): Buffer | undefined => {
  const { data, usableSize } = db;
  const payloadLen = readVarint(data, cellOffset);
  if (payloadLen === undefined) return undefined;
  let cursor = payloadLen[1];
  const rowid = readVarint(data, cursor);
  if (rowid === undefined) return undefined;
  cursor = rowid[1];
  const total = payloadLen[0];
  if (total < 0 || total > MAX_PAYLOAD_BYTES) return undefined;

  const X = usableSize - 35;
  let local: number;
  if (total <= X) {
    local = total;
  } else {
    const M = Math.floor(((usableSize - 12) * 32) / 255) - 23;
    const K = M + ((total - M) % (usableSize - 4));
    local = K <= X ? K : M;
  }
  if (cursor + local > data.length) return undefined;
  const parts: Buffer[] = [data.subarray(cursor, cursor + local)];
  let remaining = total - local;
  let overflowPage = local < total ? data.readUInt32BE(cursor + local) : 0;
  const seenPages = new Set<number>();
  while (remaining > 0) {
    if (overflowPage === 0 || seenPages.has(overflowPage)) return undefined;
    seenPages.add(overflowPage);
    if (seenPages.size > MAX_PAGES_VISITED) return undefined;
    const pageStart = (overflowPage - 1) * db.pageSize;
    if (pageStart < 0 || pageStart + 4 > data.length) return undefined;
    const next = data.readUInt32BE(pageStart);
    const chunk = Math.min(db.usableSize - 4, remaining);
    if (pageStart + 4 + chunk > data.length) return undefined;
    parts.push(data.subarray(pageStart + 4, pageStart + 4 + chunk));
    remaining -= chunk;
    overflowPage = next;
  }
  return Buffer.concat(parts);
};

/** Walk a table B-tree; visit(columns) returns true to stop early. */
const walkTableBtree = (
  db: DbLayout,
  rootPage: number,
  visit: (columns: string[]) => boolean,
): boolean => {
  const stack = [rootPage];
  const visited = new Set<number>();
  while (stack.length > 0) {
    const pageNumber = stack.pop();
    if (pageNumber === undefined || pageNumber < 1 || visited.has(pageNumber)) continue;
    visited.add(pageNumber);
    if (visited.size > MAX_PAGES_VISITED) return false;
    const pageStart = (pageNumber - 1) * db.pageSize;
    if (pageStart < 0 || pageStart >= db.data.length) continue;
    const header = pageStart + (pageNumber === 1 ? 100 : 0);
    const type = db.data[header];
    const cellCount = db.data.readUInt16BE(header + 3);
    if (type === 13) {
      const pointerArray = header + 8;
      for (let i = 0; i < cellCount; i += 1) {
        const cellOffset = pageStart + db.data.readUInt16BE(pointerArray + i * 2);
        const payload = readLeafCellPayload(db, cellOffset);
        if (payload === undefined) continue;
        const columns = parseRecordColumns(payload);
        if (columns !== undefined && visit(columns)) return true;
      }
    } else if (type === 5) {
      const pointerArray = header + 12;
      for (let i = 0; i < cellCount; i += 1) {
        stack.push(db.data.readUInt32BE(pointerArray + i * 2));
      }
      stack.push(db.data.readUInt32BE(header + 8));
    }
    // Index pages (2 / 10) and anything else are irrelevant here.
  }
  return false;
};

/**
 * Read one string value out of a VS Code-style key/value state database
 * (`CREATE TABLE ItemTable (key TEXT, value ...)`) without any SQLite
 * dependency. Returns undefined for absent keys or unreadable files.
 */
export const readStateDbValue = (dbPath: string, wantedKey: string): string | undefined => {
  const db = openLayout(dbPath);
  if (db === undefined) return undefined;
  let found: string | undefined;
  // sqlite_master lives at root page 1; find ItemTable's rootpage first.
  walkTableBtree(db, 1, (columns) => {
    if (columns.length >= 4 && columns[0] === "table" && columns[1] === "ItemTable") {
      const rootPage = Number.parseInt(columns[3], 10);
      if (Number.isInteger(rootPage) && rootPage >= 2) {
        walkTableBtree(db, rootPage, (row) => {
          if (row.length >= 2 && row[0] === wantedKey) {
            found = row[1];
            return true;
          }
          return false;
        });
      }
      return true;
    }
    return false;
  });
  return found;
};

const APP_DB_ACCESS_TOKEN_KEY = "cursorAuth/accessToken";

/** Extract an app-auth cookie header from the Cursor desktop state DB. */
export const readAppDatabaseCookie = (
  dbPath: string,
  nowMs: number = Date.now(),
): string | undefined => {
  const accessToken = readStateDbValue(dbPath, APP_DB_ACCESS_TOKEN_KEY)?.trim();
  if (accessToken === undefined || accessToken === "") return undefined;
  return buildAppAuthCookieHeader(accessToken, nowMs);
};

// ---------------------------------------------------------------------------
// Resolution pipeline
// ---------------------------------------------------------------------------

export const resolveCursorCredential = (
  options: ResolveCursorCredentialOptions = {},
): CursorCredentialOutcome => {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();

  // Operator setting first (deliberate intent), then env var.
  const operatorCookie = options.operatorCookieHeader?.trim();
  if (operatorCookie !== undefined && operatorCookie !== "") {
    return { kind: "ok", credential: { cookieHeader: operatorCookie, origin: "operator-settings" } };
  }

  const envCookie = env.CURSOR_COOKIE?.trim();
  if (envCookie !== undefined && envCookie !== "") {
    return { kind: "ok", credential: { cookieHeader: envCookie, origin: "env" } };
  }

  const configPath = options.configPath ?? cursorConfigCookiePath(home);
  try {
    if (existsSync(configPath)) {
      const text = readFileSync(configPath, "utf8").trim();
      if (text !== "") return { kind: "ok", credential: { cookieHeader: text, origin: "config-file" } };
    }
  } catch {
    // Unreadable config file falls through to the app database.
  }

  const dbPath = options.appDbPath ?? cursorAppDbPath(home, env);
  const cookie = readAppDatabaseCookie(dbPath);
  if (cookie !== undefined) {
    return { kind: "ok", credential: { cookieHeader: cookie, origin: "app-database" } };
  }

  return {
    kind: "missing",
    error:
      "no Cursor session found - set CURSOR_COOKIE (a Cookie header from cursor.com), " +
      `place one at ${cursorConfigCookiePath(home)}, or log in to the Cursor desktop app`,
  };
};
