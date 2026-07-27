/** Transport-free, signed station-browser protocol. No paths, tokens, or browser bytes cross this boundary. */
import { Schema } from "effect";
import { parseNodeRef } from "./node-ref";

export const STATION_BROWSER_PROTOCOL_VERSION = 1 as const;
export const STATION_BROWSER_MAX_FRAME_BYTES = 64 * 1024;
export const STATION_BROWSER_MAX_EVAL_BYTES = 8 * 1024;
export const STATION_BROWSER_MAX_TTL_MS = 60_000;
export const STATION_BROWSER_CLOCK_SKEW_MS = 5_000;
export const STATION_BROWSER_TRUST_MAX_BYTES = 16 * 1024;
export const STATION_BROWSER_TRUST_MAX_GENERATION = 1_000_000_000;
export const STATION_BROWSER_ACTIONS = [
  "doctor",
  "discover",
  "open",
  "goto",
  "eval",
  "screenshot",
  "state",
  "list",
  "close",
  "stop",
] as const;
export type StationBrowserAction = (typeof STATION_BROWSER_ACTIONS)[number];
export type StationBrowserAuthority = "agent-edge" | "operator-ui";
export interface StationBrowserSession {
  readonly hostId: string;
  readonly sessionId: string;
  readonly generation: string;
}
export interface StationBrowserRequest {
  readonly version: 1;
  readonly requestId: string;
  readonly originStationId: string;
  readonly targetStationId: string;
  readonly authority: StationBrowserAuthority;
  readonly agentRef?: string;
  readonly action: StationBrowserAction;
  readonly pageRef?: string;
  readonly session?: StationBrowserSession;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
  readonly payload?: Readonly<Record<string, string>>;
}
export interface StationBrowserEnvelope {
  readonly request: StationBrowserRequest;
  readonly keyId: string;
  readonly signature: string;
}
export type StationBrowserDenial =
  | "malformed"
  | "unsupported_version"
  | "wrong_host"
  | "expired"
  | "not_yet_valid"
  | "ttl"
  | "replayed"
  | "signature"
  | "key"
  | "algorithm"
  | "stale_generation"
  | "stale_canvas"
  | "forbidden"
  | "limits"
  | "capacity";
export type StationBrowserResponse =
  | Readonly<{
      version: 1;
      requestId: string;
      action: StationBrowserAction;
      ok: true;
      hostId: string;
      data: unknown;
    }>
  | Readonly<{
      version: 1;
      requestId: string;
      action: StationBrowserAction;
      ok: false;
      hostId: string;
      error: StationBrowserDenial;
    }>;

const encoder = new TextEncoder();
const plain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const bytes = (v: string) => encoder.encode(v).byteLength;
const text = (v: unknown, max = 512): v is string =>
  typeof v === "string" &&
  bytes(v) > 0 &&
  bytes(v) <= max &&
  !/[\u0000-\u001f\u007f]/.test(v);
const id = (v: unknown): v is string =>
  text(v, 128) && /^[A-Za-z0-9._:-]+$/.test(v);
export const isStationBrowserKeyId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v);
export const isStationBrowserSignature = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{86}$/.test(v);
export const StationBrowserKeyId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(64),
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
);
export const StationBrowserStationId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128),
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
);
export const StationBrowserTrustGeneration = Schema.Number.pipe(
  Schema.int(),
  Schema.between(1, STATION_BROWSER_TRUST_MAX_GENERATION),
);
export const StationBrowserTrustTimestamp = Schema.Number.pipe(
  Schema.int(),
  Schema.between(0, Number.MAX_SAFE_INTEGER),
);
export const StationBrowserPublicKeySpki = Schema.String.pipe(
  Schema.minLength(16),
  Schema.maxLength(1_024),
  Schema.pattern(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
  ),
);

/**
 * Public half of Command Center browser delegation trust.
 *
 * Private key material is deliberately absent: this record is the complete
 * configure-time seam that a Remote may persist. Cryptographic admission
 * additionally verifies that an active SPKI is Ed25519 and hashes to `keyId`.
 */
export const StationBrowserPinnedTrustRecord = Schema.Struct({
  version: Schema.Literal(1),
  generation: StationBrowserTrustGeneration,
  keyId: StationBrowserKeyId,
  originStationId: StationBrowserStationId,
  status: Schema.Literal("active", "revoked"),
  publicKeySpki: Schema.NullOr(StationBrowserPublicKeySpki),
  replacesKeyId: Schema.NullOr(StationBrowserKeyId),
  updatedAt: StationBrowserTrustTimestamp,
}).pipe(
  Schema.filter(
    (record) =>
      (record.status === "active" && record.publicKeySpki !== null) ||
      (record.status === "revoked" && record.publicKeySpki === null) ||
      "active trust requires a public key and revoked trust must erase it",
  ),
);
export type StationBrowserPinnedTrustRecord =
  typeof StationBrowserPinnedTrustRecord.Type;
