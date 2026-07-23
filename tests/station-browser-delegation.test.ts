import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalStationBrowserJson, decodeStationBrowserEnvelope, decodeStationBrowserRequest, decodeStationBrowserResponse, type StationBrowserAction, type StationBrowserRequest } from "../src/shared/station-browser";
import type { CanvasDoc } from "../src/shared/canvas";
import { admitAgentEdgeDelegation, admitOperatorUiDelegation, mintStationBrowserEnvelope, StationBrowserReplayCache, verifyStationBrowserEnvelope, type AdmittedDelegationWitness } from "../src/main/vellum/browser/station-delegation";
import { makeEdgeGrantService, type EdgeGrantService } from "../src/main/vellum/browser/edge-grant";
import { makeBrowserCapabilityRegistry, type BrowserCapabilityRegistry } from "../src/main/vellum/browser/capabilities";
import { makeProcessIdentityMap, type ProcessIdentityMap } from "../src/main/vellum/process-identity";
import { admitBrowserHostCapability, type BrowserHostCapabilityAuthority } from "../src/main/vellum/browser/host-capability";

const keys = generateKeyPairSync("ed25519"); const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }); const now = 1_700_000_000_000;
const pageRef = "vellum://canvas/work?node=page-1"; const agentRef = "vellum://canvas/work?node=agent-1";
const base = (action: StationBrowserAction = "state"): Omit<StationBrowserRequest, "authority" | "originStationId" | "agentRef"> => ({ version: 1, requestId: "request-1", targetStationId: "remote-a", action, pageRef: action === "doctor" || action === "discover" || action === "list" ? undefined : pageRef, session: ["goto", "eval", "screenshot", "state", "close", "stop"].includes(action) ? { hostId: "remote-a", sessionId: "session-1", generation: "generation-1" } : undefined, issuedAt: now, expiresAt: now + 30_000, nonce: `nonce-${action}`, ...(action === "goto" ? { payload: { url: "https://example.com" } } : action === "eval" ? { payload: { code: "1+1" } } : {}) });
const wire = (request: ReturnType<typeof base>) => ({ ...request, authority: "agent-edge", originStationId: "command-a", agentRef, pageRef: request.pageRef ?? null, session: request.session ?? null, payload: request.payload ?? null });
let agentWitness: AdmittedDelegationWitness;
let admissionRoot: string;
let admissionRegistry: BrowserCapabilityRegistry;
let admissionProcessMap: ProcessIdentityMap;
let admissionEdgeGrant: EdgeGrantService;
let admissionCanvas: CanvasDoc;
const admissionSocket = {} as Socket;
const frame = (request = base()) => JSON.stringify(mintStationBrowserEnvelope(agentWitness, request, "fleet-1", keys.privateKey));
const trust = { keyId: "fleet-1", publicKey: keys.publicKey, originStationId: "command-a" };
const context = (changes = {}) => ({ stationId: "remote-a", now, role: "remote" as const, browserReady: true, resolvePage: () => ({ hostId: "remote-a", edgeAllowed: true, policyAllowed: true }), currentGeneration: () => "generation-1", allowAction: () => true, ...changes });
const remoteBrowserAuthority: BrowserHostCapabilityAuthority = {
  findHost: (hostId) =>
    hostId === "remote-a"
      ? {
          id: "remote-a",
          label: "remote-a",
          kind: "remote",
          endpoint: "remote-a",
          capabilities: ["browser"],
        }
      : undefined,
  station: () => ({ hostId: "remote-a", role: "remote" }),
};

beforeAll(async () => {
  admissionRoot = await mkdtemp(join(tmpdir(), "vellum-station-delegation-"));
  await writeFile(join(admissionRoot, "work.canvas"), "{}", "utf8");
  admissionCanvas = {
    nodes: [
      {
        id: "agent-1",
        type: "text",
        text: "agent",
        x: 0,
        y: 0,
        width: 120,
        height: 48,
        ether: { entity: { kind: "agent", name: "local:default" }, host: "remote-a" },
      },
      {
        id: "page-1",
        type: "link",
        url: "https://example.com/",
        x: 200,
        y: 0,
        width: 120,
        height: 48,
        ether: { entity: { kind: "page" }, browser: { profile: "synthetic" }, host: "remote-a" },
      },
    ],
    edges: [{ id: "edge-1", fromNode: "agent-1", toNode: "page-1" }],
  };
  admissionProcessMap = makeProcessIdentityMap();
  if (!admissionProcessMap.bind(process.pid, {
    kind: "agent",
    agentKey: "local:default",
    canvasName: "work",
    nodeId: "agent-1",
  })) {
    throw new Error("test process could not be registered for process-bind");
  }
  admissionRegistry = makeBrowserCapabilityRegistry();
  admissionEdgeGrant = makeEdgeGrantService({
    capabilities: admissionRegistry,
    canvasesDir: admissionRoot,
    processMap: admissionProcessMap,
    readPeerPid: () => process.pid,
    readCanvas: async (name) => name === "work" ? admissionCanvas : undefined,
    resolvePageTarget: async (candidate) => candidate === pageRef
      ? {
          ok: true,
          data: {
            ref: pageRef,
            nodeId: "page-1",
            hostId: "remote-a",
            url: "https://example.com/",
            profile: "synthetic",
          },
        }
      : { ok: false, code: "not_found", message: "missing page" },
    station: remoteBrowserAuthority.station,
    admitBrowserHost: (hostId) =>
      admitBrowserHostCapability(hostId, remoteBrowserAuthority),
  });
  agentWitness = await admitAgentEdgeDelegation({
    stationId: "command-a",
    socket: admissionSocket,
    edgeGrant: admissionEdgeGrant,
  });
});

