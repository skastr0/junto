/**
 * Station browser delegation wire contract.  This is deliberately transport-free:
 * the SSH wrapper is a later concern and may only carry these bounded frames.
 */
import { parseNodeRef } from "./node-ref";

export const STATION_BROWSER_PROTOCOL_VERSION = 1 as const;
export const STATION_BROWSER_MAX_FRAME_BYTES = 64 * 1024;
export const STATION_BROWSER_MAX_EVAL_BYTES = 8 * 1024;
export const STATION_BROWSER_MAX_URL_BYTES = 4096;
export const STATION_BROWSER_MAX_TTL_MS = 60_000;
export const STATION_BROWSER_CLOCK_SKEW_MS = 5_000;

export const STATION_BROWSER_ACTIONS = [
  "doctor", "discover", "open", "goto", "eval", "screenshot", "state", "list", "close", "stop",
] as const;
export type StationBrowserAction = (typeof STATION_BROWSER_ACTIONS)[number];
export type StationBrowserAuthority = "agent-edge" | "operator-ui";
export interface StationBrowserSession { readonly hostId: string; readonly sessionId: string; readonly generation: string }
export interface StationBrowserRequest {
  readonly version: 1; readonly requestId: string; readonly originStationId: string; readonly targetStationId: string;
  readonly authority: StationBrowserAuthority; readonly action: StationBrowserAction; readonly pageRef?: string;
  readonly session?: StationBrowserSession; readonly issuedAt: number; readonly expiresAt: number; readonly nonce: string;
  readonly payload?: Readonly<Record<string, string>>;
}
export interface StationBrowserEnvelope { readonly request: StationBrowserRequest; readonly keyId: string; readonly signature: string }
export interface StationBrowserResponse { readonly version: 1; readonly requestId: string; readonly ok: boolean; readonly hostId: string; readonly data?: Readonly<Record<string, string>>; readonly error?: StationBrowserDenial }
export type StationBrowserDenial = "malformed" | "unsupported_version" | "wrong_host" | "expired" | "not_yet_valid" | "ttl" | "replayed" | "signature" | "key" | "stale_generation" | "stale_canvas" | "forbidden" | "limits";

const encoder = new TextEncoder();
const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 512): v is string => typeof v === "string" && encoder.encode(v).byteLength > 0 && encoder.encode(v).byteLength <= max && !/[\u0000-\u001f\u007f]/.test(v);
const id = (v: unknown): v is string => text(v, 128) && /^[A-Za-z0-9._:-]+$/.test(v);
const exact = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((key) => key in o);
const only = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).every((key) => keys.includes(key));
// JSON.parse silently accepts duplicate object keys. The protocol forbids them;
// rejecting repeated quoted field names is intentionally conservative.
const duplicateKey = (frame: string): boolean => {
  const keys = frame.match(/"(?:\\.|[^"\\])*"(?=\s*:)/g) ?? [];
  const seen = new Set<string>();
  return keys.some((key) => (seen.has(key) ? true : (seen.add(key), false)));
};

/** Stable JSON used as the exact signed bytes; it accepts only JSON primitives/arrays/objects. */
export const canonicalStationBrowserJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("non-finite number"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalStationBrowserJson).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalStationBrowserJson(value[k])}`).join(",")}}`;
  throw new Error("non-JSON value");
};

