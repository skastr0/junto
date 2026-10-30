import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Layer, ManagedRuntime, Schema } from "effect";
import { inProcessCore, type CoreRunner } from "./support/in-process-core";
import "../src/main/core-process/ops/main-index";
import { PausePlane } from "../src/main/junto/pause-plane";
import { BindingId } from "../src/shared/model/kinds";
import { SqlClient } from "effect/unstable/sql";
import type { Canvas } from "../src/shared/model";
import { BROWSER_ENABLED } from "../src/shared/features";
import { canvasOf, page as pageNode, seat, wire } from "./support/model-nodes";
import {
  dispatchControlRequest,
  makeControlHandlers,
  rotateControlToken,
} from "../src/main/junto/browser/control";
import {
  makeEdgeGrantService,
  type EdgeGrantService,
} from "../src/main/junto/browser/edge-grant";
import {
  BROWSER_CAPABILITY_ACTIONS,
  makeBrowserCapabilityRegistry,
  type BrowserCapabilityRegistry,
} from "../src/main/junto/browser/capabilities";
import { makeBrowserProfileService } from "../src/main/junto/browser/profiles";
import {
  BrowserSessionService,
  type BrowserViewAdapter,
  type BrowserViewHandle,
} from "../src/main/junto/browser/sessions";
import { localBrowserTestMachineName } from "./browser-test-machine";
import {
  type ProcessPrincipal,
  OFFBOARDED_SESSION_MESSAGE,
} from "../src/main/junto/process-identity";
import {
  makeSeatCredentialRegistry,
  mintSeatCredential,
  type SeatCredentialRegistry,
} from "../src/main/junto/work/seat-credentials";
import type {
  PageTargetResolver,
  ResolvedPageTarget,
} from "../src/main/junto/browser/page-target";
import { makeStateEngineLive } from "../src/main/junto/state/engine";

const REF_PAGE = "junto://canvas/work?node=p1";
const TARGET: ResolvedPageTarget = {
  ref: REF_PAGE,
  nodeId: "p1",
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
        __juntoEval: 1,
        status: "ok",
        json: "null",
      }),
      capturePagePng: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    };
    return handle;
  };
  return adapter;
};

const frame = { y: 0, width: 120, height: 48 };

/** An agent and a page; `hosts.agent` puts the agent on a machine other than this one. */
const browserCanvas = (withEdge: boolean, hosts: { agent?: string } = {}): Canvas =>
  canvasOf(
    [
      seat("agent", {
        ...frame, x: 0,
        agentKey: "local:default",
        host: hosts.agent ?? "studio",
        bindingId: "bind-local-default" as never,
        launch: { kind: "harness", argv: ["claude"] },
      }),
      pageNode("p1", { ...frame, x: 200, profile: "personal" }),
    ],
    withEdge ? [wire("e1", "agent", "p1", "navigates")] : [],
    "work",
  );

const terminalCanvas = (): Canvas =>
  canvasOf(
    [
      seat("terminal", { ...frame, x: 0, agentKey: "local:terminal", host: "studio", bindingId: "terminal-binding" as never }),
      pageNode("p1", { ...frame, x: 200, profile: "personal" }),
    ],
    [wire("e1", "terminal", "p1", "navigates")],
    "work",
  );

describe.runIf(!BROWSER_ENABLED)("browser edge-grant, browser gated off", () => {
  it("refuses a seat wired to a page and mints nothing: the page offers no browser.automate", async () => {
    const capabilities = makeBrowserCapabilityRegistry();
    try {
      const edgeGrant = makeEdgeGrantService({
        capabilities,
        listCanvasModels: async () => [{ name: "work", doc: browserCanvas(true) }],
        resolvePageTarget: async () => ({ ok: true, data: TARGET }),
        machineName: () => "studio",
        editsCanvas: async () => true,
      });
      await expect(edgeGrant.admitPrincipal({ agentKey: "local:default" })).resolves.toMatchObject({ ok: false });
      expect(capabilities.stats().activeCapabilities).toBe(0);
    } finally {
      capabilities.close();
    }
  });
});