afterAll(async () => {
  admissionProcessMap.clear();
  admissionEdgeGrant.clear();
  admissionRegistry.close();
  await rm(admissionRoot, { recursive: true, force: true });
});

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
  it("requires live process-bind and a human edge before admitting agent delegation", async () => {
    if (false) {
      // @ts-expect-error Locator strings are not process-bind or edge authority.
      void admitAgentEdgeDelegation({ stationId: "command-a", canonicalAgentRef: agentRef });
    }
    await expect(admitAgentEdgeDelegation({
      stationId: "command-a",
      canonicalAgentRef: agentRef,
    } as never)).rejects.toThrow("process-bound edge admission");

    admissionProcessMap.clear();
    admissionEdgeGrant.clear();
    await expect(admitAgentEdgeDelegation({
      stationId: "command-a",
      socket: admissionSocket,
      edgeGrant: admissionEdgeGrant,
    })).rejects.toThrow("process-bound edge admission");

    expect(admissionProcessMap.bind(process.pid, {
      kind: "agent",
      agentKey: "local:default",
    })).toBe(true);
    await expect(admitAgentEdgeDelegation({
      stationId: "command-a",
      socket: admissionSocket,
      edgeGrant: admissionEdgeGrant,
    })).rejects.toThrow("canvas-pinned agent process");

    admissionProcessMap.clear();
    admissionEdgeGrant.clear();
    expect(admissionProcessMap.bind(process.pid, {
      kind: "agent",
      agentKey: "local:default",
      canvasName: "work",
      nodeId: "agent-1",
    })).toBe(true);
    admissionCanvas = { ...admissionCanvas, edges: [] };
    admissionEdgeGrant.invalidateCanvas?.("work");
    await expect(admitAgentEdgeDelegation({
      stationId: "command-a",
      socket: admissionSocket,
      edgeGrant: admissionEdgeGrant,
    })).rejects.toThrow("process-bound edge admission");

    admissionCanvas = {
      ...admissionCanvas,
      edges: [{ id: "edge-1", fromNode: "agent-1", toNode: "page-1" }],
    };
    admissionEdgeGrant.invalidateCanvas?.("work");
    await expect(admitAgentEdgeDelegation({
      stationId: "command-a",
      socket: admissionSocket,
      edgeGrant: admissionEdgeGrant,
    })).resolves.toBeDefined();
  });
  it("denies replay/capacity/key/algorithm/time/host/canvas/generation/policy failures", () => {
    const replay = new StationBrowserReplayCache(1); const valid = frame(); expect(verifyStationBrowserEnvelope(valid, trust, context(), replay)).toMatchObject({ ok: true }); expect(verifyStationBrowserEnvelope(valid, trust, context(), replay)).toEqual({ ok: false, denial: "replayed" });
    expect(verifyStationBrowserEnvelope(valid, trust, context({ now: now + 35_000 }), replay)).toEqual({ ok: false, denial: "replayed" });
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
    const pages = '{"version":1,"requestId":"r","action":"discover","ok":true,"hostId":"remote-a","data":{"pages":[{"pageRef":"vellum://canvas/work?node=a","hostId":"remote-a"},{"pageRef":"vellum://canvas/work?node=b","hostId":"remote-a"}]},"error":null}'; expect(decodeStationBrowserResponse(pages)).not.toBe("malformed");
    expect(decodeStationBrowserResponse('{"version":1,"requestId":"r","action":"discover","ok":true,"hostId":"remote-a","data":{"pages":[{"pageRef":"vellum://canvas/work?node=a","hostId":"remote-a","profile":"p"}]},"error":null}')).toBe("malformed");
    expect(decodeStationBrowserResponse('{"version":1,"requestId":"r","action":"list","ok":true,"hostId":"remote-a","data":{"sessions":[{"hostId":"remote-a","sessionId":"s1","generation":"g1"},{"hostId":"remote-a","sessionId":"s2","generation":"g2"}]},"error":null}')).not.toBe("malformed");
    expect(decodeStationBrowserResponse('{"version":1,"requestId":"r","action":"screenshot","ok":true,"hostId":"remote-a","data":{"artifact":{"hostId":"remote-a","artifactRef":"artifact-1"}},"error":null}')).not.toBe("malformed");
    expect(decodeStationBrowserResponse('{"version":1,"requestId":"r","action":"state","ok":true,"hostId":"remote-a","data":{},"error":null}')).toBe("malformed");
  });
});
