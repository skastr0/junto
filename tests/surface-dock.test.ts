import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserOpResult, BrowserSessionInfo } from "../src/shared/ipc";
import { formatNodeRef, parseNodeRef } from "../src/shared/node-ref";
import {
  closeSurface,
  focusSurface,
  initialWorkbenchState,
  isInteractiveSurface,
  openSurface,
  pinSurface,
  setFocusSize,
  setLayout,
  unpinSurface,
  visiblePanes,
  workbenchBrowserSurfaces,
  workbenchInteractiveSurface,
  workFocusSizeKeyForSurfaces,
  type WorkbenchState,
} from "../src/renderer/lib/surface-registry";
import {
  closeDockBrowser,
  closeWorkbenchSurface,
  chatSurfaceId,
  dock$,
  herdrSurfaceId,
  openAgentChatSurface,
  openDockBrowser,
  openTaskCreateSurface,
  pinWorkbenchSurface,
  reconcileDockFromLiveSessions,
  stopDockBrowser,
  syncHerdrWorkbenchSlot,
  taskCreateSurfaceId,
  terminalSurfaceId,
} from "../src/renderer/lib/dock-state";
import { browser$, cacheBrowserSession } from "../src/renderer/lib/browser-state";
import { herdr$ } from "../src/renderer/lib/herdr-state";
import { openTerminalSurface, terminal$ } from "../src/renderer/lib/terminal-state";
import type { CanvasNode } from "../src/shared/canvas";

// --- pure registry ---------------------------------------------------------

const browserSlot = (id: string) => ({ id, kind: "browser" as const });
const herdrSlot = (id: string) => ({ id, kind: "herdr" as const });

