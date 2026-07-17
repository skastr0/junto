import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_AGENT_AUTHORITY_TTL_MS,
  type BrowserAutomationConfirmation,
} from "../src/main/vellum/browser/agent-authority";
import {
  BrowserAutomationRuntime,
  type BrowserAutomationHerdrPaneMeta,
  type BrowserAutomationRuntimeDelivery,
} from "../src/main/vellum/browser/agent-runtime";
import {
  BrowserCapabilityRegistry,
  type BrowserCapabilityTerminationNotice,
} from "../src/main/vellum/browser/capabilities";
import type {
  PageTargetResolver,
} from "../src/main/vellum/browser/page-target";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import type { BrowserAutomationEnableInput } from "../src/shared/ipc";
import { formatNodeRef, parseNodeRef } from "../src/shared/node-ref";

const CONTROL_HOME = "/SENTINEL_CONTROL_HOME";

const automationId = (sequence: number): string =>
  `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;

const base = (id: string) => ({
  id,
  x: 0,
  y: 0,
  width: 220,
  height: 100,
});

const agentNode = (
  id: string,
  name: string,
  text = "renderer-controlled display label",
): CanvasNode => ({
  ...base(id),
  type: "text",
  text,
  ether: { entity: { kind: "agent", name } },
});

const herdrNode = (
  id: string,
  options: {
    readonly host?: string;
    readonly session?: string | null;
    readonly paneId?: string;
    readonly workspaceId?: string;
    readonly tabId?: string;
  } = {},
): CanvasNode => ({
  ...base(id),
  type: "text",
  text: "untrusted Herdr card label",
  ether: {
    entity: { kind: "herdr" },
    herdr: {
      host: options.host ?? "local",
      ...(options.session === undefined ? {} : { session: options.session }),
      paneId: options.paneId ?? "pane-1",
      workspaceId: options.workspaceId ?? "workspace-1",
      tabId: options.tabId ?? "tab-1",
    },
  },
});

const pageNode = (
  id: string,
  url = `https://${id}.example.com/path?private=query#fragment`,
  profile = "default",
): CanvasNode => ({
  ...base(id),
  type: "link",
  url,
  ether: { entity: { kind: "page" }, browser: { profile } },
});

const canvas = (...nodes: ReadonlyArray<CanvasNode>): CanvasDoc => ({
  nodes: [...nodes],
  edges: [],
});

const HERMES_REF = formatNodeRef({ canvasName: "work", nodeId: "agent-1" });
const HERDR_REF = formatNodeRef({ canvasName: "work", nodeId: "herdr-1" });

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

interface SetupOptions {
  readonly doc?: CanvasDoc;
  readonly confirm?: (request: BrowserAutomationConfirmation) => Promise<boolean>;
  readonly deliver?: (
    request: BrowserAutomationRuntimeDelivery,
  ) => Promise<{ readonly cleanup?: () => void | Promise<void> } | void>;
  readonly resolvePageTarget?: PageTargetResolver;
  readonly paneMeta?: BrowserAutomationHerdrPaneMeta;
}

const liveRuntimes: BrowserAutomationRuntime[] = [];

afterEach(() => {
  for (const runtime of liveRuntimes.splice(0)) runtime.close();
});

