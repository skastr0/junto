import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  dispatchControlRequest,
  makeControlHandlers,
  rotateControlToken,
} from "../src/main/vellum/browser/control";
import { makeEdgeGrantService } from "../src/main/vellum/browser/edge-grant";
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
import { type ProcessPrincipal } from "../src/main/vellum/process-identity";
import type {
  PageTargetResolver,
  ResolvedPageTarget,
} from "../src/main/vellum/browser/page-target";

const REF_PAGE = "vellum://canvas/work?node=p1";
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
      ether: { entity: { kind: "agent", name: "local:default" } },
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

describe("browser edge-grant process-bind dual admit", () => {
  let root: string;
  let registries: BrowserCapabilityRegistry[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-edge-grant-"));
    registries = [];
  });

  afterEach(async () => {
    for (const registry of registries) registry.close();
    await rm(root, { recursive: true, force: true });
  });

  const makeStack = (doc: CanvasDoc) => {
    let sessionCounter = 0;
    const sessions = new BrowserSessionService(
      makeSpyAdapter(),
      makeBrowserProfileService(join(root, "browser")),
      Date.now,
      () => `session-${++sessionCounter}`,
    );
    const capabilities = makeBrowserCapabilityRegistry({
      onTerminate: (notice) => {
        sessions.destroyOwnerSessions(notice.auditId, "browser authority ended");
      },
    });
    registries.push(capabilities);
    const resolvePageTarget: PageTargetResolver = async (candidate) => {
      if (candidate === REF_PAGE) return { ok: true, data: TARGET };
      return { ok: false, code: "not_found", message: "missing" };
    };
    const edgeGrant = makeEdgeGrantService({
      capabilities,
      canvasesDir: join(root, "canvases"),
      resolvePageTarget,
      readCanvas: async (name) => (name === "work" ? doc : undefined),
    });
    const handlers = makeControlHandlers({
      sessions,
      capabilities,
      resolvePageTarget,
      version: "0.0.0-test",
      canvasesDir: join(root, "canvases"),
      shotsDir: join(root, "shots"),
      edgeGrant,
    });
    return { handlers, edgeGrant, capabilities };
  };

  it("admits protected list routes via process principal without capability secret", async () => {
    await mkdir(join(root, "canvases"), { recursive: true });
    const doc = canvasDoc(true);
    await writeFile(join(root, "canvases", "work.canvas"), JSON.stringify(doc), "utf8");
      const { handlers, edgeGrant, capabilities } = makeStack(doc);
      const token = rotateControlToken(join(root, "token"));
      const processPrincipal: ProcessPrincipal = { kind: "agent", agentKey: "local:default" };
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

    // Ceremony path remains available when a secret is presented.
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
    const processPrincipal: ProcessPrincipal = { kind: "agent", agentKey: "local:default" };
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

  it("reuses admission cache and remints after canvas invalidation", async () => {
    await mkdir(join(root, "canvases"), { recursive: true });
    const doc = canvasDoc(true);
    await writeFile(join(root, "canvases", "work.canvas"), JSON.stringify(doc), "utf8");
    const { edgeGrant } = makeStack(doc);

    const principal: ProcessPrincipal = { kind: "agent", agentKey: "local:default" };
    const first = await edgeGrant.admitPrincipal(principal);
    const second = await edgeGrant.admitPrincipal(principal);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first).toHaveProperty("secret");
    expect(second).toHaveProperty("secret");
    if (first.ok && second.ok) {
      expect(second.secret).toBe(first.secret);
    }

    edgeGrant.invalidateCanvas?.("other");
    const third = await edgeGrant.admitPrincipal(principal);
    expect(third.ok).toBe(true);
    if (third.ok && first.ok) {
      expect(third.secret).toBe(first.secret);
    }

    edgeGrant.invalidateCanvas?.("work");
    const fourth = await edgeGrant.admitPrincipal(principal);
    expect(fourth.ok).toBe(true);
    if (fourth.ok && first.ok) {
      expect(fourth.secret).not.toBe(first.secret);
    }
  });
});