describe.runIf(BROWSER_ENABLED)("browser edge-grant process-bind dual admit", () => {
  let root: string;
  let registries: BrowserCapabilityRegistry[];
  let stateRuntime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>;
  let sql: SqlClient.SqlClient;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "junto-edge-grant-"));
    stateRuntime = ManagedRuntime.make(
      makeStateEngineLive(join(root, "junto.db")),
    );
    sql = await stateRuntime.runPromise(SqlClient.SqlClient);
    registries = [];
  });

  afterEach(async () => {
    for (const registry of registries) registry.close();
    await stateRuntime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const makeStack = (
    doc: Canvas,
    resolvePageTargetOverride?: PageTargetResolver,
    identity?: {
      readonly credentials: SeatCredentialRegistry;
    },
  ) => {
    let sessionCounter = 0;
    const sessions = new BrowserSessionService(
      makeSpyAdapter(),
      localBrowserTestMachineName,
      makeBrowserProfileService(sql, join(root, "browser")),
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
    const listCanvasModels = async () => [{ name: "work", doc: doc }];
    const edgeGrant = makeEdgeGrantService({
      capabilities,
      resolvePageTarget,
      listCanvasModels,
      machineName: () => sessions.machineName(),
      editsCanvas: async () => true,
      ...(identity === undefined
        ? {}
        : {
            credentials: {
              lookup: async (credential: string) => identity.credentials.lookup(credential),
              onEvent: (listener: Parameters<SeatCredentialRegistry["subscribe"]>[0]) => identity.credentials.subscribe(listener),
            },
          }),
    });
    // The pause plane as the work socket reads it, in the core on every request; flipped per test.
    const pause = { playing: true };
    const core = inProcessCore(ManagedRuntime.make(Layer.succeed(PausePlane, {
      stateFor: (canvasName: string) => ({ playing: canvasName === "work" && pause.playing, everPlayed: true }),
    } as never)) as unknown as CoreRunner);
    const handlers = makeControlHandlers({
      sessions,
      capabilities,
      resolvePageTarget,
      version: "0.0.0-test",
      listDocuments: listCanvasModels,
      shotsDir: join(root, "shots"),
      edgeGrant,
      canvasPlaying: (canvasName) => core.call("pause.playing", { canvas: canvasName }),
    });
    return { handlers, edgeGrant, capabilities, pause };
  };

  it("admits protected routes only through process principals or internal leases", async () => {
    const doc = browserCanvas(true);
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

    // A pre-minted lease remains available to trusted server-internal callers.
    const principal = capabilities.createPrincipal();
    const grant = capabilities.issue(principal, {
      actions: [...BROWSER_CAPABILITY_ACTIONS],
      targets: [
        {
          ref: REF_PAGE,
          profile: "personal",
          exactOrigins: ["https://example.com"],
        },
      ],
      ttlMs: 60_000,
      maxUses: 16,
      maxInFlight: 4,
    });
    const viaLease = await dispatchControlRequest(
      handlers,
      token,
      {
        method: "GET",
        path: "/pages",
        token,
        requestId: "b".repeat(32),
        body: undefined,
      },
      undefined,
      {
        kind: "lease",
        secret: grant.secret,
        expectedPrincipal: principal,
      },
    );
    expect(viaLease.status).toBe(200);

    const smuggled = await dispatchControlRequest(
      handlers,
      token,
      {
        method: "POST",
        path: "/open",
        token,
        requestId: "e".repeat(32),
        body: { ref: REF_PAGE, capability: grant.secret },
      },
    );
    expect(smuggled).toMatchObject({
      status: 401,
      envelope: { ok: false, error: { _tag: "unauthorized" } },
    });
  });

  it("denies process principals with no edge to a page", async () => {
    const doc = browserCanvas(false);
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

  it("fails closed when canonical document authority is unavailable", async () => {
    const capabilities = makeBrowserCapabilityRegistry();
    registries.push(capabilities);
    const edgeGrant = makeEdgeGrantService({
      capabilities,
      listCanvasModels: async () => {
        throw new Error("database unavailable");
      },
      resolvePageTarget: async () => ({ ok: true, data: TARGET }),
      machineName: () => "studio",
      editsCanvas: async () => true,
    });

    await expect(
      edgeGrant.admitPrincipal({ agentKey: "local:default" }),
    ).resolves.toMatchObject({
      ok: false,
      denial: "canvas_unreadable",
    });
    expect(capabilities.stats().activeCapabilities).toBe(0);
  });

  it("refuses a caller assigned to another machine before minting browser authority", async () => {
    const doc = browserCanvas(true, { agent: "render" });
    const capabilities = makeBrowserCapabilityRegistry();
    registries.push(capabilities);
    const edgeGrant = makeEdgeGrantService({
      capabilities,
      listCanvasModels: async () => [{ name: "work", doc: doc }],
      resolvePageTarget: async () => ({ ok: true, data: TARGET }),
      machineName: () => "studio",
      editsCanvas: async () => true,
    });

    await expect(
      edgeGrant.admitPrincipal({ agentKey: "local:default" }),
    ).resolves.toMatchObject({ ok: false, denial: "physical_host_mismatch" });
    expect(capabilities.stats().activeCapabilities).toBe(0);
  });

  it("refuses a page on a canvas this machine holds as a copy, whatever the copy holds", async () => {
    const doc = browserCanvas(true);
    const capabilities = makeBrowserCapabilityRegistry();
    registries.push(capabilities);
    const asked: string[] = [];
    const edgeGrant = makeEdgeGrantService({
      capabilities,
      listCanvasModels: async () => [{ name: "work", doc: doc }],
      resolvePageTarget: async () => ({ ok: true, data: TARGET }),
      machineName: () => "studio",
      editsCanvas: async (canvasName) => {
        asked.push(canvasName);
        return false;
      },
    });

    await expect(
      edgeGrant.admitPrincipal({ agentKey: "local:default" }),
    ).resolves.toMatchObject({ ok: false, denial: "physical_host_mismatch" });
    expect(asked).toEqual(["work"]);
    expect(capabilities.stats().activeCapabilities).toBe(0);
  });

  it("refuses when whether this machine edits the canvas cannot be read", async () => {
    const doc = browserCanvas(true);
    const capabilities = makeBrowserCapabilityRegistry();
    registries.push(capabilities);
    const edgeGrant = makeEdgeGrantService({
      capabilities,
      listCanvasModels: async () => [{ name: "work", doc: doc }],
      resolvePageTarget: async () => ({ ok: true, data: TARGET }),
      machineName: () => "studio",
      editsCanvas: async () => {
        throw new Error("records unavailable");
      },
    });

    await expect(
      edgeGrant.admitPrincipal({ agentKey: "local:default" }),
    ).resolves.toMatchObject({ ok: false, denial: "physical_host_mismatch" });
    expect(capabilities.stats().activeCapabilities).toBe(0);
  });

  it("admits a live seat credential on protected routes via its human page edge", async () => {
    const doc = terminalCanvas();

    const terminalPrincipal: ProcessPrincipal = {
      agentKey: "local:terminal",
      bindingId: "terminal-binding",
      canvasName: "work",
      nodeId: "terminal",
    };
    const credentials = makeSeatCredentialRegistry();
    const mint = mintSeatCredential();
    expect(credentials.publish(mint, terminalPrincipal)).toBe(true);

    const { handlers, edgeGrant, capabilities } = makeStack(
      doc,
      undefined,
      { credentials },
    );

    // admitCredential is the product gate: seat generation credential → the
    // registry the work socket admits on → browser edge grant. The agent seat
    // is the one actor, so the human page edge is the whole authority — no
    // kind ACL sits behind it.
    const admittedSeat = await edgeGrant.admitCredential(mint.credential);
    expect(admittedSeat).toMatchObject({ ok: true, targetCount: 1 });
    if (!admittedSeat.ok) return;
    expect(admittedSeat.principal).toMatchObject({ agentKey: "local:terminal" });

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

    // An absent or wrong credential names no seat.
    for (const presented of [undefined, "", mintSeatCredential().credential]) {
      await expect(edgeGrant.admitCredential(presented)).resolves.toMatchObject({
        ok: false,
        denial: "process_unbound",
      });
    }

    // A detached seat fails closed until reattach.
    expect(credentials.suspend(mint.credential)).toBe(true);
    await expect(edgeGrant.admitCredential(mint.credential)).resolves.toMatchObject({
      ok: false,
      denial: "seat_suspended",
    });
    expect(credentials.reanchor(mint.credential, terminalPrincipal)).toBe(true);
    await expect(edgeGrant.admitCredential(mint.credential)).resolves.toMatchObject({ ok: true });

    // A stale credential, its seat moved on to a fresh session, is refused in
    // the same words as on the work socket, and its grant follows it out.
    expect(credentials.revoke(mint.credential, "offboarded")).toBe(true);
    expect(capabilities.stats()).toMatchObject({ activeCapabilities: 0 });
    await expect(edgeGrant.admitCredential(mint.credential)).resolves.toMatchObject({
      ok: false,
      denial: "process_offboarded",
      message: OFFBOARDED_SESSION_MESSAGE,
    });
  });

  it("keeps a live seat with no page edge a scope refusal, not a credential fault", async () => {
    const credentials = makeSeatCredentialRegistry();
    const mint = mintSeatCredential();
    expect(credentials.publish(mint, { agentKey: "local:default" })).toBe(true);
    const { edgeGrant, capabilities } = makeStack(browserCanvas(false), undefined, { credentials });

    await expect(edgeGrant.admitCredential(mint.credential)).resolves.toMatchObject({
      ok: false,
      denial: "not_connected",
    });
    expect(capabilities.stats().activeCapabilities).toBe(0);
  });

  it("refuses a live seat on a paused canvas every acting route, keeps reads open, and lets it act on play", async () => {
    const credentials = makeSeatCredentialRegistry();
    const mint = mintSeatCredential();
    const principal: ProcessPrincipal = { agentKey: "local:default" };
    expect(credentials.publish(mint, principal)).toBe(true);
    const { handlers, edgeGrant, pause } = makeStack(browserCanvas(true), undefined, { credentials });
    const token = rotateControlToken(join(root, "paused-token"));
    let sequence = 0;
    const send = (method: string, path: string, body: unknown) =>
      dispatchControlRequest(
        handlers,
        token,
        { method, path, token, requestId: (++sequence).toString(16).padStart(32, "0"), body },
        undefined,
        { kind: "principal", edgeGrant, principal },
      );
    const pausedRefusal = {
      status: 403,
      envelope: {
        ok: false,
        error: { _tag: "forbidden", message: "This canvas is paused: a seat acts when the operator plays it." },
      },
    };

    pause.playing = false;
    // The credential still admits the seat; the pause plane, read on this
    // request, is what refuses the act.
    await expect(edgeGrant.admitCredential(mint.credential)).resolves.toMatchObject({ ok: true, canvasName: "work" });
    await expect(send("POST", "/open", { ref: REF_PAGE })).resolves.toMatchObject(pausedRefusal);
    await expect(send("POST", "/goto", { sessionId: "s", url: TARGET.url })).resolves.toMatchObject(pausedRefusal);
    await expect(send("POST", "/eval", { sessionId: "s", code: "1" })).resolves.toMatchObject(pausedRefusal);
    await expect(send("GET", "/pages", undefined)).resolves.toMatchObject({ status: 200 });
    await expect(send("GET", "/sessions", undefined)).resolves.toMatchObject({ status: 200 });

    pause.playing = true;
    const opened = await send("POST", "/open", { ref: REF_PAGE });
    expect(opened.status, JSON.stringify(opened.envelope)).toBe(200);
    if (!opened.envelope.ok) return;
    const { sessionId } = opened.envelope.data as { readonly sessionId: string };
    const went = await send("POST", "/goto", { sessionId, url: TARGET.url });
    expect(went.status, JSON.stringify(went.envelope)).toBe(200);
    const evaluated = await send("POST", "/eval", { sessionId, code: "1" });
    expect(evaluated.envelope).not.toMatchObject(pausedRefusal.envelope);

    // Pause is read in the core per request, never cached with the grant or in main:
    // a pause that lands after the seat acted refuses its very next act.
    pause.playing = false;
    await expect(send("POST", "/goto", { sessionId, url: TARGET.url })).resolves.toMatchObject(pausedRefusal);
  });

  it("denies a live stale seat when its agent anchor conflicts with a reused node id", async () => {
    const credentials = makeSeatCredentialRegistry();
    const mint = mintSeatCredential();
    expect(credentials.publish(mint, {
      nodeId: "agent",
      canvasName: "work",
      agentKey: "local:retired",
      bindingId: "bind-local-default",
    })).toBe(true);
    const { edgeGrant, capabilities } = makeStack(
      browserCanvas(true),
      undefined,
      { credentials },
    );

    await expect(edgeGrant.admitCredential(mint.credential)).resolves.toMatchObject({
      ok: false,
      denial: "not_found",
    });
    expect(capabilities.stats().activeCapabilities).toBe(0);
  });

  it("rejects a capability paired with a different registry principal", async () => {
    const doc = browserCanvas(true);
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
    const doc = browserCanvas(true);
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
    const doc = browserCanvas(true);
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

  it.each(["binding", "host"] as const)("revokes a cached process lease when the seat %s changes", async (field) => {
    const doc = browserCanvas(true);
    const { edgeGrant, capabilities } = makeStack(doc);
    const admission = await edgeGrant.admitPrincipal({
      agentKey: "local:default", bindingId: "bind-local-default",
    });
    expect(admission.ok).toBe(true);
    if (!admission.ok) return;
    const lease = capabilities.authorize(admission.secret, { action: "pages" }, {
      requestId: "00000000-0000-4000-8000-000000000001",
      expectedPrincipal: admission.expectedPrincipal,
    });
    const next = doc;
    const nodes = new Map(next.nodes);
    for (const node of nodes.values()) {
      if (node.kind === "agent") nodes.set(node.id, {
        ...node, ...(field === "binding" ? { bindingId: Schema.decodeUnknownSync(BindingId)("fresh-binding") } : { host: "another-host" }),
      });
    }
    edgeGrant.invalidateCanvas("work", { next: { ...next, nodes } });
    expect(lease.signal.aborted).toBe(true);
    expect(capabilities.preflight(admission.secret, "pages", admission.expectedPrincipal))
      .toEqual({ ok: false, denial: "unauthorized" });
    lease.release();
  });

  it("revokes only an ended generation's grant and remints for its replacement", async () => {
    const doc = browserCanvas(true);
    const credentials = makeSeatCredentialRegistry();
    const principal: ProcessPrincipal = { agentKey: "local:default" };
    const firstMint = mintSeatCredential();
    expect(credentials.publish(firstMint, principal)).toBe(true);
    const { edgeGrant, capabilities } = makeStack(doc, undefined, { credentials });
    const first = await edgeGrant.admitCredential(firstMint.credential);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const lease = capabilities.authorize(
      first.secret,
      { action: "pages" },
      { requestId: "00000000-0000-4000-8000-000000000099", expectedPrincipal: first.expectedPrincipal },
    );

    expect(credentials.revoke(firstMint.credential, "replaced")).toBe(true);
    expect(lease.signal.aborted).toBe(true);
    expect(capabilities.stats().activeCapabilities).toBe(0);
    const nextMint = mintSeatCredential();
    expect(credentials.publish(nextMint, principal)).toBe(true);
    const replacement = await edgeGrant.admitCredential(nextMint.credential);
    expect(replacement.ok).toBe(true);
    if (replacement.ok) expect(replacement.secret).not.toBe(first.secret);
    lease.release();
  });

  it("does not mint from a graph invalidated during async admission", async () => {
    const doc = browserCanvas(true);

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