export const decodeStationBrowserPinnedTrustRecord = Schema.decodeUnknownSync(
  StationBrowserPinnedTrustRecord,
);
const exact = (o: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(o).length === keys.length && keys.every((key) => key in o);
const session = (value: unknown): value is StationBrowserSession =>
  plain(value) &&
  exact(value, ["hostId", "sessionId", "generation"]) &&
  id(value.hostId) &&
  id(value.sessionId) &&
  id(value.generation);
const pageRef = (value: unknown): value is string =>
  typeof value === "string" && parseNodeRef(value).ok;
const payload = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, string> =>
  plain(value) &&
  exact(value, keys) &&
  Object.entries(value).every(([key, item]) =>
    text(item, key === "code" ? STATION_BROWSER_MAX_EVAL_BYTES : 4096),
  );

/** Finds duplicate fields per object scope, without conflating repeated row fields in an array. */
const rejectsDuplicateObjectFields = (source: string): boolean => {
  let i = 0;
  const ws = () => {
    while (/\s/.test(source[i] ?? "")) i += 1;
  };
  const string = () => {
    const start = i++;
    for (; i < source.length; i += 1) {
      if (source[i] === "\\") {
        i += 1;
        continue;
      }
      if (source[i] === '"') {
        i += 1;
        return source.slice(start, i);
      }
    }
    throw new Error("string");
  };
  const value = (): void => {
    ws();
    if (source[i] === "{") {
      i++;
      const seen = new Set<string>();
      ws();
      if (source[i] === "}") {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (source[i] !== '"') throw new Error("key");
        const key = JSON.parse(string()) as string;
        if (seen.has(key)) throw new Error("duplicate");
        seen.add(key);
        ws();
        if (source[i++] !== ":") throw new Error("colon");
        value();
        ws();
        if (source[i] === "}") {
          i++;
          return;
        }
        if (source[i++] !== ",") throw new Error("comma");
      }
    }
    if (source[i] === "[") {
      i++;
      ws();
      if (source[i] === "]") {
        i++;
        return;
      }
      for (;;) {
        value();
        ws();
        if (source[i] === "]") {
          i++;
          return;
        }
        if (source[i++] !== ",") throw new Error("comma");
      }
    }
    if (source[i] === '"') {
      string();
      return;
    }
    const start = i;
    while (i < source.length && !/[\s,}\]]/.test(source[i]!)) i++;
    if (start === i) throw new Error("value");
  };
  try {
    value();
    ws();
    return i !== source.length;
  } catch {
    return true;
  }
};
export const canonicalStationBrowserJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map(canonicalStationBrowserJson).join(",")}]`;
  if (plain(value))
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) => `${JSON.stringify(k)}:${canonicalStationBrowserJson(value[k])}`,
      )
      .join(",")}}`;
  throw new Error("non-JSON value");
};
type StationBrowserJsonDecode =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; denial: StationBrowserDenial }>;
const decodeJson = (frame: string): StationBrowserJsonDecode => {
  if (bytes(frame) > STATION_BROWSER_MAX_FRAME_BYTES) {
    return { ok: false, denial: "limits" };
  }
  if (rejectsDuplicateObjectFields(frame)) {
    return { ok: false, denial: "malformed" };
  }
  try {
    return { ok: true, value: JSON.parse(frame) };
  } catch {
    return { ok: false, denial: "malformed" };
  }
};
const normalizedRequest = (
  value: Record<string, unknown>,
): StationBrowserRequest => {
  const { agentRef, pageRef, session, payload, ...required } = value;
  return {
    ...required,
    ...(typeof agentRef === "string" ? { agentRef } : {}),
    ...(typeof pageRef === "string" ? { pageRef } : {}),
    ...(session !== null ? { session: session as StationBrowserSession } : {}),
    ...(payload !== null ? { payload: payload as Record<string, string> } : {}),
  } as StationBrowserRequest;
};
export const decodeStationBrowserRequest = (
  frame: string,
): StationBrowserRequest | StationBrowserDenial => {
  const decoded = decodeJson(frame);
  if (!decoded.ok) return decoded.denial;
  const value = decoded.value;
  if (
    !plain(value) ||
    !exact(value, [
      "version",
      "requestId",
      "originStationId",
      "targetStationId",
      "authority",
      "agentRef",
      "action",
      "pageRef",
      "session",
      "issuedAt",
      "expiresAt",
      "nonce",
      "payload",
    ])
  )
    return "malformed";
  if (value.version !== 1) return "unsupported_version";
  if (
    !id(value.requestId) ||
    !id(value.originStationId) ||
    !id(value.targetStationId) ||
    !id(value.nonce) ||
    typeof value.issuedAt !== "number" ||
    !Number.isSafeInteger(value.issuedAt) ||
    value.issuedAt < 0 ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt < 0 ||
    (value.authority !== "agent-edge" && value.authority !== "operator-ui") ||
    !STATION_BROWSER_ACTIONS.includes(value.action as StationBrowserAction)
  )
    return "malformed";
  if (
    (value.authority === "agent-edge" && !pageRef(value.agentRef)) ||
    (value.authority === "operator-ui" && value.agentRef !== null)
  )
    return "malformed";
  const action = value.action as StationBrowserAction;
  const noTarget =
    action === "doctor" || action === "discover" || action === "list";
  if (noTarget)
    return value.pageRef === null &&
      value.session === null &&
      value.payload === null
      ? normalizedRequest(value)
      : "malformed";
  if (!pageRef(value.pageRef)) return "malformed";
  if (action === "open")
    return value.session === null && value.payload === null
      ? normalizedRequest(value)
      : "malformed";
  if (!session(value.session)) return "malformed";
  if (action === "goto")
    return payload(value.payload, ["url"])
      ? normalizedRequest(value)
      : "malformed";
  if (action === "eval")
    return payload(value.payload, ["code"])
      ? normalizedRequest(value)
      : "malformed";
  return value.payload === null ? normalizedRequest(value) : "malformed";
};
export const decodeStationBrowserEnvelope = (
  frame: string,
): StationBrowserEnvelope | StationBrowserDenial => {
  const decoded = decodeJson(frame);
  if (!decoded.ok) return decoded.denial;
  const value = decoded.value;
  if (
    !plain(value) ||
    !exact(value, ["request", "keyId", "signature"]) ||
    !isStationBrowserKeyId(value.keyId) ||
    !isStationBrowserSignature(value.signature) ||
    !plain(value.request)
  )
    return "malformed";
  const request = decodeStationBrowserRequest(
    canonicalStationBrowserJson(value.request),
  );
  return typeof request === "string"
    ? request
    : { request, keyId: value.keyId, signature: value.signature };
};
const responseData = (
  action: StationBrowserAction,
  value: unknown,
): boolean => {
  if (action === "doctor")
    return (
      plain(value) &&
      exact(value, ["role", "browserReady"]) &&
      (value.role === "command-center" || value.role === "remote") &&
      typeof value.browserReady === "boolean"
    );
  if (action === "discover")
    return (
      plain(value) &&
      exact(value, ["pages"]) &&
      Array.isArray(value.pages) &&
      value.pages.length <= 128 &&
      value.pages.every(
        (row) =>
          plain(row) &&
          exact(row, ["pageRef", "hostId"]) &&
          pageRef(row.pageRef) &&
          id(row.hostId),
      )
    );
  if (action === "list")
    return (
      plain(value) &&
      exact(value, ["sessions"]) &&
      Array.isArray(value.sessions) &&
      value.sessions.length <= 128 &&
      value.sessions.every(session)
    );
  if (action === "eval") {
    try {
      return (
        plain(value) &&
        exact(value, ["result"]) &&
        bytes(canonicalStationBrowserJson(value.result)) <=
          STATION_BROWSER_MAX_EVAL_BYTES
      );
    } catch {
      return false;
    }
  }
  if (action === "screenshot")
    return (
      plain(value) &&
      exact(value, ["artifact"]) &&
      plain(value.artifact) &&
      exact(value.artifact, ["hostId", "artifactRef"]) &&
      id(value.artifact.hostId) &&
      id(value.artifact.artifactRef)
    );
  return plain(value) && exact(value, ["session"]) && session(value.session);
};
export const decodeStationBrowserResponse = (
  frame: string,
): StationBrowserResponse | StationBrowserDenial => {
  const decoded = decodeJson(frame);
  if (!decoded.ok) return decoded.denial;
  const value = decoded.value;
  if (
    !plain(value) ||
    !exact(value, [
      "version",
      "requestId",
      "action",
      "ok",
      "hostId",
      "data",
      "error",
    ]) ||
    value.version !== 1 ||
    !id(value.requestId) ||
    !id(value.hostId) ||
    !STATION_BROWSER_ACTIONS.includes(value.action as StationBrowserAction) ||
    typeof value.ok !== "boolean"
  )
    return "malformed";
  if (!value.ok)
    return value.data === null &&
      typeof value.error === "string" &&
      [
        "malformed",
        "unsupported_version",
        "wrong_host",
        "expired",
        "not_yet_valid",
        "ttl",
        "replayed",
        "signature",
        "key",
        "algorithm",
        "stale_generation",
        "stale_canvas",
        "forbidden",
        "limits",
        "capacity",
      ].includes(value.error)
      ? (value as StationBrowserResponse)
      : "malformed";
  return value.error === null &&
    responseData(value.action as StationBrowserAction, value.data)
    ? (value as StationBrowserResponse)
    : "malformed";
};