const setup = (options: SetupOptions = {}) => {
  let currentDoc = options.doc ?? canvas(agentNode("agent-1", "local:default"), pageNode("page-1"));
  let currentPaneMeta: BrowserAutomationHerdrPaneMeta = options.paneMeta ?? {
    paneId: "pane-1",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    cwd: "/workspace/stale",
    foregroundCwd: "/workspace/current",
  };
  let now = 1_000;
  let idSequence = 0;
  let runtime: BrowserAutomationRuntime | undefined;
  const notices: BrowserCapabilityTerminationNotice[] = [];
  const confirmations: BrowserAutomationConfirmation[] = [];
  const deliveries: BrowserAutomationRuntimeDelivery[] = [];
  const defaultCleanup = vi.fn();

  const registry = new BrowserCapabilityRegistry({
    dependencies: {
      wallNow: () => now,
      monotonicNow: () => now,
      setTimer: () => Object.freeze({}),
      clearTimer: () => undefined,
    },
    onTerminate: (notice) => {
      notices.push(notice);
      runtime?.handleTermination(notice);
    },
  });

  const readCanvas = vi.fn(async (name: string) => {
    if (name !== "work") throw new Error("canvas unavailable");
    return currentDoc;
  });
  const defaultResolver: PageTargetResolver = async (ref) => {
    if (typeof ref !== "string") {
      return { ok: false as const, code: "invalid" as const, message: "invalid" };
    }
    const parsed = parseNodeRef(ref);
    if (!parsed.ok || parsed.value.canvasName !== "work") {
      return { ok: false as const, code: "invalid" as const, message: "invalid" };
    }
    const matches = currentDoc.nodes.filter((node) => node.id === parsed.value.nodeId);
    const node = matches.length === 1 ? matches[0] : undefined;
    if (node === undefined) {
      return { ok: false as const, code: "not_found" as const, message: "missing" };
    }
    if (
      node.type !== "link" ||
      node.ether?.entity?.kind !== "page" ||
      typeof node.ether.browser?.profile !== "string"
    ) {
      return { ok: false as const, code: "invalid" as const, message: "invalid" };
    }
    return {
      ok: true as const,
      data: {
        ref,
        nodeId: node.id,
        url: node.url,
        profile: node.ether.browser.profile,
      },
    };
  };
  const resolvePageTarget = vi.fn(options.resolvePageTarget ?? defaultResolver);
  const getHerdrPaneMeta = vi.fn(async () => ({ ok: true as const, data: currentPaneMeta }));
  const confirm = vi.fn(async (request: BrowserAutomationConfirmation) => {
    confirmations.push(request);
    return options.confirm?.(request) ?? true;
  });
  const deliver = vi.fn(async (request: BrowserAutomationRuntimeDelivery) => {
    deliveries.push(request);
    return options.deliver?.(request) ?? { cleanup: defaultCleanup };
  });

  runtime = new BrowserAutomationRuntime(registry, {
    readCanvas,
    resolvePageTarget,
    getHerdrPaneMeta,
    confirm,
    deliver,
    controlHome: CONTROL_HOME,
    makeAutomationId: () => automationId(++idSequence),
  });
  liveRuntimes.push(runtime);

  return {
    runtime,
    registry,
    notices,
    confirmations,
    deliveries,
    defaultCleanup,
    readCanvas,
    resolvePageTarget,
    getHerdrPaneMeta,
    confirm,
    deliver,
    setDoc: (doc: CanvasDoc) => {
      currentDoc = doc;
    },
    setPaneMeta: (meta: BrowserAutomationHerdrPaneMeta) => {
      currentPaneMeta = meta;
    },
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
};

describe("BrowserAutomationRuntime", () => {
  it("derives local Hermes identity and the complete page scope from the current canvas", async () => {
    const { runtime, registry, confirmations, deliveries, resolvePageTarget } = setup({
      doc: canvas(
        agentNode("agent-1", "local:default", "spoofed remote:admin"),
        pageNode("page-b", "https://github.com/settings", "github"),
        pageNode("page-a", "https://mail.google.com/mail/u/0/", "gmail"),
      ),
    });

    const result = await runtime.enable({ kind: "hermes", ref: HERMES_REF });

    expect(result).toEqual({
      ok: true,
      data: {
        automationId: automationId(1),
        kind: "hermes",
        ref: HERMES_REF,
        issuedAt: 1_000,
        expiresAt: 1_000 + BROWSER_AGENT_AUTHORITY_TTL_MS,
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.ok && result.data)).toBe(true);
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toMatchObject({
      subject: { kind: "hermes", label: "local:default" },
      targetCount: 2,
    });
    expect(confirmations[0]?.subject.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.plan).toMatchObject({
      kind: "hermes",
      ref: HERMES_REF,
      agentKey: "local:default",
      spawnTarget: { command: "hermes", argv: ["acp"], host: "local", profile: "default" },
    });
    expect(deliveries[0]?.plan.targets.map((target) => target.ref)).toEqual([
      formatNodeRef({ canvasName: "work", nodeId: "page-a" }),
      formatNodeRef({ canvasName: "work", nodeId: "page-b" }),
    ]);
    expect(resolvePageTarget).toHaveBeenCalledTimes(4);

    const json = JSON.stringify(result);
    const issued = registry.auditSnapshot().find((event) => event.kind === "issued");
    expect(json).not.toContain(deliveries[0]!.capability);
    expect(json).not.toContain(CONTROL_HOME);
    for (const internal of [issued?.ownerId, issued?.principalId, issued?.jobId, issued?.auditId]) {
      expect(internal).toBeDefined();
      expect(json).not.toContain(internal!);
    }
    expect(json).not.toContain("spoofed remote:admin");
  });

  it.each([
    [
      "remote Hermes",
      canvas(agentNode("agent-1", "remote-a:default"), pageNode("page-1")),
      { kind: "hermes", ref: HERMES_REF } as BrowserAutomationEnableInput,
    ],
    [
      "remote Herdr",
      canvas(herdrNode("herdr-1", { host: "remote-a" }), pageNode("page-1")),
      { kind: "herdr", ref: HERDR_REF, agent: "codex" } as BrowserAutomationEnableInput,
    ],
    [
      "named Herdr session",
      canvas(herdrNode("herdr-1", { session: "named" }), pageNode("page-1")),
      { kind: "herdr", ref: HERDR_REF, agent: "codex" } as BrowserAutomationEnableInput,
    ],
  ])("rejects %s before confirmation or minting", async (_name, doc, input) => {
    const { runtime, registry, confirm, deliver, getHerdrPaneMeta } = setup({ doc });
    await expect(runtime.enable(input)).resolves.toEqual({ ok: false, code: "invalid" });
    expect(confirm).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(getHerdrPaneMeta).not.toHaveBeenCalled();
    expect(registry.stats().activeCapabilities).toBe(0);
  });

  it("rejects malformed, missing, and duplicate selected node references", async () => {
    const malformed = setup();
    await expect(
      malformed.runtime.enable({ kind: "hermes", ref: "vellum://canvas/work?node=%61gent-1" } as BrowserAutomationEnableInput),
    ).resolves.toEqual({ ok: false, code: "invalid" });
    expect(malformed.readCanvas).not.toHaveBeenCalled();

    const missing = setup();
    await expect(
      missing.runtime.enable({
        kind: "hermes",
        ref: formatNodeRef({ canvasName: "work", nodeId: "missing" }),
      }),
    ).resolves.toEqual({ ok: false, code: "not_found" });
    expect(missing.confirm).not.toHaveBeenCalled();

    const duplicate = setup({
      doc: canvas(
        agentNode("agent-1", "local:default"),
        agentNode("agent-1", "local:other"),
        pageNode("page-1"),
      ),
    });
    await expect(duplicate.runtime.enable({ kind: "hermes", ref: HERMES_REF })).resolves.toEqual({
      ok: false,
      code: "invalid",
    });
    expect(duplicate.confirm).not.toHaveBeenCalled();
  });

  it("rejects zero, over-limit, and inconsistent page scopes before confirmation", async () => {
    const zero = setup({ doc: canvas(agentNode("agent-1", "local:default")) });
    await expect(zero.runtime.enable({ kind: "hermes", ref: HERMES_REF })).resolves.toEqual({
      ok: false,
      code: "invalid",
    });
    expect(zero.confirm).not.toHaveBeenCalled();

    const over = setup({
      doc: canvas(
        agentNode("agent-1", "local:default"),
        ...Array.from({ length: 65 }, (_, index) => pageNode(`page-${index}`)),
      ),
    });
    await expect(over.runtime.enable({ kind: "hermes", ref: HERMES_REF })).resolves.toEqual({
      ok: false,
      code: "invalid",
    });
    expect(over.resolvePageTarget).not.toHaveBeenCalled();
    expect(over.confirm).not.toHaveBeenCalled();

    const inconsistent = setup({
      resolvePageTarget: async (ref) =>
        typeof ref === "string"
          ? {
              ok: true,
              data: {
                ref,
                nodeId: "substituted",
                url: "https://other.example",
                profile: "default",
              },
            }
          : { ok: false, code: "invalid", message: "invalid" },
    });
    await expect(inconsistent.runtime.enable({ kind: "hermes", ref: HERMES_REF })).resolves.toEqual({
      ok: false,
      code: "invalid",
    });
    expect(inconsistent.confirm).not.toHaveBeenCalled();
  });

  it("derives Herdr cwd and placement only from current main-side pane metadata", async () => {
    const { runtime, deliveries, confirmations, getHerdrPaneMeta } = setup({
      doc: canvas(herdrNode("herdr-1"), pageNode("page-1")),
      paneMeta: {
        paneId: "pane-1",
        workspaceId: "workspace-1",
        tabId: "tab-1",
        cwd: "/renderer/cannot-choose-this",
        foregroundCwd: "/main/current-cwd",
      },
    });

    const result = await runtime.enable({ kind: "herdr", ref: HERDR_REF, agent: "codex" });
    expect(result).toMatchObject({
      ok: true,
      data: { kind: "herdr", ref: HERDR_REF, agent: "codex" },
    });
    expect(getHerdrPaneMeta).toHaveBeenCalledTimes(2);
    expect(getHerdrPaneMeta).toHaveBeenNthCalledWith(1, "local", null, "pane-1");
    expect(confirmations[0]).toMatchObject({
      subject: { kind: "herdr", label: "codex @ pane-1" },
      targetCount: 1,
    });
    expect(deliveries[0]?.plan).toMatchObject({
      kind: "herdr",
      agent: "codex",
      paneId: "pane-1",
      workspaceId: "workspace-1",
      tabId: "tab-1",
      cwd: "/main/current-cwd",
    });

    const mismatched = setup({
      doc: canvas(herdrNode("herdr-1", { workspaceId: "stale-workspace" }), pageNode("page-1")),
    });
    await expect(
      mismatched.runtime.enable({ kind: "herdr", ref: HERDR_REF, agent: "codex" }),
    ).resolves.toEqual({ ok: false, code: "invalid" });
    expect(mismatched.confirm).not.toHaveBeenCalled();
  });

  it("reserves duplicate enable requests across confirmation and releases cancellation for retry", async () => {
    const approval = deferred<boolean>();
    const firstSetup = setup({ confirm: () => approval.promise });
    const first = firstSetup.runtime.enable({ kind: "hermes", ref: HERMES_REF });
    await vi.waitFor(() => expect(firstSetup.confirm).toHaveBeenCalledTimes(1));
    await expect(
      firstSetup.runtime.enable({ kind: "hermes", ref: HERMES_REF }),
    ).resolves.toEqual({ ok: false, code: "invalid" });
    approval.resolve(true);
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(firstSetup.confirm).toHaveBeenCalledTimes(1);
    expect(firstSetup.deliver).toHaveBeenCalledTimes(1);

    let attempt = 0;
    const retry = setup({ confirm: async () => ++attempt > 1 });
    await expect(retry.runtime.enable({ kind: "hermes", ref: HERMES_REF })).resolves.toEqual({
      ok: false,
      code: "cancelled",
    });
    await expect(retry.runtime.enable({ kind: "hermes", ref: HERMES_REF })).resolves.toMatchObject({
      ok: true,
    });
    expect(retry.confirm).toHaveBeenCalledTimes(2);
    expect(retry.deliver).toHaveBeenCalledTimes(1);
  });

  it("redacts a failed one-shot delivery and releases the subject for retry", async () => {
    let capturedCapability = "";
    let deliveryAttempt = 0;
    const test = setup({
      deliver: async (request) => {
        capturedCapability = request.capability;
        deliveryAttempt += 1;
        if (deliveryAttempt === 1) {
          throw new Error(`sentinel failure ${request.capability} ${request.controlHome}`);
        }
      },
    });

    const failed = await test.runtime.enable({ kind: "hermes", ref: HERMES_REF });
    expect(failed).toEqual({ ok: false, code: "delivery_failed" });
    expect(JSON.stringify(failed)).not.toContain(capturedCapability);
    expect(JSON.stringify(failed)).not.toContain(CONTROL_HOME);
    expect(test.registry.stats().activeCapabilities).toBe(0);
    expect(test.runtime.list()).toEqual({ ok: true, data: [] });

    await expect(test.runtime.enable({ kind: "hermes", ref: HERMES_REF })).resolves.toMatchObject({
      ok: true,
    });
    expect(test.deliver).toHaveBeenCalledTimes(2);
  });

  it.each(["subject", "canvas"])(
    "fails closed and revokes when the confirmed %s changes before delivery",
    async (change) => {
      let test: ReturnType<typeof setup>;
      test = setup({
        confirm: async () => {
          test.setDoc(
            change === "subject"
              ? canvas(agentNode("agent-1", "local:other"), pageNode("page-1"))
              : canvas(agentNode("agent-1", "local:default"), pageNode("page-1", "https://changed.example")),
          );
          return true;
        },
      });

      const result = await test.runtime.enable({ kind: "hermes", ref: HERMES_REF });
      expect(result).toEqual({ ok: false, code: "delivery_failed" });
      expect(test.deliver).not.toHaveBeenCalled();
      expect(test.registry.stats().activeCapabilities).toBe(0);
      expect(test.runtime.list()).toEqual({ ok: true, data: [] });
    },
  );

  it("delivers once, cleans termination once, and isolates sibling public grants", async () => {
    const cleanups = new Map<string, ReturnType<typeof vi.fn>>();
    const test = setup({
      doc: canvas(
        agentNode("agent-1", "local:default"),
        agentNode("agent-2", "local:other"),
        pageNode("page-1"),
      ),
      deliver: async (request) => {
        const cleanup = vi.fn();
        cleanups.set(request.plan.ref, cleanup);
        return { cleanup };
      },
    });
    const secondRef = formatNodeRef({ canvasName: "work", nodeId: "agent-2" });

    const first = await test.runtime.enable({ kind: "hermes", ref: HERMES_REF });
    const second = await test.runtime.enable({ kind: "hermes", ref: secondRef });
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    expect(test.deliver).toHaveBeenCalledTimes(2);
    expect(test.runtime.list()).toMatchObject({ ok: true, data: [{ ref: HERMES_REF }, { ref: secondRef }] });

    if (!first.ok || !second.ok) return;
    expect(test.runtime.revoke(first.data.automationId)).toEqual({
      ok: true,
      data: { revoked: true },
    });
    expect(cleanups.get(HERMES_REF)).toHaveBeenCalledTimes(1);
    expect(cleanups.get(secondRef)).not.toHaveBeenCalled();
    expect(test.runtime.list()).toEqual({ ok: true, data: [second.data] });

    const firstNotice = test.notices[0];
    expect(firstNotice).toBeDefined();
    test.runtime.handleTermination(firstNotice!);
    expect(cleanups.get(HERMES_REF)).toHaveBeenCalledTimes(1);

    test.advance(BROWSER_AGENT_AUTHORITY_TTL_MS);
    expect(test.registry.reapExpired()).toBe(1);
    expect(cleanups.get(secondRef)).toHaveBeenCalledTimes(1);
    expect(test.runtime.list()).toEqual({ ok: true, data: [] });
    expect(test.deliver).toHaveBeenCalledTimes(2);
  });

  it("closes active delivery cleanup exactly once and rejects later public operations", async () => {
    const test = setup();
    const issued = await test.runtime.enable({ kind: "hermes", ref: HERMES_REF });
    expect(issued).toMatchObject({ ok: true });

    expect(test.runtime.close()).toBe(1);
    expect(test.defaultCleanup).toHaveBeenCalledTimes(1);
    expect(test.runtime.close()).toBe(0);
    expect(test.defaultCleanup).toHaveBeenCalledTimes(1);
    expect(test.runtime.list()).toEqual({ ok: false, code: "closed" });
    if (issued.ok) {
      expect(test.runtime.revoke(issued.data.automationId)).toEqual({
        ok: false,
        code: "closed",
      });
    }
    await expect(test.runtime.enable({ kind: "hermes", ref: HERMES_REF })).resolves.toEqual({
      ok: false,
      code: "closed",
    });
  });

  it("does not deliver a minted bearer when close wins the asynchronous plan recheck", async () => {
    const pageRef = formatNodeRef({ canvasName: "work", nodeId: "page-1" });
    const recheck = deferred<Awaited<ReturnType<PageTargetResolver>>>();
    let resolverCalls = 0;
    const test = setup({
      resolvePageTarget: async (ref) => {
        resolverCalls += 1;
        if (resolverCalls === 2) return recheck.promise;
        return typeof ref === "string"
          ? {
              ok: true,
              data: {
                ref,
                nodeId: "page-1",
                url: "https://page-1.example.com/path?private=query#fragment",
                profile: "default",
              },
            }
          : { ok: false, code: "invalid", message: "invalid" };
      },
    });

    const enabling = test.runtime.enable({ kind: "hermes", ref: HERMES_REF });
    await vi.waitFor(() => expect(resolverCalls).toBe(2));
    expect(test.runtime.close()).toBe(1);
    recheck.resolve({
      ok: true,
      data: {
        ref: pageRef,
        nodeId: "page-1",
        url: "https://page-1.example.com/path?private=query#fragment",
        profile: "default",
      },
    });

    await expect(enabling).resolves.toEqual({ ok: false, code: "delivery_failed" });
    expect(test.deliver).not.toHaveBeenCalled();
    expect(test.registry.stats().activeCapabilities).toBe(0);
  });
});
