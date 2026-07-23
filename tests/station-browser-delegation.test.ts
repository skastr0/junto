import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalStationBrowserJson, decodeStationBrowserEnvelope, decodeStationBrowserRequest, decodeStationBrowserResponse, type StationBrowserAction, type StationBrowserRequest } from "../src/shared/station-browser";
import { admitAgentEdgeDelegation, admitOperatorUiDelegation, mintStationBrowserEnvelope, StationBrowserReplayCache, verifyStationBrowserEnvelope } from "../src/main/vellum/browser/station-delegation";

const keys = generateKeyPairSync("ed25519"); const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }); const now = 1_700_000_000_000;
const pageRef = "vellum://canvas/work?node=page-1"; const agentRef = "vellum://canvas/work?node=agent-1";
const base = (action: StationBrowserAction = "state"): Omit<StationBrowserRequest, "authority" | "originStationId" | "agentRef"> => ({ version: 1, requestId: "request-1", targetStationId: "remote-a", action, pageRef: action === "doctor" || action === "discover" || action === "list" ? undefined : pageRef, session: ["goto", "eval", "screenshot", "state", "close", "stop"].includes(action) ? { hostId: "remote-a", sessionId: "session-1", generation: "generation-1" } : undefined, issuedAt: now, expiresAt: now + 30_000, nonce: `nonce-${action}`, ...(action === "goto" ? { payload: { url: "https://example.com" } } : action === "eval" ? { payload: { code: "1+1" } } : {}) });
const wire = (request: ReturnType<typeof base>) => ({ ...request, authority: "agent-edge", originStationId: "command-a", agentRef, pageRef: request.pageRef ?? null, session: request.session ?? null, payload: request.payload ?? null });
const frame = (request = base()) => JSON.stringify(mintStationBrowserEnvelope(admitAgentEdgeDelegation({ stationId: "command-a", canonicalAgentRef: agentRef }), request, "fleet-1", keys.privateKey));
const trust = { keyId: "fleet-1", publicKey: keys.publicKey, originStationId: "command-a" };
const context = (changes = {}) => ({ stationId: "remote-a", now, role: "remote" as const, browserReady: true, resolvePage: () => ({ hostId: "remote-a", edgeAllowed: true, profileAllowed: true }), currentGeneration: () => "generation-1", allowAction: () => true, ...changes });

describe("station browser delegation", () => {
  it("accepts exactly every action shape and rejects absent/extra/wrong action fields", () => {
    for (const action of ["doctor", "discover", "open", "goto", "eval", "screenshot", "state", "list", "close", "stop"] as const) expect(decodeStationBrowserRequest(JSON.stringify(wire(base(action))))).not.toBe("malformed");
    expect(decodeStationBrowserRequest(JSON.stringify({ ...wire(base("state")), session: null }))).toBe("malformed");
    expect(decodeStationBrowserRequest(JSON.stringify({ ...wire(base("doctor")), pageRef }))).toBe("malformed");
    expect(decodeStationBrowserRequest(JSON.stringify({ ...wire(base("goto")), payload: { code: "x" } }))).toBe("malformed");
    expect(decodeStationBrowserRequest(JSON.stringify({ ...wire(base("eval")), extra: true }))).toBe("malformed");
    expect(decodeStationBrowserRequest(JSON.stringify({ ...wire(base()), issuedAt: -1 }))).toBe("malformed");
    expect(decodeStationBrowserRequest(JSON.stringify({ ...wire(base()), expiresAt: now + 0.5 }))).toBe("malformed");
  });
  it("signs canonical bytes only from a main-admitted witness", () => {
    expect(canonicalStationBrowserJson({ b: 1, a: [true, "x"] })).toBe('{"a":[true,"x"],"b":1}');
    expect(verifyStationBrowserEnvelope(frame(), trust, context(), new StationBrowserReplayCache())).toMatchObject({ ok: true, request: { authority: "agent-edge", agentRef } });
    expect(() => mintStationBrowserEnvelope({} as never, base(), "fleet-1", keys.privateKey)).toThrow("main-admitted");
    expect(mintStationBrowserEnvelope(admitOperatorUiDelegation("command-a"), base("doctor"), "fleet-1", keys.privateKey).request.agentRef).toBeNull();
  });
  it("denies replay/capacity/key/algorithm/time/host/canvas/generation/policy failures", () => {
    const replay = new StationBrowserReplayCache(1); const valid = frame(); expect(verifyStationBrowserEnvelope(valid, trust, context(), replay)).toMatchObject({ ok: true }); expect(verifyStationBrowserEnvelope(valid, trust, context(), replay)).toEqual({ ok: false, denial: "replayed" });
    expect(verifyStationBrowserEnvelope(frame({ ...base(), nonce: "another" }), trust, context(), replay)).toEqual({ ok: false, denial: "capacity" });
    expect(verifyStationBrowserEnvelope(frame(), { ...trust, keyId: "other" }, context(), new StationBrowserReplayCache())).toEqual({ ok: false, denial: "key" });
    expect(verifyStationBrowserEnvelope(frame(), { ...trust, publicKey: rsa.publicKey }, context(), new StationBrowserReplayCache())).toEqual({ ok: false, denial: "algorithm" });
    expect(verifyStationBrowserEnvelope(frame({ ...base(), expiresAt: now }), trust, context(), new StationBrowserReplayCache())).toEqual({ ok: false, denial: "ttl" });
    expect(verifyStationBrowserEnvelope(frame(), trust, context({ browserReady: false }), new StationBrowserReplayCache())).toEqual({ ok: false, denial: "wrong_host" });
    expect(verifyStationBrowserEnvelope(frame(), trust, context({ resolvePage: () => undefined }), new StationBrowserReplayCache())).toEqual({ ok: false, denial: "stale_canvas" });
    expect(verifyStationBrowserEnvelope(frame(), trust, context({ currentGeneration: () => "old" }), new StationBrowserReplayCache())).toEqual({ ok: false, denial: "stale_generation" });
    expect(verifyStationBrowserEnvelope(frame(), trust, context({ allowAction: () => false }), new StationBrowserReplayCache())).toEqual({ ok: false, denial: "forbidden" });
  });
  it("rejects malformed base64/duplicate fields without rejecting repeated row fields, and bounds typed replies", () => {
    expect(decodeStationBrowserEnvelope('{"request":{},"request":{},"keyId":"x","signature":"x"}')).toBe("malformed");
    expect(decodeStationBrowserEnvelope(JSON.stringify({ request: wire(base()), keyId: "bad/key", signature: "x".repeat(86) }))).toBe("malformed");
    expect(decodeStationBrowserEnvelope("x".repeat(70_000))).toBe("limits");
    const pages = '{"version":1,"requestId":"r","action":"list","ok":true,"hostId":"remote-a","data":{"pages":[{"pageRef":"vellum://canvas/work?node=a","hostId":"remote-a","profile":"p"},{"pageRef":"vellum://canvas/work?node=b","hostId":"remote-a","profile":"p"}]},"error":null}'; expect(decodeStationBrowserResponse(pages)).not.toBe("malformed");
    expect(decodeStationBrowserResponse('{"version":1,"requestId":"r","action":"screenshot","ok":true,"hostId":"remote-a","data":{"artifact":{"hostId":"remote-a","artifactRef":"artifact-1"}},"error":null}')).not.toBe("malformed");
    expect(decodeStationBrowserResponse('{"version":1,"requestId":"r","action":"state","ok":true,"hostId":"remote-a","data":{},"error":null}')).toBe("malformed");
  });
});
