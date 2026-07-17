import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import { formatNodeRef, parseNodeRef } from "../src/shared/node-ref";
import {
  makeBrowserAutomationProduct,
  type BrowserAutomationProduct,
  type BrowserAutomationProductDependencies,
} from "../src/main/vellum/browser/agent-product";
import { LocalMirrorTransport } from "../src/main/vellum/herdr/mirror-transport";

const CONTROL_HOME = "/tmp/vellum-browser-product-test";
const HERMES_REF = formatNodeRef({ canvasName: "work", nodeId: "agent-1" });
const HERDR_REF = formatNodeRef({ canvasName: "work", nodeId: "herdr-1" });
const PAGE_REF = formatNodeRef({ canvasName: "work", nodeId: "page-1" });

const base = (id: string) => ({
  id,
  x: 0,
  y: 0,
  width: 240,
  height: 120,
});

const agentNode = (): CanvasNode => ({
  ...base("agent-1"),
  type: "text",
  text: "local agent",
  ether: { entity: { kind: "agent", name: "local:default" } },
});

const herdrNode = (): CanvasNode => ({
  ...base("herdr-1"),
  type: "text",
  text: "source pane",
  ether: {
    entity: { kind: "herdr" },
    herdr: {
      host: "local",
      session: null,
      paneId: "source-pane",
      workspaceId: "source-workspace",
      tabId: "source-tab",
    },
  },
});

const pageNode = (): CanvasNode => ({
  ...base("page-1"),
  type: "link",
  url: "https://github.com/settings/profile?private=value",
  ether: { entity: { kind: "page" }, browser: { profile: "default" } },
});

const canvas = (...nodes: ReadonlyArray<CanvasNode>): CanvasDoc => ({
  nodes: [...nodes],
  edges: [],
});

const products: BrowserAutomationProduct[] = [];

