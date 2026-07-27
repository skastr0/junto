import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Context, ManagedRuntime } from "effect";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  dispatchControlRequest,
  makeControlHandlers,
  rotateControlToken,
} from "../src/main/vellum/browser/control";
import {
  makeEdgeGrantService,
  type EdgeGrantService,
} from "../src/main/vellum/browser/edge-grant";
import {
  BROWSER_CAPABILITY_ACTIONS,
  makeBrowserCapabilityRegistry,
  type BrowserCapabilityRegistry,
} from "../src/main/vellum/browser/capabilities";
import { makeBrowserProfileService } from "../src/main/vellum/browser/profiles";
import {
  BrowserSessionService,
  type BrowserViewAdapter,
  type BrowserViewHandle,
} from "../src/main/vellum/browser/sessions";
import { LOCAL_BROWSER_TEST_AUTHORITY } from "./browser-host-test-authority";
import {
  makeProcessIdentityMap,
  type PeerPidReader,
  type ProcessIdentityMap,
  type ProcessPrincipal,
} from "../src/main/vellum/process-identity";
import type {
  PageTargetResolver,
  ResolvedPageTarget,
} from "../src/main/vellum/browser/page-target";
import type { BrowserHostCapabilityAuthority } from "../src/main/vellum/browser/host-capability";
import { makeStateEngineLive, StateEngine } from "../src/main/vellum/state/engine";

const REF_PAGE = "vellum://canvas/work?node=p1";
const TARGET: ResolvedPageTarget = {
  ref: REF_PAGE,
  nodeId: "p1",
  hostId: "local",
  url: "https://example.com/",
  profile: "personal",
};

const makeSpyAdapter = (): BrowserViewAdapter => {
  const adapter: BrowserViewAdapter = (_partition, events) => {
    let resolveDestroyed!: () => void;
    const destroyed = new Promise<void>((resolve) => {
      resolveDestroyed = resolve;
    });
    const handle: BrowserViewHandle = {
      loadUrl: async (url, expectedSessionId) => {
        const sessionId = events.onNavigationStart({
          url: new URL(url).href,
          isSameDocument: false,
          expectedSessionId,
        });
        if (sessionId !== undefined) {
          events.onNavigationUrl(sessionId, new URL(url).href);
          events.onLoadOk(sessionId, "loaded");
        }
      },
      attach: () => {},
      setBounds: () => {},
      detach: () => {},
      destroy: () => {
        resolveDestroyed();
      },
      whenDestroyed: () => destroyed,
      executeJavaScript: async () => ({
        __vellumEval: 1,
        status: "ok",
        json: "null",
      }),
      capturePagePng: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    };
    return handle;
  };
  return adapter;
};

const canvasDoc = (withEdge: boolean): CanvasDoc => ({
  nodes: [
    {
      id: "agent",
      type: "text",
      text: "agent",
      x: 0,
      y: 0,
      width: 120,
      height: 48,
      ether: {
        entity: { kind: "agent", name: "local:default" },
        terminal: {
          bindingId: "bind-local-default",
          harness: "claude",
          launch: { kind: "harness", argv: ["claude"] },
        },
      },
    },
    {
      id: "p1",
      type: "link",
      url: "https://example.com/",
      x: 200,
      y: 0,
      width: 120,
      height: 48,
      ether: { entity: { kind: "page" }, browser: { profile: "personal" } },
    },
  ],
  edges: withEdge ? [{ id: "e1", fromNode: "agent", toNode: "p1" }] : [],
});

const stationAuthority = (hostId: string): BrowserHostCapabilityAuthority => ({
  findHost: (id) =>
    id === hostId
      ? {
          id,
          label: id,
          kind: id === "local" ? "local" : "remote",
          ...(id === "local" ? {} : { endpoint: id }),
          capabilities: ["browser"],
        }
      : undefined,
  station: () => ({
    hostId,
    role: hostId === "local" ? "command-center" : "remote",
  }),
});

const terminalCanvasDoc = (): CanvasDoc => ({
  nodes: [
    {
      id: "terminal",
      type: "text",
      text: "terminal",
      x: 0,
      y: 0,
      width: 120,
      height: 48,
      ether: {
        entity: { kind: "agent", name: "local:terminal" },
        terminal: { bindingId: "terminal-binding", harness: "claude" },
      },
    },
    {
      id: "p1",
      type: "link",
      url: "https://example.com/",
      x: 200,
      y: 0,
      width: 120,
      height: 48,
      ether: { entity: { kind: "page" }, browser: { profile: "personal" } },
    },
  ],
  edges: [{ id: "e1", fromNode: "terminal", toNode: "p1" }],
});

