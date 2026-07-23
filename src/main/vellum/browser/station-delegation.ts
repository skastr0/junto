import { sign, verify, type KeyObject } from "node:crypto";
import { canonicalStationBrowserJson, decodeStationBrowserEnvelope, STATION_BROWSER_CLOCK_SKEW_MS, STATION_BROWSER_MAX_TTL_MS, type StationBrowserDenial, type StationBrowserEnvelope, type StationBrowserRequest } from "@shared/station-browser";

export interface AdmittedDelegationWitness { readonly kind: "agent-edge" | "operator-ui"; readonly stationId: string }
export interface StationBrowserTrust { readonly keyId: string; readonly publicKey: KeyObject | string | Buffer; readonly originStationId: string }
export interface StationBrowserVerificationContext { readonly stationId: string; readonly now: number; readonly currentGeneration?: (request: StationBrowserRequest) => string | undefined; readonly resolvePageHost?: (pageRef: string) => string | undefined; readonly allow?: (request: StationBrowserRequest) => boolean }
export class StationBrowserReplayCache {
  private readonly values = new Map<string, number>();
  constructor(private readonly capacity = 1024) {}
  consume(key: string, expiresAt: number, now: number): boolean { for (const [k, expiry] of this.values) if (expiry < now) this.values.delete(k); if (this.values.has(key)) return false; if (this.values.size >= this.capacity) this.values.delete(this.values.keys().next().value!); this.values.set(key, expiresAt); return true; }
}
const signed = (request: StationBrowserRequest) => Buffer.from(canonicalStationBrowserJson(request));
export const mintStationBrowserEnvelope = (witness: AdmittedDelegationWitness, request: Omit<StationBrowserRequest, "authority" | "originStationId">, keyId: string, privateKey: KeyObject | string | Buffer): StationBrowserEnvelope => {
  // The witness is main-owned: callers cannot pass principal/nodeRef/capability strings here.
  const bound: StationBrowserRequest = { ...request, authority: witness.kind, originStationId: witness.stationId };
  return { request: bound, keyId, signature: sign(null, signed(bound), privateKey).toString("base64url") };
};
export const verifyStationBrowserEnvelope = (frame: string, trust: StationBrowserTrust, context: StationBrowserVerificationContext, replays: StationBrowserReplayCache): { readonly ok: true; readonly request: StationBrowserRequest } | { readonly ok: false; readonly denial: StationBrowserDenial } => {
  const decoded = decodeStationBrowserEnvelope(frame); if (typeof decoded === "string") return { ok: false, denial: decoded };
  if (decoded.keyId !== trust.keyId) return { ok: false, denial: "key" };
  const r = decoded.request;
  if (r.originStationId !== trust.originStationId || r.targetStationId !== context.stationId || (r.session !== undefined && r.session.hostId !== context.stationId)) return { ok: false, denial: "wrong_host" };
  if (r.expiresAt - r.issuedAt > STATION_BROWSER_MAX_TTL_MS) return { ok: false, denial: "ttl" };
  if (r.issuedAt > context.now + STATION_BROWSER_CLOCK_SKEW_MS) return { ok: false, denial: "not_yet_valid" };
  if (r.expiresAt < context.now - STATION_BROWSER_CLOCK_SKEW_MS) return { ok: false, denial: "expired" };
  let good = false; try { good = verify(null, signed(r), trust.publicKey, Buffer.from(decoded.signature, "base64url")); } catch { return { ok: false, denial: "signature" }; }
  if (!good) return { ok: false, denial: "signature" };
  if (r.pageRef !== undefined && context.resolvePageHost?.(r.pageRef) !== context.stationId) return { ok: false, denial: "stale_canvas" };
  if (r.session !== undefined && context.currentGeneration?.(r) !== r.session.generation) return { ok: false, denial: "stale_generation" };
  if (context.allow !== undefined && !context.allow(r)) return { ok: false, denial: "forbidden" };
  if (!replays.consume(`${r.originStationId}:${r.nonce}`, r.expiresAt, context.now)) return { ok: false, denial: "replayed" };
  return { ok: true, request: r };
};