describe("surface-registry (pure workbench)", () => {
  it("opens unlimited browser surfaces into focus (tabs, no eviction)", () => {
    let t = openSurface(initialWorkbenchState(), browserSlot("a"));
    expect(t.evicted).toEqual([]);
    t = openSurface(t.state, browserSlot("b"));
    t = openSurface(t.state, browserSlot("c"));
    expect(t.evicted).toEqual([]);
    expect(t.state.surfaces.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(t.state.focusMru[0]).toBe("c");
  });

  it("re-requesting an open surface brings it to front of its zone MRU", () => {
    let t = openSurface(initialWorkbenchState(), browserSlot("a"));
    t = openSurface(t.state, browserSlot("b"));
    const again = openSurface(t.state, browserSlot("a"));
    expect(again.evicted).toEqual([]);
    expect(again.state.focusMru[0]).toBe("a");
    expect(again.state.surfaces.map((s) => s.id).sort()).toEqual(["a", "b"]);
  });

  it("allows multiple herdr surfaces (no global interactive eviction)", () => {
    let t = openSurface(initialWorkbenchState(), browserSlot("a"));
    t = openSurface(t.state, herdrSlot("herdr:n1"));
    t = openSurface(t.state, herdrSlot("herdr:n2"));
    expect(t.evicted).toEqual([]);
    expect(t.state.surfaces.filter((s) => s.kind === "herdr").map((s) => s.id).sort()).toEqual([
      "herdr:n1",
      "herdr:n2",
    ]);
    expect(workbenchBrowserSurfaces(t.state).map((s) => s.id)).toEqual(["a"]);
    expect(workbenchInteractiveSurface(t.state)?.id).toBe("herdr:n1");
  });

  it("a browser never evicts herdr surfaces", () => {
    let t = openSurface(initialWorkbenchState(), herdrSlot("herdr:n1"));
    t = openSurface(t.state, browserSlot("a"));
    t = openSurface(t.state, browserSlot("b"));
    expect(t.evicted).toEqual([]);
    expect(t.state.surfaces.map((s) => s.id)).toEqual(["herdr:n1", "a", "b"]);
  });

  it("same id changing kind replaces the stale slot (evicted for cleanup)", () => {
    const t0 = openSurface(initialWorkbenchState(), browserSlot("x"));
    const t = openSurface(t0.state, herdrSlot("x"));
    expect(t.evicted.map((s) => s.id)).toEqual(["x"]);
    expect(t.state.surfaces).toEqual([{ id: "x", kind: "herdr", zone: "focus" }]);
  });

  it("closeSurface removes the slot; unknown ids are a no-op", () => {
    const t0 = openSurface(initialWorkbenchState(), browserSlot("a"));
    const closed = closeSurface(t0.state, "a");
    expect(closed.state.surfaces).toEqual([]);
    expect(closed.evicted.map((s) => s.id)).toEqual(["a"]);
    const noop = closeSurface(closed.state, "ghost");
    expect(noop.evicted).toEqual([]);
  });

  it("pin / unpin moves zone and MRU stacks", () => {
    let t = openSurface(initialWorkbenchState(), browserSlot("a"));
    t = pinSurface(t.state, "a");
    expect(t.state.surfaces[0]?.zone).toBe("pinned");
    expect(t.state.pinnedMru).toEqual(["a"]);
    expect(t.state.focusMru).toEqual([]);
    t = unpinSurface(t.state, "a");
    expect(t.state.surfaces[0]?.zone).toBe("focus");
    expect(t.state.focusMru).toEqual(["a"]);
  });

  it("visiblePanes respects layout solo vs split", () => {
    let state: WorkbenchState = initialWorkbenchState();
    for (const id of ["a", "b", "c"]) {
      state = openSurface(state, browserSlot(id)).state;
    }
    // MRU front is c
    expect(visiblePanes(state, "focus")).toEqual({
      pane0: "c",
      pane1: undefined,
      tabs: ["b", "a"],
    });
    state = setLayout(state, "focus", "split-v").state;
    expect(visiblePanes(state, "focus")).toEqual({
      pane0: "c",
      pane1: "b",
      tabs: ["a"],
    });
    state = focusSurface(state, "a").state;
    expect(visiblePanes(state, "focus").pane0).toBe("a");
  });

  it("classifies browser as non-interactive; herdr/chat/task-create as interactive", () => {
    expect(isInteractiveSurface("browser")).toBe(false);
    expect(isInteractiveSurface("herdr")).toBe(true);
    expect(isInteractiveSurface("chat")).toBe(true);
    expect(isInteractiveSurface("task-create")).toBe(true);
  });

  it("opens task-create into focus and pins beside other surfaces", () => {
    let t = openSurface(initialWorkbenchState(), {
      id: "terminal:n1",
      kind: "terminal",
    });
    t = pinSurface(t.state, "terminal:n1");
    t = openSurface(t.state, { id: "task-create:tasks-1", kind: "task-create" }, "focus");
    expect(t.state.surfaces.map((s) => `${s.zone}:${s.kind}`).sort()).toEqual([
      "focus:task-create",
      "pinned:terminal",
    ]);
    t = pinSurface(t.state, "task-create:tasks-1");
    expect(t.state.pinnedMru).toEqual(["task-create:tasks-1", "terminal:n1"]);
  });

  it("keys remembered focus width by surface family so pin/resize cannot poison enqueue", () => {
    expect(
      workFocusSizeKeyForSurfaces([{ id: "t1", kind: "terminal", zone: "focus" }]),
    ).toBe("terminal");
    expect(
      workFocusSizeKeyForSurfaces([
        { id: "task-create:x", kind: "task-create", zone: "focus" },
      ]),
    ).toBe("task-create");
    expect(
      workFocusSizeKeyForSurfaces([
        { id: "c1", kind: "chat", zone: "focus" },
        { id: "c2", kind: "chat", zone: "focus" },
      ]),
    ).toBe("chat");
    expect(
      workFocusSizeKeyForSurfaces([
        { id: "t1", kind: "terminal", zone: "focus" },
        { id: "task-create:x", kind: "task-create", zone: "focus" },
      ]),
    ).toBe("workspace");

    let state = initialWorkbenchState();
    state = setFocusSize(state, {
      key: "terminal",
      width: 480,
      height: 800,
    }).state;
    expect(state.focusSize?.key).toBe("terminal");
    expect(state.focusSize?.width).toBe(480);
    // Writing a different family replaces memory (shell only restores matching key).
    state = setFocusSize(state, {
      key: "task-create",
      width: 1080,
      height: 800,
    }).state;
    expect(state.focusSize).toEqual({
      key: "task-create",
      width: 1080,
      height: 800,
    });
  });
});

// --- dock-state (observable + side effects) --------------------------------

interface MockVellum {
  browserOpen: ReturnType<typeof vi.fn>;
  browserClose: ReturnType<typeof vi.fn>;
  browserStop: ReturnType<typeof vi.fn>;
  browserSurfaceConfig?: ReturnType<typeof vi.fn>;
  browserSessionList?: ReturnType<typeof vi.fn>;
}

const refOf = (nodeId: string, canvasName = "portfolio"): string =>
  formatNodeRef({ canvasName, nodeId });

const payloadOf = (nodeId: string, url: string, title: string, profile = "personal") => ({
  nodeId,
  browser: { profile },
  url,
  title,
});

const baseSession = (
  ref: string,
  nodeId: string,
  sessionId: string,
  overrides: Partial<BrowserSessionInfo> = {},
): BrowserSessionInfo => ({
  ref,
  sessionId,
  nodeId,
  url: "https://example.com",
  hostId: "local",
  profile: "personal",
  state: "loading",
  attached: false,
  ...overrides,
});

function installMockVellum(overrides: Partial<MockVellum> = {}): MockVellum {
  let handle = 0;
  const sessions = new Map<string, BrowserSessionInfo>();
  const mock: MockVellum = {
    browserOpen: vi.fn(async (input: { ref: string }): Promise<BrowserOpResult<BrowserSessionInfo>> => {
      const parsed = parseNodeRef(input.ref);
      if (!parsed.ok) return { ok: false, code: "invalid", message: "bad ref" };
      const session = baseSession(input.ref, parsed.value.nodeId, `session-${++handle}`);
      sessions.set(session.sessionId, session);
      return { ok: true, data: session };
    }),
    browserClose: vi.fn(async (sessionId: string): Promise<BrowserOpResult<BrowserSessionInfo>> => {
      const session = sessions.get(sessionId) ?? baseSession(refOf("closed"), "closed", sessionId);
      return { ok: true, data: { ...session, state: "detached", attached: false } };
    }),
    browserStop: vi.fn(async (sessionId: string) => ({
      ok: true,
      data: {
        sessionId,
        ref: sessions.get(sessionId)?.ref ?? refOf("stopped"),
        profile: sessions.get(sessionId)?.profile ?? "personal",
        stopped: true as const,
        alreadyStopped: false,
      },
    })),
    browserSessionList: vi.fn(async () => ({ ok: true, data: [...sessions.values()] })),
    ...overrides,
  };
  (globalThis as unknown as { window: { vellumCommand: MockVellum } }).window = { vellumCommand: mock };
  return mock;
}

function resetDock(): void {
  dock$.registry.set(initialWorkbenchState());
  dock$.browserByRef.set({});
  dock$.chatById.set({});
  dock$.stopErrorByRef.set({});
  dock$.configHydrated.set(false);
  browser$.sessionByRef.set({});
  herdr$.terminals.set({});
  herdr$.focusedNodeId.set(null);
  terminal$.openByNodeId.set({});
  terminal$.preferredZoneByNodeId.set({});
}

const nativeTerminalNode = (id = "term-1"): CanvasNode =>
  ({
    id,
    type: "text",
    text: "terminal",
    x: 0,
    y: 0,
    width: 220,
    height: 84,
    ether: {
      entity: { kind: "terminal" },
      host: "local",
      terminal: {
        bindingId: `bind-${id}`,
        launch: { kind: "command", argv: ["zsh"] },
      },
    },
  }) satisfies CanvasNode;

describe("dock-state", () => {
  beforeEach(resetDock);
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    resetDock();
  });

  it("openDockBrowser registers the slot + payload and opens the session over IPC", async () => {
    const mock = installMockVellum();
    const ref = refOf("n1");
    await openDockBrowser(ref, payloadOf("n1", "https://example.com", "Example"));
    expect(dock$.registry.peek().surfaces).toEqual([
      { id: ref, kind: "browser", zone: "focus" },
    ]);
    expect(dock$.browserByRef.peek()[ref]).toMatchObject({ url: "https://example.com" });
    expect(mock.browserOpen).toHaveBeenCalledWith({ ref });
    expect(browser$.sessionByRef[ref].peek()).toMatchObject({
      ref,
      sessionId: "session-1",
      state: "loading",
    });
  });

  it("opens task-create enqueue surface and keeps payload across pin", () => {
    const node = {
      id: "tasks-1",
      type: "text" as const,
      x: 0,
      y: 0,
      width: 240,
      height: 96,
      text: "Say hi",
      ether: { entity: { kind: "task" } },
    } satisfies CanvasNode;
    openTaskCreateSurface(node, { mode: "task" });
    const id = taskCreateSurfaceId(node.id);
    expect(dock$.registry.peek().surfaces).toEqual([
      { id, kind: "task-create", zone: "focus" },
    ]);
    expect(dock$.taskCreateById[id].peek()).toEqual({
      nodeId: "tasks-1",
      title: "Say hi",
      mode: "task",
    });
    pinWorkbenchSurface(id);
    expect(dock$.registry.peek().surfaces[0]?.zone).toBe("pinned");
    expect(dock$.taskCreateById[id].peek()?.mode).toBe("task");
    closeWorkbenchSurface(id);
    expect(dock$.registry.peek().surfaces).toEqual([]);
    expect(dock$.taskCreateById[id].peek()).toBeUndefined();
  });

  it("opens agent chat as a focus surface and preserves its payload across pinning", () => {
    const node = {
      id: "agent-1",
      type: "text" as const,
      x: 0,
      y: 0,
      width: 240,
      height: 96,
      text: "PROFILE-01",
      ether: { entity: { kind: "agent", name: "remote-a:profile-01" } },
    };
    openAgentChatSurface(node);
    const id = chatSurfaceId(node.id);
    expect(dock$.registry.peek().surfaces).toEqual([
      { id, kind: "chat", zone: "focus" },
    ]);
    expect(dock$.chatById[id].peek()).toEqual({
      nodeId: "agent-1",
      agentKey: "remote-a:profile-01",
      title: "PROFILE-01",
    });

    pinWorkbenchSurface(id);
    expect(dock$.registry.peek().surfaces[0]?.zone).toBe("pinned");
    expect(dock$.chatById[id].peek()?.agentKey).toBe("remote-a:profile-01");

    closeWorkbenchSurface(id);
    expect(dock$.registry.peek().surfaces).toEqual([]);
    expect(dock$.chatById[id].peek()).toBeUndefined();
  });

  it("opens many browsers without detaching earlier ones (tabs replace eviction)", async () => {
    const mock = installMockVellum();
    const refs = [refOf("n1"), refOf("n2"), refOf("n3")];
    await openDockBrowser(refs[0]!, payloadOf("n1", "https://a.example", "A"));
    await openDockBrowser(refs[1]!, payloadOf("n2", "https://b.example", "B"));
    await openDockBrowser(refs[2]!, payloadOf("n3", "https://c.example", "C"));
    expect(dock$.registry.peek().surfaces.map((s) => s.id)).toEqual(refs);
    expect(mock.browserClose).not.toHaveBeenCalled();
  });

  it("closeDockBrowser removes UI without an identity fallback when no handle exists", () => {
    const mock = installMockVellum();
    const ref = refOf("ghost");
    dock$.browserByRef[ref].set(payloadOf("ghost", "https://ghost.example", "Ghost"));
    dock$.registry.set(openSurface(dock$.registry.peek(), browserSlot(ref)).state);
    closeDockBrowser(ref);
    expect(dock$.registry.peek().surfaces).toEqual([]);
    expect(dock$.browserByRef[ref].peek()).toBeUndefined();
    expect(mock.browserClose).not.toHaveBeenCalled();
  });

  it("replaces a recreated session handle and closes only the current handle", async () => {
    const ref = refOf("n1");
    const oldSession = baseSession(ref, "n1", "old-handle");
    const newSession = baseSession(ref, "n1", "new-handle");
    const mock = installMockVellum({
      browserOpen: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, data: oldSession })
        .mockResolvedValueOnce({ ok: true, data: newSession }),
    });
    const payload = payloadOf("n1", "https://a.example", "A");
    await openDockBrowser(ref, payload);
    await openDockBrowser(ref, payload);
    expect(browser$.sessionByRef[ref].peek()?.sessionId).toBe("new-handle");
    closeDockBrowser(ref);
    expect(mock.browserClose).toHaveBeenLastCalledWith("new-handle");
    expect(mock.browserClose).not.toHaveBeenCalledWith("old-handle");
  });

  it("Stop Page destroys the exact current handle and clears UI state without detaching", async () => {
    const mock = installMockVellum();
    const ref = refOf("stop-page");
    await openDockBrowser(ref, payloadOf("stop-page", "https://stop.example", "Stop"));

    await stopDockBrowser(ref);

    expect(mock.browserStop).toHaveBeenCalledOnce();
    expect(mock.browserStop).toHaveBeenCalledWith("session-1");
    expect(mock.browserClose).not.toHaveBeenCalled();
    expect(dock$.registry.peek().surfaces).toEqual([]);
    expect(dock$.browserByRef[ref].peek()).toBeUndefined();
    expect(browser$.sessionByRef[ref].peek()).toBeUndefined();
  });

  it("keeps a replacement runtime visible when it arrives before the stopped handle completes", async () => {
    let finishStop!: (result: { readonly ok: true; readonly data: unknown }) => void;
    const pendingStop = new Promise<{ readonly ok: true; readonly data: unknown }>((resolve) => {
      finishStop = resolve;
    });
    const mock = installMockVellum({ browserStop: vi.fn(() => pendingStop) });
    const ref = refOf("stop-race");
    await openDockBrowser(ref, payloadOf("stop-race", "https://stop.example", "Stop"));

    const stopping = stopDockBrowser(ref);
    for (let i = 0; i < 20 && !mock.browserStop.mock.calls.length; i++) {
      await Promise.resolve();
    }
    expect(mock.browserStop).toHaveBeenCalledWith("session-1");
    cacheBrowserSession(baseSession(ref, "stop-race", "replacement-handle"));
    finishStop({ ok: true, data: {} });

    await expect(stopping).resolves.toBe(false);
    expect(mock.browserStop).toHaveBeenCalledTimes(1);
    expect(browser$.sessionByRef[ref].peek()?.sessionId).toBe("replacement-handle");
    expect(dock$.registry.peek().surfaces).toEqual([
      { id: ref, kind: "browser", zone: "focus" },
    ]);
    expect(dock$.stopErrorByRef[ref].peek()).toBe(
      "Page runtime changed while stopping; retry Stop Page.",
    );
  });

  it("Stop Page fails closed and keeps the surface discoverable when main rejects it", async () => {
    const mock = installMockVellum({
      browserStop: vi.fn(async () => ({
        ok: false,
        code: "failed",
        message: "physical teardown not acknowledged",
      })),
    });
    const ref = refOf("stop-failed");
    await openDockBrowser(ref, payloadOf("stop-failed", "https://stop.example", "Stop"));

    await stopDockBrowser(ref);

    expect(mock.browserStop).toHaveBeenCalledWith("session-1");
    expect(dock$.registry.peek().surfaces).toEqual([
      { id: ref, kind: "browser", zone: "focus" },
    ]);
    expect(browser$.sessionByRef[ref].peek()?.sessionId).toBe("session-1");
    expect(dock$.stopErrorByRef[ref].peek()).toBe("physical teardown not acknowledged");
  });

  it("treats authoritative session-list absence as already stopped", async () => {
    const mock = installMockVellum({
      browserSessionList: vi.fn(async () => ({ ok: true, data: [] })),
    });
    const ref = refOf("already-stopped");
    dock$.browserByRef[ref].set(payloadOf("already-stopped", "https://stop.example", "Stop"));
    dock$.registry.set(openSurface(dock$.registry.peek(), browserSlot(ref)).state);

    await expect(stopDockBrowser(ref)).resolves.toBe(true);

    expect(mock.browserSessionList).toHaveBeenCalledOnce();
    expect(mock.browserStop).not.toHaveBeenCalled();
    expect(dock$.registry.peek().surfaces).toEqual([]);
    expect(dock$.browserByRef[ref].peek()).toBeUndefined();
  });

  it("succeeds and clears residual state when browserStop is feature-flagged off", async () => {
    // BROWSER_ENABLED=false omits the browser slice from preload.
    (globalThis as unknown as { window: { vellumCommand: Record<string, never> } }).window = {
      vellumCommand: {},
    };
    const ref = refOf("flag-off");
    dock$.browserByRef[ref].set(payloadOf("flag-off", "https://stop.example", "Stop"));
    dock$.registry.set(openSurface(dock$.registry.peek(), browserSlot(ref)).state);
    cacheBrowserSession(baseSession(ref, "flag-off", "ghost-handle"));

    await expect(stopDockBrowser(ref)).resolves.toBe(true);

    expect(dock$.registry.peek().surfaces).toEqual([]);
    expect(dock$.browserByRef[ref].peek()).toBeUndefined();
    expect(browser$.sessionByRef[ref].peek()).toBeUndefined();
    expect(dock$.stopErrorByRef[ref].peek()).toBeUndefined();
  });

  it("clears a stale cached handle when Stop Page returns not_found and the session list proves absence", async () => {
    const mock = installMockVellum({
      browserStop: vi.fn(async () => ({
        ok: false,
        code: "not_found",
        message: "no session",
      })),
      browserSessionList: vi.fn(async () => ({ ok: true, data: [] })),
    });
    const ref = refOf("stale-stopped");
    dock$.browserByRef[ref].set(payloadOf("stale-stopped", "https://stop.example", "Stop"));
    dock$.registry.set(openSurface(dock$.registry.peek(), browserSlot(ref)).state);
    cacheBrowserSession(baseSession(ref, "stale-stopped", "stale-handle"));

    await expect(stopDockBrowser(ref)).resolves.toBe(true);

    expect(mock.browserStop).toHaveBeenCalledWith("stale-handle");
    expect(mock.browserSessionList).toHaveBeenCalledOnce();
    expect(dock$.registry.peek().surfaces).toEqual([]);
    expect(browser$.sessionByRef[ref].peek()).toBeUndefined();
  });

  it("never redirects a stale Stop Page request onto a replacement runtime without a retry", async () => {
    const ref = refOf("replaced-runtime");
    const replacement = baseSession(ref, "replaced-runtime", "replacement-handle");
    const mock = installMockVellum({
      browserStop: vi.fn(async () => ({
        ok: false,
        code: "not_found",
        message: "no session",
      })),
      browserSessionList: vi.fn(async () => ({ ok: true, data: [replacement] })),
    });
    dock$.browserByRef[ref].set(payloadOf("replaced-runtime", "https://stop.example", "Stop"));
    dock$.registry.set(openSurface(dock$.registry.peek(), browserSlot(ref)).state);
    cacheBrowserSession(baseSession(ref, "replaced-runtime", "stale-handle"));

    await expect(stopDockBrowser(ref)).resolves.toBe(false);

    expect(mock.browserStop).toHaveBeenCalledTimes(1);
    expect(mock.browserStop).toHaveBeenCalledWith("stale-handle");
    expect(browser$.sessionByRef[ref].peek()?.sessionId).toBe("replacement-handle");
    expect(dock$.registry.peek().surfaces).toEqual([
      { id: ref, kind: "browser", zone: "focus" },
    ]);
    expect(dock$.stopErrorByRef[ref].peek()).toBe(
      "Page runtime changed while stopping; retry Stop Page.",
    );
  });

  it("does not let a stale open response replace a newer pushed handle", async () => {
    const ref = refOf("n-stale-open");
    const oldSession = baseSession(ref, "n-stale-open", "old-open");
    const newSession = baseSession(ref, "n-stale-open", "new-push", { state: "ready" });
    let resolveOpen: ((result: BrowserOpResult<BrowserSessionInfo>) => void) | undefined;
    const pendingOpen = new Promise<BrowserOpResult<BrowserSessionInfo>>((resolve) => {
      resolveOpen = resolve;
    });
    const mock = installMockVellum({ browserOpen: vi.fn(() => pendingOpen) });
    dock$.configHydrated.set(true);
    const opening = openDockBrowser(
      ref,
      payloadOf("n-stale-open", "https://a.example", "A"),
    );
    for (let i = 0; i < 20 && !mock.browserOpen.mock.calls.length; i++) {
      await Promise.resolve();
    }
    expect(mock.browserOpen).toHaveBeenCalledWith({ ref });
    cacheBrowserSession(newSession);
    resolveOpen?.({ ok: true, data: oldSession });
    await opening;
    expect(browser$.sessionByRef[ref].peek()?.sessionId).toBe("new-push");
  });

  it("degrades quietly when window.vellumCommand is absent", async () => {
    const ref = refOf("n1");
    await expect(openDockBrowser(ref, payloadOf("n1", "https://a.example", "A", "p"))).resolves.toBeUndefined();
    expect(() => closeDockBrowser(ref)).not.toThrow();
  });

  it("reconciles attached sessions by canonical ref and exact sessionId", async () => {
    const attachedRef = refOf("attached");
    const detachedRef = refOf("detached");
    installMockVellum({
      browserSessionList: vi.fn(async () => ({
        ok: true,
        data: [
          baseSession(attachedRef, "attached", "attached-handle", { attached: true, state: "ready" }),
          baseSession(detachedRef, "detached", "detached-handle", { attached: false }),
          { ...baseSession(refOf("invalid"), "invalid", ""), attached: true },
        ],
      })),
    });
    await reconcileDockFromLiveSessions();
    expect(dock$.registry.peek().surfaces).toEqual([
      { id: attachedRef, kind: "browser", zone: "focus" },
    ]);
    expect(dock$.browserByRef[attachedRef].peek()?.nodeId).toBe("attached");
    expect(browser$.sessionByRef[attachedRef].peek()?.sessionId).toBe("attached-handle");
    expect(dock$.browserByRef[detachedRef].peek()).toBeUndefined();
  });

  describe("herdr workbench sync — multi terminal, focus by default", () => {
    const openTerminal = (nodeId = "h1") => {
      herdr$.terminals[nodeId].set({
        nodeId,
        herdr: { host: "local" } as never,
        title: "term",
      });
      herdr$.focusedNodeId.set(nodeId);
    };

    it("registers every open terminal into the focus zone (no browser required)", () => {
      openTerminal("h1");
      syncHerdrWorkbenchSlot();
      expect(dock$.registry.peek().surfaces).toEqual([
        { id: herdrSurfaceId("h1"), kind: "herdr", zone: "focus" },
      ]);
    });

    it("registers multiple herdr surfaces for multiple terminals", () => {
      openTerminal("h1");
      openTerminal("h2");
      syncHerdrWorkbenchSlot();
      const herdrIds = dock$.registry
        .peek()
        .surfaces.filter((s) => s.kind === "herdr")
        .map((s) => s.id)
        .sort();
      expect(herdrIds).toEqual([herdrSurfaceId("h1"), herdrSurfaceId("h2")].sort());
    });

    it("removes the workbench slot when the terminal closes", () => {
      openTerminal("h1");
      syncHerdrWorkbenchSlot();
      expect(dock$.registry.peek().surfaces.some((s) => s.kind === "herdr")).toBe(true);

      herdr$.terminals.set({});
      herdr$.focusedNodeId.set(null);
      syncHerdrWorkbenchSlot();
      expect(dock$.registry.peek().surfaces.some((s) => s.kind === "herdr")).toBe(false);
    });

    it("preserves pin zone across re-sync", () => {
      openTerminal("h1");
      syncHerdrWorkbenchSlot();
      pinWorkbenchSurface(herdrSurfaceId("h1"));
      expect(
        dock$.registry.peek().surfaces.find((s) => s.id === herdrSurfaceId("h1"))?.zone,
      ).toBe("pinned");
      syncHerdrWorkbenchSlot();
      expect(
        dock$.registry.peek().surfaces.find((s) => s.id === herdrSurfaceId("h1"))?.zone,
      ).toBe("pinned");
    });

    it("docking the terminal never spawns a second herdr slot on re-sync", () => {
      openTerminal("h1");
      syncHerdrWorkbenchSlot();
      syncHerdrWorkbenchSlot();
      const herdrSlots = dock$.registry.peek().surfaces.filter((s) => s.kind === "herdr");
      expect(herdrSlots).toHaveLength(1);
    });

    it("browser + herdr coexist without eviction", async () => {
      installMockVellum();
      const ref = refOf("n1");
      await openDockBrowser(ref, payloadOf("n1", "https://a.example", "A", "p"));
      openTerminal("h1");
      syncHerdrWorkbenchSlot();
      expect(dock$.registry.peek().surfaces.map((s) => s.id).sort()).toEqual(
        [ref, herdrSurfaceId("h1")].sort(),
      );
    });

    it("observe registers herdr surfaces without an explicit sync call", () => {
      // dock-state binds observe(herdr$.terminals) at module load.
      openTerminal("h1");
      expect(dock$.registry.peek().surfaces).toEqual([
        { id: herdrSurfaceId("h1"), kind: "herdr", zone: "focus" },
      ]);
    });

    it("closeWorkbenchSurface drops the herdr slot immediately", () => {
      openTerminal("h1");
      const id = herdrSurfaceId("h1");
      expect(dock$.registry.peek().surfaces.some((s) => s.id === id)).toBe(true);
      closeWorkbenchSurface(id);
      expect(dock$.registry.peek().surfaces.some((s) => s.id === id)).toBe(false);
      expect(herdr$.terminals["h1"].peek()).toBeUndefined();
    });
  });

  describe("native terminal open zone", () => {
    it("opens into focus by default", () => {
      const node = nativeTerminalNode("t1");
      openTerminalSurface(node);
      expect(dock$.registry.peek().surfaces).toEqual([
        { id: terminalSurfaceId("t1"), kind: "terminal", zone: "focus" },
      ]);
    });

    it("opens auto-pinned when preferred zone is pinned", () => {
      const node = nativeTerminalNode("t1");
      openTerminalSurface(node, "pinned");
      expect(dock$.registry.peek().surfaces).toEqual([
        { id: terminalSurfaceId("t1"), kind: "terminal", zone: "pinned" },
      ]);
      expect(dock$.registry.peek().pinnedMru[0]).toBe(terminalSurfaceId("t1"));
    });

    it("moves an already-open focus terminal into pinned on open-pinned", () => {
      const node = nativeTerminalNode("t1");
      openTerminalSurface(node, "focus");
      expect(dock$.registry.peek().surfaces[0]?.zone).toBe("focus");
      openTerminalSurface(node, "pinned");
      expect(dock$.registry.peek().surfaces).toEqual([
        { id: terminalSurfaceId("t1"), kind: "terminal", zone: "pinned" },
      ]);
    });

    it("does not re-pin after the operator unpins when another terminal opens", () => {
      const a = nativeTerminalNode("t1");
      const b = nativeTerminalNode("t2");
      openTerminalSurface(a, "pinned");
      const idA = terminalSurfaceId("t1");
      // Operator moves back to focus.
      dock$.registry.set(unpinSurface(dock$.registry.peek(), idA).state);
      expect(dock$.registry.peek().surfaces.find((s) => s.id === idA)?.zone).toBe("focus");

      openTerminalSurface(b, "focus");
      expect(dock$.registry.peek().surfaces.find((s) => s.id === idA)?.zone).toBe("focus");
      expect(dock$.registry.peek().surfaces.find((s) => s.id === terminalSurfaceId("t2"))?.zone).toBe(
        "focus",
      );
    });
  });
});