describe("browser edge-grant process-bind dual admit", () => {
  let root: string;
  let registries: BrowserCapabilityRegistry[];
  let stateRuntime: ManagedRuntime.ManagedRuntime<StateEngine, unknown>;
  let state: Context.Tag.Service<typeof StateEngine>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-edge-grant-"));
    stateRuntime = ManagedRuntime.make(
      makeStateEngineLive(join(root, "vellum.db")),
    );
    state = await stateRuntime.runPromise(StateEngine);
    registries = [];
  });

  afterEach(async () => {
    for (const registry of registries) registry.close();
    await stateRuntime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const makeStack = (
    doc: CanvasDoc,
    resolvePageTargetOverride?: PageTargetResolver,
    identity?: {
      readonly processMap: ProcessIdentityMap;
      readonly readPeerPid: PeerPidReader;
      readonly admitStation?: () => Promise<
        | { readonly ok: true; readonly maxTtlMs?: number }
        | { readonly ok: false; readonly message: string }
      >;
    },
  ) => {
    let sessionCounter = 0;
    const sessions = new BrowserSessionService(
      makeSpyAdapter(),
      LOCAL_BROWSER_TEST_AUTHORITY,
      makeBrowserProfileService(state, join(root, "browser")),
      Date.now,
      () => `session-${++sessionCounter}`,
    );
    const capabilities = makeBrowserCapabilityRegistry({
      onTerminate: (notice) => {
        sessions.destroyOwnerSessions(notice.auditId, "browser authority ended");
      },
    });
    registries.push(capabilities);
    const resolvePageTarget: PageTargetResolver =
      resolvePageTargetOverride ??
      (async (candidate) => {
        if (candidate === REF_PAGE) return { ok: true, data: TARGET };
        return { ok: false, code: "not_found", message: "missing" };
      });
    const listCanvasDocuments = async () => [{ name: "work", doc }];
    const edgeGrant = makeEdgeGrantService({
      capabilities,
      canvasesDir: join(root, "canvases"),
      resolvePageTarget,
      listCanvasDocuments,
      station: () => sessions.stationIdentity(),
      admitBrowserHost: (hostId) => sessions.admitAutomationHost(hostId),
      ...(identity ?? {}),
    });
    const handlers = makeControlHandlers({
      sessions,
      capabilities,
      resolvePageTarget,
      version: "0.0.0-test",
      canvasesDir: join(root, "canvases"),
      listDocuments: listCanvasDocuments,
      shotsDir: join(root, "shots"),
      edgeGrant,
    });
    return { handlers, edgeGrant, capabilities };
  };

  it("admits protected list routes via process principal without capability secret", async () => {
    const doc = canvasDoc(true);
    // Live authority path: listCanvasDocuments / listDocuments — no .canvas write.
    const { handlers, edgeGrant, capabilities } = makeStack(doc);
      const token = rotateControlToken(join(root, "token"));
      const processPrincipal: ProcessPrincipal = { agentKey: "local:default" };
      const requestId = "a".repeat(32);

    const denied = await dispatchControlRequest(
      handlers,
      token,
      {
        method: "GET",
        path: "/pages",
        token,
        requestId,
        body: undefined,
      },
    );
    expect(denied.status).toBe(401);

    const admitted = await dispatchControlRequest(
      handlers,
      token,
      {
        method: "GET",
        path: "/pages",
        token,
        requestId,
        body: undefined,
      },
      undefined,
      {
        kind: "principal",
        edgeGrant,
        principal: processPrincipal,
      },
    );
    expect(admitted.status).toBe(200);
    expect(admitted.envelope.ok).toBe(true);
    if (admitted.envelope.ok) {
      const rows = admitted.envelope.data as ReadonlyArray<{ ref: string }>;
      expect(rows.map((r) => r.ref)).toEqual([REF_PAGE]);
    }
    const admissionAudit = capabilities.auditSnapshot().find(
      (event) => event.outcome === "admitted",
    );
    const edgeAdmission = await edgeGrant.admitPrincipal(processPrincipal);
    expect(edgeAdmission.ok).toBe(true);
    if (edgeAdmission.ok) {
      expect(admissionAudit).toMatchObject({
        principalId: edgeAdmission.expectedPrincipal.principalId,
        jobId: edgeAdmission.expectedPrincipal.jobId,
      });
    }

    // Ceremony path remains available when a secret is presented.
    const principal = capabilities.createPrincipal();
    const grant = capabilities.issue(principal, {
      actions: [...BROWSER_CAPABILITY_ACTIONS],
      targets: [
        {
          ref: REF_PAGE,
          hostId: "local",
          profile: "personal",
          exactOrigins: ["https://example.com"],
        },
      ],
      ttlMs: 60_000,
      maxUses: 16,
      maxInFlight: 4,
    });
    const viaCap = await dispatchControlRequest(
      handlers,
      token,
      {
        method: "GET",
        path: "/pages",
        token,
        capability: grant.secret,
        requestId: "b".repeat(32),
        body: undefined,
      },
    );
    expect(viaCap.status).toBe(200);
  });

  it("denies process principals with no edge to a page", async () => {
    await mkdir(join(root, "canvases"), { recursive: true });
    const doc = canvasDoc(false);
    await writeFile(join(root, "canvases", "work.canvas"), JSON.stringify(doc), "utf8");
    const { handlers, edgeGrant } = makeStack(doc);
    const token = rotateControlToken(join(root, "token"));
    const processPrincipal: ProcessPrincipal = { agentKey: "local:default" };
    const denied = await dispatchControlRequest(
      handlers,
      token,
      {
        method: "GET",
        path: "/pages",
        token,
        requestId: "c".repeat(32),
        body: undefined,
      },
      undefined,
      {
        kind: "principal",
        edgeGrant,
        principal: processPrincipal,
      },
    );
    expect(denied.status).toBe(403);
    expect(denied.envelope.ok).toBe(false);
    if (!denied.envelope.ok) {
      expect(denied.envelope.error.message).toMatch(/missing edge/i);
    }
  });

  it("refuses a cross-host page edge before minting browser authority", async () => {
    await mkdir(join(root, "canvases"), { recursive: true });
    const base = canvasDoc(true);
    const doc: CanvasDoc = {
      ...base,
      nodes: base.nodes.map((node) => ({
        ...node,
        ether: {
          ...node.ether,
          host: node.id === "agent" ? "studio" : "render",
        },
      })),
    };
    await writeFile(join(root, "canvases", "work.canvas"), JSON.stringify(doc), "utf8");

    const capabilities = makeBrowserCapabilityRegistry();
    registries.push(capabilities);
    const authority = stationAuthority("studio");
    const edgeGrant = makeEdgeGrantService({
      capabilities,
      canvasesDir: join(root, "canvases"),
      resolvePageTarget: async (candidate) =>
        candidate === REF_PAGE
          ? { ok: true, data: { ...TARGET, hostId: "render" } }
          : { ok: false, code: "not_found", message: "missing" },
      station: authority.station,
      admitStation: async () => ({ ok: true }),
      admitBrowserHost: (hostId) => {
        const host = authority.findHost(hostId);
        return host === undefined
          ? {
              ok: false as const,
              code: "unsupported_capability" as const,
              reason: "host-not-registered" as const,
              message: "missing",
            }
          : { ok: true as const, host };
      },
    });

    // S11 placement: Station↔Station is a route denial before host-mint checks.
    // Cross-host studio→render therefore never reaches physical_host_mismatch —
    // physics withholds the browser.automate edge (surfaces as not_connected).
    await expect(
      edgeGrant.admitPrincipal({ agentKey: "local:default" }),
    ).resolves.toMatchObject({
      ok: false,
      denial: "not_connected",
    });
    expect(capabilities.stats().activeCapabilities).toBe(0);
  });

  it("mints only when the Remote caller, document page, and resolved target share its host", async () => {
    await mkdir(join(root, "canvases"), { recursive: true });
    const base = canvasDoc(true);
    const doc: CanvasDoc = {
      ...base,
      nodes: base.nodes.map((node) => ({
        ...node,
        ether: { ...node.ether, host: "studio" },
      })),
    };
    await writeFile(join(root, "canvases", "work.canvas"), JSON.stringify(doc), "utf8");

    const capabilities = makeBrowserCapabilityRegistry();
    registries.push(capabilities);
    const authority = stationAuthority("studio");
    const edgeGrant = makeEdgeGrantService({
      capabilities,
      canvasesDir: join(root, "canvases"),
      resolvePageTarget: async (candidate) =>
        candidate === REF_PAGE
          ? { ok: true, data: { ...TARGET, hostId: "studio" } }
          : { ok: false, code: "not_found", message: "missing" },
      station: authority.station,
      admitStation: async () => ({ ok: true }),
      admitBrowserHost: (hostId) => {
        const host = authority.findHost(hostId);
        return host === undefined
          ? {
              ok: false as const,
              code: "unsupported_capability" as const,
              reason: "host-not-registered" as const,
              message: "missing",
            }
          : { ok: true as const, host };
      },
    });

    await expect(
      edgeGrant.admitPrincipal({ agentKey: "local:default" }),
    ).resolves.toMatchObject({ ok: true, targetCount: 1 });
    expect(capabilities.stats().activeCapabilities).toBe(1);
  });

  it("refuses a resolver result that disagrees with its same-host page node", async () => {
    await mkdir(join(root, "canvases"), { recursive: true });
    const base = canvasDoc(true);
    const doc: CanvasDoc = {
      ...base,
      nodes: base.nodes.map((node) => ({
        ...node,
        ether: { ...node.ether, host: "studio" },
      })),
    };
    await writeFile(join(root, "canvases", "work.canvas"), JSON.stringify(doc), "utf8");

    const capabilities = makeBrowserCapabilityRegistry();
    registries.push(capabilities);
    const authority = stationAuthority("studio");
    const edgeGrant = makeEdgeGrantService({
      capabilities,
      canvasesDir: join(root, "canvases"),
      resolvePageTarget: async () => ({ ok: true, data: { ...TARGET, hostId: "render" } }),
      station: authority.station,
      admitBrowserHost: (hostId) => {
        const host = authority.findHost(hostId);
        return host === undefined
          ? {
              ok: false as const,
              code: "unsupported_capability" as const,
              reason: "host-not-registered" as const,
              message: "missing",
            }
          : { ok: true as const, host };
      },
    });

    await expect(
      edgeGrant.admitPrincipal({ agentKey: "local:default" }),
    ).resolves.toMatchObject({ ok: false, denial: "physical_host_mismatch" });
    expect(capabilities.stats().activeCapabilities).toBe(0);
  });

  it("admits a registered agent seat on protected routes via its human page edge", async () => {
    await mkdir(join(root, "canvases"), { recursive: true });
    const doc = terminalCanvasDoc();
    await writeFile(join(root, "canvases", "work.canvas"), JSON.stringify(doc), "utf8");

    const terminalPrincipal: ProcessPrincipal = {
      agentKey: "local:terminal",
      bindingId: "terminal-binding",
      canvasName: "work",
      nodeId: "terminal",
    };
    const processMap = makeProcessIdentityMap();
    expect(processMap.bind(process.pid, terminalPrincipal)).toBe(true);

    const { handlers, edgeGrant, capabilities } = makeStack(
      doc,
      undefined,
      {
        processMap,
        readPeerPid: () => process.pid,
      },
    );

    // admitSocket is the product gate: Unix peer PID → main-owned process map
    // → browser edge grant. The agent seat is the one actor, so the human page
    // edge is the whole authority — no kind ACL sits behind it.
    const admittedSocket = await edgeGrant.admitSocket({} as Socket);
    expect(admittedSocket).toMatchObject({ ok: true, targetCount: 1 });
    if (!admittedSocket.ok) return;
    expect(admittedSocket.principal).toMatchObject({ agentKey: "local:terminal" });

    const token = rotateControlToken(join(root, "terminal-token"));
    const admitted = await dispatchControlRequest(
      handlers,
      token,
      {
        method: "GET",
        path: "/pages",
        token,
        requestId: "e".repeat(32),
        body: undefined,
      },
      undefined,
      {
        kind: "principal",
        edgeGrant,
        principal: terminalPrincipal,
      },
    );
    expect(admitted.status).toBe(200);
    expect(admitted.envelope.ok).toBe(true);
    if (admitted.envelope.ok) {
      const rows = admitted.envelope.data as ReadonlyArray<{ ref: string }>;
      expect(rows.map((r) => r.ref)).toEqual([REF_PAGE]);
    }
    expect(capabilities.stats().activeCapabilities).toBeGreaterThan(0);

    // Grant revocation must follow the terminal process out, exactly as it does
    // for an agent — an admitted kind that is never revoked is the worse bug.
    processMap.clear();
    expect(capabilities.stats()).toMatchObject({ activeCapabilities: 0 });
    await expect(edgeGrant.admitSocket({} as Socket)).resolves.toMatchObject({
      ok: false,
      denial: "process_unbound",
    });
  });

  it("rejects a capability paired with a different registry principal", async () => {
    await mkdir(join(root, "canvases"), { recursive: true });
    const doc = canvasDoc(true);
    await writeFile(join(root, "canvases", "work.canvas"), JSON.stringify(doc), "utf8");
    const { handlers, edgeGrant, capabilities } = makeStack(doc);
    const token = rotateControlToken(join(root, "token"));
    const processPrincipal: ProcessPrincipal = { agentKey: "local:default" };
    const actual = await edgeGrant.admitPrincipal(processPrincipal);
    expect(actual.ok).toBe(true);
    if (!actual.ok) return;

    const wrongExpectedPrincipal = capabilities.createPrincipal();
    const confusedEdgeGrant: EdgeGrantService = {
      ...edgeGrant,
      admitPrincipal: async () => ({
        ...actual,
        expectedPrincipal: wrongExpectedPrincipal,
      }),
    };
    const denied = await dispatchControlRequest(
      handlers,
      token,
      {
        method: "GET",
        path: "/pages",
        token,
        // A valid presented secret cannot bypass the process-bound admission
        // pair supplied below.
        capability: actual.secret,
        requestId: "d".repeat(32),
        body: undefined,
      },
      undefined,
      {
        kind: "principal",
        edgeGrant: confusedEdgeGrant,
        principal: processPrincipal,
      },
    );

    expect(denied).toMatchObject({
      status: 403,
      envelope: { ok: false, error: { _tag: "forbidden" } },
    });
    expect(capabilities.auditSnapshot()).toContainEqual(
      expect.objectContaining({
        outcome: "denied_scope",
        principalId: actual.expectedPrincipal.principalId,
        jobId: actual.expectedPrincipal.jobId,
      }),
    );
    expect(capabilities.auditSnapshot()).not.toContainEqual(
      expect.objectContaining({
        outcome: "admitted",
        principalId: wrongExpectedPrincipal.principalId,
      }),
    );
  });

  it("reuses admission cache and remints after canvas invalidation", async () => {
    await mkdir(join(root, "canvases"), { recursive: true });
    const doc = canvasDoc(true);
    await writeFile(join(root, "canvases", "work.canvas"), JSON.stringify(doc), "utf8");
    const { edgeGrant } = makeStack(doc);

    const principal: ProcessPrincipal = { agentKey: "local:default" };
    const first = await edgeGrant.admitPrincipal(principal);
    const second = await edgeGrant.admitPrincipal(principal);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first).toHaveProperty("secret");
    expect(second).toHaveProperty("secret");
    if (first.ok && second.ok) {
      expect(second.secret).toBe(first.secret);
      expect(second.expectedPrincipal).toBe(first.expectedPrincipal);
    }

    edgeGrant.invalidateCanvas?.("other");
    const third = await edgeGrant.admitPrincipal(principal);
    expect(third.ok).toBe(true);
    if (third.ok && first.ok) {
      expect(third.secret).toBe(first.secret);
      expect(third.expectedPrincipal).toBe(first.expectedPrincipal);
    }

    edgeGrant.invalidateCanvas?.("work");
    const fourth = await edgeGrant.admitPrincipal(principal);
    expect(fourth.ok).toBe(true);
    if (fourth.ok && first.ok) {
      expect(fourth.secret).not.toBe(first.secret);
      expect(fourth.expectedPrincipal).toBe(first.expectedPrincipal);
    }
  });

  it("immediately revokes the affected cached grant and its active lease", async () => {
    await mkdir(join(root, "canvases"), { recursive: true });
    const doc = canvasDoc(true);
    await writeFile(join(root, "canvases", "work.canvas"), JSON.stringify(doc), "utf8");
    const { edgeGrant, capabilities } = makeStack(doc);
    const principal: ProcessPrincipal = { agentKey: "local:default" };
    const admission = await edgeGrant.admitPrincipal(principal);
    expect(admission.ok).toBe(true);
    if (!admission.ok) return;

    const lease = capabilities.authorize(
      admission.secret,
      { action: "pages" },
      {
        requestId: "00000000-0000-4000-8000-000000000001",
        expectedPrincipal: admission.expectedPrincipal,
      },
    );
    edgeGrant.invalidateCanvas?.("other");
    expect(lease.signal.aborted).toBe(false);
    expect(
      capabilities.preflight(
        admission.secret,
        "pages",
        admission.expectedPrincipal,
      ),
    ).toEqual({ ok: true });

    edgeGrant.invalidateCanvas?.("work");
    expect(lease.signal.aborted).toBe(true);
    expect(capabilities.stats()).toMatchObject({
      activeCapabilities: 0,
      activeLeases: 0,
    });
    expect(
      capabilities.preflight(
        admission.secret,
        "pages",
        admission.expectedPrincipal,
      ),
    ).toEqual({ ok: false, denial: "unauthorized" });
    lease.release();
  });

  it("caps Remote edge authority to the remaining pull freshness", async () => {
    await mkdir(join(root, "canvases"), { recursive: true });
    const doc = canvasDoc(true);
    await writeFile(join(root, "canvases", "work.canvas"), JSON.stringify(doc), "utf8");
    const { edgeGrant, capabilities } = makeStack(doc, undefined, {
      processMap: makeProcessIdentityMap(),
      readPeerPid: () => process.pid,
      admitStation: async () => ({ ok: true, maxTtlMs: 5_000 }),
    });
    const before = Date.now();
    const admission = await edgeGrant.admitPrincipal({
      agentKey: "local:default",
    });
    expect(admission.ok).toBe(true);
    if (!admission.ok) return;
    const lease = capabilities.authorize(
      admission.secret,
      { action: "pages" },
      {
        requestId: "00000000-0000-4000-8000-000000000077",
        expectedPrincipal: admission.expectedPrincipal,
      },
    );
    expect(lease.expiresAt).toBeGreaterThan(before + 3_000);
    expect(lease.expiresAt).toBeLessThanOrEqual(before + 4_100);
    lease.release();
  });

  it("revokes only an exited process binding and remints for its replacement", async () => {
    await mkdir(join(root, "canvases"), { recursive: true });
    const doc = canvasDoc(true);
    await writeFile(join(root, "canvases", "work.canvas"), JSON.stringify(doc), "utf8");
    const processMap = makeProcessIdentityMap();
    const principal: ProcessPrincipal = { agentKey: "local:default" };
    expect(processMap.bind(process.pid, principal)).toBe(true);
    const { edgeGrant, capabilities } = makeStack(doc, undefined, {
      processMap,
      readPeerPid: () => process.pid,
    });
    const first = await edgeGrant.admitSocket({} as Socket);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const lease = capabilities.authorize(
      first.secret,
      { action: "pages" },
      { requestId: "00000000-0000-4000-8000-000000000099", expectedPrincipal: first.expectedPrincipal },
    );

    processMap.unbind(process.pid);
    expect(lease.signal.aborted).toBe(true);
    expect(capabilities.stats().activeCapabilities).toBe(0);
    expect(processMap.bind(process.pid, principal)).toBe(true);
    const replacement = await edgeGrant.admitSocket({} as Socket);
    expect(replacement.ok).toBe(true);
    if (replacement.ok) expect(replacement.secret).not.toBe(first.secret);
    lease.release();
  });

  it("does not mint from a graph invalidated during async admission", async () => {
    await mkdir(join(root, "canvases"), { recursive: true });
    const doc = canvasDoc(true);
    await writeFile(join(root, "canvases", "work.canvas"), JSON.stringify(doc), "utf8");

    let releaseResolution!: () => void;
    const resolutionGate = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    let markResolutionStarted!: () => void;
    const resolutionStarted = new Promise<void>((resolve) => {
      markResolutionStarted = resolve;
    });
    let shouldBlock = true;
    const resolvePageTarget: PageTargetResolver = async (candidate) => {
      if (candidate !== REF_PAGE) {
        return { ok: false, code: "not_found", message: "missing" };
      }
      if (shouldBlock) {
        markResolutionStarted();
        await resolutionGate;
      }
      return { ok: true, data: TARGET };
    };
    const { edgeGrant, capabilities } = makeStack(doc, resolvePageTarget);
    const principal: ProcessPrincipal = { agentKey: "local:default" };

    const staleAdmission = edgeGrant.admitPrincipal(principal);
    await resolutionStarted;
    edgeGrant.invalidateCanvas?.("work");
    shouldBlock = false;
    releaseResolution();

    await expect(staleAdmission).resolves.toMatchObject({
      ok: false,
      denial: "not_connected",
      message: expect.stringMatching(/canvas changed during browser edge admission/i),
    });
    expect(capabilities.stats()).toMatchObject({
      activeCapabilities: 0,
      activeLeases: 0,
    });

    const freshAdmission = await edgeGrant.admitPrincipal(principal);
    expect(freshAdmission.ok).toBe(true);
    expect(capabilities.stats().activeCapabilities).toBe(1);
  });
});