export const decodeStationBrowserRequest = (frame: string): StationBrowserRequest | StationBrowserDenial => {
  if (encoder.encode(frame).byteLength > STATION_BROWSER_MAX_FRAME_BYTES) return "limits";
  if (duplicateKey(frame)) return "malformed";
  let value: unknown; try { value = JSON.parse(frame); } catch { return "malformed"; }
  if (!plain(value) || !only(value, ["version", "requestId", "originStationId", "targetStationId", "authority", "action", "pageRef", "session", "issuedAt", "expiresAt", "nonce", "payload"]) || !["version", "requestId", "originStationId", "targetStationId", "authority", "action", "issuedAt", "expiresAt", "nonce"].every((key) => key in value)) return "malformed";
  const r = value as Record<string, unknown>;
  if (r.version !== 1) return "unsupported_version";
  if (!id(r.requestId) || !id(r.originStationId) || !id(r.targetStationId) || !id(r.nonce) || (r.authority !== "agent-edge" && r.authority !== "operator-ui") || !STATION_BROWSER_ACTIONS.includes(r.action as StationBrowserAction) || !Number.isSafeInteger(r.issuedAt) || !Number.isSafeInteger(r.expiresAt)) return "malformed";
  if (r.pageRef !== undefined && r.pageRef !== null && (typeof r.pageRef !== "string" || !parseNodeRef(r.pageRef).ok)) return "malformed";
  if (r.session !== undefined && r.session !== null) { if (!plain(r.session) || !exact(r.session, ["hostId", "sessionId", "generation"]) || !id(r.session.hostId) || !id(r.session.sessionId) || !id(r.session.generation)) return "malformed"; }
  if (r.payload !== undefined && r.payload !== null) { if (!plain(r.payload) || Object.keys(r.payload).length > 8 || Object.entries(r.payload).some(([k, v]) => !id(k) || !text(v, k === "code" ? STATION_BROWSER_MAX_EVAL_BYTES : STATION_BROWSER_MAX_URL_BYTES))) return "malformed"; }
  const action = r.action as StationBrowserAction;
  if (["open", "goto", "eval", "screenshot", "state", "close", "stop"].includes(action) && typeof r.pageRef !== "string") return "malformed";
  if (["goto", "eval", "screenshot", "state", "close", "stop"].includes(action) && r.session === null) return "malformed";
  return r as unknown as StationBrowserRequest;
};

export const decodeStationBrowserEnvelope = (frame: string): StationBrowserEnvelope | StationBrowserDenial => {
  if (encoder.encode(frame).byteLength > STATION_BROWSER_MAX_FRAME_BYTES) return "limits";
  if (duplicateKey(frame)) return "malformed";
  let value: unknown; try { value = JSON.parse(frame); } catch { return "malformed"; }
  if (!plain(value) || !exact(value, ["request", "keyId", "signature"]) || !id(value.keyId) || !text(value.signature, 256) || !plain(value.request)) return "malformed";
  const request = decodeStationBrowserRequest(canonicalStationBrowserJson(value.request));
  return typeof request === "string" ? request : { request, keyId: value.keyId, signature: value.signature };
};

/** Typed target reply admission; screenshot data is only a host-local artifact ref. */
export const decodeStationBrowserResponse = (frame: string): StationBrowserResponse | StationBrowserDenial => {
  if (encoder.encode(frame).byteLength > STATION_BROWSER_MAX_FRAME_BYTES || duplicateKey(frame)) return "limits";
  let value: unknown; try { value = JSON.parse(frame); } catch { return "malformed"; }
  if (!plain(value) || !only(value, ["version", "requestId", "ok", "hostId", "data", "error"]) || !["version", "requestId", "ok", "hostId"].every((key) => key in value)) return "malformed";
  if (value.version !== 1) return "unsupported_version";
  if (!id(value.requestId) || !id(value.hostId) || typeof value.ok !== "boolean") return "malformed";
  if (value.data !== undefined && (!plain(value.data) || Object.keys(value.data).length > 8 || Object.entries(value.data).some(([k, v]) => !id(k) || !text(v, 4096)))) return "malformed";
  if (value.error !== undefined && (typeof value.error !== "string" || !["malformed", "unsupported_version", "wrong_host", "expired", "not_yet_valid", "ttl", "replayed", "signature", "key", "stale_generation", "stale_canvas", "forbidden", "limits"].includes(value.error))) return "malformed";
  if ((value.ok && value.error !== undefined) || (!value.ok && value.error === undefined)) return "malformed";
  return value as unknown as StationBrowserResponse;
};
