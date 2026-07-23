import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalStationBrowserJson, decodeStationBrowserEnvelope, decodeStationBrowserResponse, type StationBrowserRequest } from "../src/shared/station-browser";
import { mintStationBrowserEnvelope, StationBrowserReplayCache, verifyStationBrowserEnvelope } from "../src/main/vellum/browser/station-delegation";

const keys = generateKeyPairSync("ed25519");
const now = 1_700_000_000_000;
const base = (): Omit<StationBrowserRequest, "authority" | "originStationId"> => ({ version: 1, requestId: "request-1", targetStationId: "remote-a", action: "state", pageRef: "vellum://canvas/work?node=page-1", session: { hostId: "remote-a", sessionId: "session-1", generation: "generation-1" }, issuedAt: now, expiresAt: now + 30_000, nonce: "nonce-1" });
const frame = (request = base()) => JSON.stringify(mintStationBrowserEnvelope({ kind: "agent-edge", stationId: "command-a" }, request, "fleet-1", keys.privateKey));
const context = (overrides = {}) => ({ stationId: "remote-a", now, resolvePageHost: () => "remote-a", currentGeneration: () => "generation-1", allow: () => true, ...overrides });
const trust = { keyId: "fleet-1", publicKey: keys.publicKey, originStationId: "command-a" };

describe("station browser delegation", () => {
  it("signs fixed canonical bytes and verifies a main-witness bound delegation", () => {
    expect(canonicalStationBrowserJson({ b: 1, a: [true, "x"] })).toBe('{"a":[true,"x"],"b":1}');
    expect(verifyStationBrowserEnvelope(frame(), trust, context(), new StationBrowserReplayCache())).toMatchObject({ ok: true, request: { authority: "agent-edge", originStationId: "command-a" } });
  });
  it("denies replay, wrong host, stale canvas/generation, policy, and clock failures", () => {
    const replay = new StationBrowserReplayCache(); const valid = frame();
    expect(verifyStationBrowserEnvelope(valid, trust, context(), replay)).toMatchObject({ ok: true });
    expect(verifyStationBrowserEnvelope(valid, trust, context(), replay)).toEqual({ ok: false, denial: "replayed" });
    expect(verifyStationBrowserEnvelope(frame(), trust, context({ stationId: "other" }), new StationBrowserReplayCache())).toEqual({ ok: false, denial: "wrong_host" });
    expect(verifyStationBrowserEnvelope(frame(), trust, context({ resolvePageHost: () => "other" }), new StationBrowserReplayCache())).toEqual({ ok: false, denial: "stale_canvas" });
    expect(verifyStationBrowserEnvelope(frame(), trust, context({ currentGeneration: () => "old" }), new StationBrowserReplayCache())).toEqual({ ok: false, denial: "stale_generation" });
    expect(verifyStationBrowserEnvelope(frame(), trust, context({ allow: () => false }), new StationBrowserReplayCache())).toEqual({ ok: false, denial: "forbidden" });
    expect(verifyStationBrowserEnvelope(frame({ ...base(), expiresAt: now - 6_000 }), trust, context(), new StationBrowserReplayCache())).toEqual({ ok: false, denial: "expired" });
  });
  it("fails closed on bad signature, downgrade, duplicate fields, bad NodeRef, excess TTL, and oversized input", () => {
    const signed = JSON.parse(frame()) as { signature: string; request: Record<string, unknown> };
    signed.signature = signed.signature.slice(1) + "A";
    expect(verifyStationBrowserEnvelope(JSON.stringify(signed), trust, context(), new StationBrowserReplayCache())).toEqual({ ok: false, denial: "signature" });
    expect(decodeStationBrowserEnvelope('{"request":{},"request":{},"keyId":"x","signature":"x"}')).toBe("malformed");
    expect(decodeStationBrowserEnvelope(JSON.stringify({ ...JSON.parse(frame()), request: { ...JSON.parse(frame()).request, pageRef: "vellum://canvas/work?node=%61" } }))).toBe("malformed");
    expect(verifyStationBrowserEnvelope(frame({ ...base(), expiresAt: now + 60_001 }), trust, context(), new StationBrowserReplayCache())).toEqual({ ok: false, denial: "ttl" });
    expect(decodeStationBrowserEnvelope("x".repeat(70_000))).toBe("limits");
    expect(decodeStationBrowserResponse('{"version":1,"requestId":"request-1","ok":true,"hostId":"remote-a","data":{"artifactRef":"local-shot-1"}}')).toMatchObject({ ok: true });
    expect(decodeStationBrowserResponse('{"version":1,"requestId":"request-1","ok":true,"hostId":"remote-a","error":"forbidden"}')).toBe("malformed");
  });
});