afterEach(() => {
  for (const product of products.splice(0)) product.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

class RecordingLocalTransport extends LocalMirrorTransport {
  readonly calls: Array<{
    readonly method: string;
    readonly params: unknown;
    readonly timeoutMs: number | undefined;
  }> = [];
  disposeCount = 0;

  constructor(private readonly response: unknown) {
    super("/tmp/vellum-browser-product-test.sock");
  }

  override async request(
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    this.calls.push({ method, params, timeoutMs });
    return this.response;
  }

  override dispose(): void {
    this.disposeCount += 1;
  }
}

const setup = (
  doc: CanvasDoc = canvas(agentNode(), pageNode()),
  overrides: Partial<
    Pick<BrowserAutomationProductDependencies, "makeLocalTransport">
  > = {},
) => {
  let automationSequence = 0;
  const sessions = {
    destroyOwnerSessions: vi.fn((_owner: string, _reason?: string) => 0),
  };
  const chat = {
    chatRestartWithLocalBrowserAuthority: vi.fn<
      BrowserAutomationProductDependencies["chat"]["chatRestartWithLocalBrowserAuthority"]
    >(async () => ({
      ok: true,
      sessionId: "chat-session",
    })),
    chatRevokeLocalBrowserAuthority: vi.fn<
      BrowserAutomationProductDependencies["chat"]["chatRevokeLocalBrowserAuthority"]
    >(async () => ({ ok: true as const })),
  };
  const herdr = {
    killPane: vi.fn(async () => ({ ok: true as const, data: { closed: true as const } })),
  };
  const dependencies: BrowserAutomationProductDependencies = {
    sessions,
    chat,
    herdr,
    readCanvas: vi.fn(async (name: string) => {
      if (name !== "work") throw new Error("missing canvas");
      return doc;
    }),
    resolvePageTarget: vi.fn(async (candidate: unknown) => {
      if (typeof candidate !== "string") {
        return { ok: false as const, code: "invalid" as const, message: "invalid" };
      }
      const parsed = parseNodeRef(candidate);
      if (!parsed.ok || parsed.value.canvasName !== "work") {
        return { ok: false as const, code: "invalid" as const, message: "invalid" };
      }
      const node = doc.nodes.find((candidateNode) => candidateNode.id === parsed.value.nodeId);
      if (
        node?.type !== "link" ||
        node.ether?.entity?.kind !== "page" ||
        typeof node.ether.browser?.profile !== "string"
      ) {
        return { ok: false as const, code: "not_found" as const, message: "missing" };
      }
      return {
        ok: true as const,
        data: {
          ref: candidate,
          nodeId: node.id,
          url: node.url,
          profile: node.ether.browser.profile,
        },
      };
    }),
    getHerdrPaneMeta: vi.fn(async () => ({
      ok: true as const,
      data: {
        paneId: "source-pane",
        workspaceId: "source-workspace",
        tabId: "source-tab",
        foregroundCwd: "/tmp/vellum-workspace",
      },
    })),
    confirm: vi.fn(async () => true),
    controlHome: CONTROL_HOME,
    makeAutomationId: () =>
      `00000000-0000-4000-8000-${String(++automationSequence).padStart(12, "0")}`,
    ...overrides,
  };
  const product = makeBrowserAutomationProduct(dependencies);
  products.push(product);
  return { product, sessions, chat, herdr, dependencies };
};

const startedHerdrAgent = (
  overrides: {
    readonly workspaceId?: string;
    readonly tabId?: string;
    readonly paneId?: string;
  } = {},
) => ({
  type: "agent_started",
  argv: ["codex"],
  agent: {
    terminal_id: "spawned-terminal",
    workspace_id: overrides.workspaceId ?? "source-workspace",
    tab_id: overrides.tabId ?? "source-tab",
    pane_id: overrides.paneId ?? "spawned-pane",
    agent_status: "working",
    focused: false,
    revision: 1,
  },
});

describe("browser automation production product", () => {
  it("uses its exposed registry and isolates ordered termination observers", async () => {
    const { product, sessions } = setup();
    const order: string[] = [];
    sessions.destroyOwnerSessions.mockImplementation((owner) => {
      order.push(`sessions:${owner}`);
      throw new Error("session teardown sentinel");
    });
    const handleTermination = vi
      .spyOn(product.runtime, "handleTermination")
      .mockImplementation((notice) => {
        order.push(`runtime:${notice.ownerId}`);
      });

    const principal = product.registry.createPrincipal();
    const grant = product.registry.issue(principal, {
      actions: ["profiles"],
      targets: [
        {
          ref: PAGE_REF,
          profile: "default",
          exactOrigins: ["https://github.com"],
        },
      ],
      ttlMs: 60_000,
      maxUses: 1,
      maxInFlight: 1,
    });

    expect(product.registry.revoke(grant.handle, "operator")).toBe(true);
    expect(order).toEqual([
      `sessions:${grant.auditId}`,
      `runtime:${principal.ownerId}`,
    ]);
    expect(sessions.destroyOwnerSessions).toHaveBeenCalledWith(
      grant.auditId,
      "browser authority ended",
    );
    expect(handleTermination).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: principal.ownerId }),
    );
    expect(product.registry.stats().activeCapabilities).toBe(0);

    sessions.destroyOwnerSessions.mockImplementation((owner) => {
      order.push(`sessions:${owner}`);
      return 0;
    });
    handleTermination.mockImplementation((notice) => {
      order.push(`runtime:${notice.ownerId}`);
      throw new Error("runtime teardown sentinel");
    });
    const secondPrincipal = product.registry.createPrincipal();
    const secondGrant = product.registry.issue(secondPrincipal, {
      actions: ["profiles"],
      targets: [
        {
          ref: PAGE_REF,
          profile: "default",
          exactOrigins: ["https://github.com"],
        },
      ],
      ttlMs: 60_000,
      maxUses: 1,
      maxInFlight: 1,
    });
    expect(() => product.registry.revoke(secondGrant.handle, "operator")).not.toThrow();
    expect(order.slice(-2)).toEqual([
      `sessions:${secondGrant.auditId}`,
      `runtime:${secondPrincipal.ownerId}`,
    ]);
    expect(product.registry.stats().activeCapabilities).toBe(0);
  });

  it("tears down only the revoked grant namespace when one principal has siblings", () => {
    const { product, sessions } = setup();
    const principal = product.registry.createPrincipal();
    const issue = () => product.registry.issue(principal, {
      actions: ["profiles"],
      targets: [
        {
          ref: PAGE_REF,
          profile: "default",
          exactOrigins: ["https://github.com"],
        },
      ],
      ttlMs: 60_000,
      maxUses: 2,
      maxInFlight: 1,
    });
    const first = issue();
    const sibling = issue();
    expect(first.ownerId).toBe(sibling.ownerId);
    expect(first.auditId).not.toBe(sibling.auditId);

    expect(product.registry.revoke(first.handle, "operator")).toBe(true);
    expect(sessions.destroyOwnerSessions).toHaveBeenCalledExactlyOnceWith(
      first.auditId,
      "browser authority ended",
    );
    expect(sessions.destroyOwnerSessions).not.toHaveBeenCalledWith(
      sibling.auditId,
      expect.anything(),
    );
    expect(sessions.destroyOwnerSessions).not.toHaveBeenCalledWith(
      principal.ownerId,
      expect.anything(),
    );
    expect(product.registry.stats().activeCapabilities).toBe(1);

    const siblingLease = product.registry.authorize(
      sibling.secret,
      { action: "profiles" },
      { requestId: "a".repeat(32) },
    );
    siblingLease.release();
    expect(product.registry.revoke(sibling.handle, "operator")).toBe(true);
    expect(sessions.destroyOwnerSessions).toHaveBeenNthCalledWith(
      2,
      sibling.auditId,
      "browser authority ended",
    );
  });

  it("revokes failed or rejected Hermes delivery and returns only a fixed public failure", async () => {
    const { product, chat } = setup();
    let deliveredCapability = "";
    chat.chatRestartWithLocalBrowserAuthority.mockImplementation(async (_agentKey, environment) => {
      deliveredCapability = environment.capability;
      return { ok: false, error: `provider leaked ${environment.capability}` };
    });
    chat.chatRevokeLocalBrowserAuthority.mockRejectedValue(
      new Error("Hermes cleanup failure sentinel"),
    );

    const result = await product.runtime.enable({ kind: "hermes", ref: HERMES_REF });

    expect(result).toEqual({ ok: false, code: "delivery_failed" });
    expect(JSON.stringify(result)).not.toContain(deliveredCapability);
    expect(chat.chatRevokeLocalBrowserAuthority).toHaveBeenCalledExactlyOnceWith(
      "local:default",
    );
    expect(product.registry.stats().activeCapabilities).toBe(0);

    chat.chatRestartWithLocalBrowserAuthority.mockImplementation(async (_agentKey, environment) => {
      deliveredCapability = environment.capability;
      throw new Error(`provider rejected ${environment.capability}`);
    });
    const rejected = await product.runtime.enable({ kind: "hermes", ref: HERMES_REF });
    expect(rejected).toEqual({ ok: false, code: "delivery_failed" });
    expect(JSON.stringify(rejected)).not.toContain(deliveredCapability);
    expect(chat.chatRevokeLocalBrowserAuthority).toHaveBeenCalledTimes(2);
    expect(product.registry.stats().activeCapabilities).toBe(0);
  });

  it("delivers Herdr through a fresh local transport and cleans only the spawned pane", async () => {
    const transports: RecordingLocalTransport[] = [];
    const makeLocalTransport = vi.fn(() => {
      const transport = new RecordingLocalTransport(
        startedHerdrAgent({ paneId: `spawned-pane-${transports.length + 1}` }),
      );
      transports.push(transport);
      return transport;
    });
    const { product, herdr } = setup(canvas(herdrNode(), pageNode()), {
      makeLocalTransport,
    });
    herdr.killPane.mockRejectedValue(new Error("Herdr cleanup failure sentinel"));

    const enabled = await product.runtime.enable({
      kind: "herdr",
      ref: HERDR_REF,
      agent: "codex",
    });
    expect(enabled.ok).toBe(true);
    expect(makeLocalTransport).toHaveBeenCalledTimes(1);
    expect(transports[0]).toBeInstanceOf(LocalMirrorTransport);
    expect(transports[0]?.disposeCount).toBe(1);
    expect(transports[0]?.calls).toEqual([
      {
        method: "agent.start",
        timeoutMs: 15_000,
        params: expect.objectContaining({
          name: "codex",
          argv: ["codex"],
          cwd: "/tmp/vellum-workspace",
          workspace_id: "source-workspace",
          tab_id: "source-tab",
        }),
      },
    ]);

    if (!enabled.ok) return;
    expect(product.runtime.revoke(enabled.data.automationId)).toEqual({
      ok: true,
      data: { revoked: true },
    });
    await vi.waitFor(() =>
      expect(herdr.killPane).toHaveBeenCalledExactlyOnceWith(
        "local",
        null,
        "spawned-pane-1",
      ),
    );
    expect(herdr.killPane).not.toHaveBeenCalledWith("local", null, "source-pane");

    const second = await product.runtime.enable({
      kind: "herdr",
      ref: HERDR_REF,
      agent: "codex",
    });
    expect(second.ok).toBe(true);
    expect(makeLocalTransport).toHaveBeenCalledTimes(2);
    expect(transports[1]).toBeInstanceOf(LocalMirrorTransport);
    expect(transports[1]).not.toBe(transports[0]);
    expect(transports[1]?.disposeCount).toBe(1);
    if (!second.ok) return;
    product.runtime.revoke(second.data.automationId);
    await vi.waitFor(() =>
      expect(herdr.killPane).toHaveBeenNthCalledWith(
        2,
        "local",
        null,
        "spawned-pane-2",
      ),
    );
  });

  it.each([
    ["source pane", { paneId: "source-pane" }],
    ["different workspace", { workspaceId: "other-workspace" }],
    ["different tab", { tabId: "other-tab" }],
  ])("rejects a Herdr response targeting the %s without closing any pane", async (_name, overrides) => {
    const transport = new RecordingLocalTransport(startedHerdrAgent(overrides));
    const { product, herdr } = setup(canvas(herdrNode(), pageNode()), {
      makeLocalTransport: () => transport,
    });

    await expect(
      product.runtime.enable({ kind: "herdr", ref: HERDR_REF, agent: "codex" }),
    ).resolves.toEqual({ ok: false, code: "delivery_failed" });
    expect(transport.disposeCount).toBe(1);
    expect(herdr.killPane).not.toHaveBeenCalled();
    expect(product.registry.stats().activeCapabilities).toBe(0);
  });

  it("delegates resume reaping and closes every capability exactly once", async () => {
    const { product, chat, sessions } = setup();
    const enabled = await product.runtime.enable({ kind: "hermes", ref: HERMES_REF });
    expect(enabled.ok).toBe(true);
    expect(product.registry.stats().activeCapabilities).toBe(1);
    const registryReap = vi
      .spyOn(product.registry, "reapAfterResume")
      .mockReturnValueOnce(7);
    expect(product.reapAfterResume()).toBe(7);
    expect(registryReap).toHaveBeenCalledExactlyOnceWith();
    registryReap.mockRestore();

    expect(product.close()).toBe(1);
    expect(product.close()).toBe(0);
    expect(product.registry.stats()).toMatchObject({
      closed: true,
      activeCapabilities: 0,
    });
    expect(sessions.destroyOwnerSessions).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(chat.chatRevokeLocalBrowserAuthority).toHaveBeenCalledExactlyOnceWith(
        "local:default",
      ),
    );
    expect(product.runtime.list()).toEqual({ ok: false, code: "closed" });
  });
});
