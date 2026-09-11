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
  closeFocusModalSurface,
  closeWorkbenchSurface,
  chatSurfaceId,
  dock$,
  noteSurfaceId,
  openAgentChatSurface,
  openDockBrowser,
  openNoteSurface,
  openTaskCreateSurface,
  pinWorkbenchSurface,
  reconcileDockFromLiveSessions,
  stopDockBrowser,
  taskCreateSurfaceId,
  terminalSurfaceId,
} from "../src/renderer/lib/dock-state";
import { browser$, cacheBrowserSession } from "../src/renderer/lib/browser-state";
import { openTerminalSurface, terminal$ } from "../src/renderer/lib/terminal-state";
import type { CanvasNode } from "../src/shared/canvas";
import {
  discardAndCloseNoteSurface,
  saveNoteSurfaceDraft,
} from "../src/renderer/components/workbench/NoteSurface";
import { state$ } from "../src/renderer/lib/state";

// --- pure registry ---------------------------------------------------------

const browserSlot = (id: string) => ({ id, kind: "browser" as const });

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



  it("same id changing kind replaces the stale slot (evicted for cleanup)", () => {
    const t0 = openSurface(initialWorkbenchState(), browserSlot("x"));
    const t = openSurface(t0.state, { id: "x", kind: "terminal" as const });
    expect(t.evicted.map((s) => s.id)).toEqual(["x"]);
    expect(t.state.surfaces).toEqual([{ id: "x", kind: "terminal", zone: "focus" }]);
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

  it("focusing the frontmost surface preserves the identical state", () => {
    let state = openSurface(initialWorkbenchState(), browserSlot("a")).state;
    state = openSurface(state, browserSlot("b")).state;

    const focused = focusSurface(state, "b");

    expect(focused.state).toBe(state);
    expect(focused.evicted).toEqual([]);
  });

  it("classifies browser as non-interactive; chat/task-create as interactive", () => {
    expect(isInteractiveSurface("browser")).toBe(false);
    expect(isInteractiveSurface("chat")).toBe(true);
    expect(isInteractiveSurface("task-create")).toBe(true);
    expect(isInteractiveSurface("note")).toBe(true);
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
      workFocusSizeKeyForSurfaces([{ id: "note:n1", kind: "note", zone: "focus" }]),
    ).toBe("document");
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
  browserSetBounds?: ReturnType<typeof vi.fn>;
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
  state$.doc.set({ nodes: [], edges: [] });
  dock$.registry.set(initialWorkbenchState());
  dock$.browserByRef.set({});
  dock$.chatById.set({});
  dock$.taskCreateById.set({});
  dock$.noteById.set({});
  dock$.opErrorByRef.set({});
  browser$.sessionByRef.set({});
  terminal$.openByNodeId.set({});
  terminal$.preferredZoneByNodeId.set({});
  terminal$.lastOpenNodeId.set(null);
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
    openTaskCreateSurface(node);
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

  it("keeps a Note draft outside the canvas card across pinning and repeated opens", () => {
    const node = {
      id: "note-1",
      type: "text" as const,
      x: 0,
      y: 0,
      width: 240,
      height: 160,
      text: "Field notes\n\nOriginal",
    } satisfies CanvasNode;

    openNoteSurface(node);
    const id = noteSurfaceId(node.id);
    dock$.noteById[id].draft.set("Field notes\n\nOperator draft");
    pinWorkbenchSurface(id);
    openNoteSurface({ ...node, text: "Field notes\n\nProjection update" });

    expect(dock$.registry.peek().surfaces).toEqual([
      { id, kind: "note", zone: "pinned" },
    ]);
    expect(dock$.noteById[id].peek()).toMatchObject({
      nodeId: "note-1",
      draft: "Field notes\n\nOperator draft",
      savedText: "Field notes\n\nOriginal",
    });

    closeWorkbenchSurface(id);
    expect(dock$.noteById[id].peek()).toBeUndefined();
  });

  it("durability saves a Note draft without dismissing its focus surface", () => {
    const node = {
      id: "note-save",
      type: "text" as const,
      x: 0,
      y: 0,
      width: 240,
      height: 160,
      text: "Focus-safe note",
    } satisfies CanvasNode;
    state$.doc.set({ nodes: [node], edges: [] });
    openNoteSurface(node);
    const id = noteSurfaceId(node.id);
    dock$.noteById[id].draft.set("Focus-safe note\n\nStill open after canvas flush");

    saveNoteSurfaceDraft(id);

    expect(dock$.registry.peek().surfaces).toEqual([
      { id, kind: "note", zone: "focus" },
    ]);
    expect(state$.doc.peek().nodes[0]).toMatchObject({
      text: "Focus-safe note\n\nStill open after canvas flush",
    });
    expect(dock$.noteById[id].peek()?.savedText).toBe(
      "Focus-safe note\n\nStill open after canvas flush",
    );

    dock$.noteById[id].draft.set("discard me");
    discardAndCloseNoteSurface(id);
    expect(dock$.registry.peek().surfaces).toEqual([]);
    expect(state$.doc.peek().nodes[0]).toMatchObject({
      text: "Focus-safe note\n\nStill open after canvas flush",
    });
  });

  it("opens many browsers without detaching earlier ones (tabs replace eviction)", async () => {
    const mock = installMockVellum();
    const refs = [refOf("n1"), refOf("n2"), refOf("n3")];
    await openDockBrowser(refs[0]!, payloadOf("n1", "https://a.example.com", "A"));
    await openDockBrowser(refs[1]!, payloadOf("n2", "https://b.example.com", "B"));
    await openDockBrowser(refs[2]!, payloadOf("n3", "https://c.example.com", "C"));
    expect(dock$.registry.peek().surfaces.map((s) => s.id)).toEqual(refs);
    expect(mock.browserClose).not.toHaveBeenCalled();
  });

  it("closeDockBrowser removes UI without an identity fallback when no handle exists", () => {
    const mock = installMockVellum();
    const ref = refOf("ghost");
    dock$.browserByRef[ref].set(payloadOf("ghost", "https://ghost.example.com", "Ghost"));
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
    const payload = payloadOf("n1", "https://a.example.com", "A");
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
    await openDockBrowser(ref, payloadOf("stop-page", "https://stop.example.com", "Stop"));

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
    await openDockBrowser(ref, payloadOf("stop-race", "https://stop.example.com", "Stop"));

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
    expect(dock$.opErrorByRef[ref].peek()).toEqual({
      op: "stop",
      message: "Page runtime changed while stopping; retry Stop Page.",
    });
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
    await openDockBrowser(ref, payloadOf("stop-failed", "https://stop.example.com", "Stop"));

    await stopDockBrowser(ref);

    expect(mock.browserStop).toHaveBeenCalledWith("session-1");
    expect(dock$.registry.peek().surfaces).toEqual([
      { id: ref, kind: "browser", zone: "focus" },
    ]);
    expect(browser$.sessionByRef[ref].peek()?.sessionId).toBe("session-1");
    expect(dock$.opErrorByRef[ref].peek()).toEqual({
      op: "stop",
      message: "physical teardown not acknowledged",
    });
  });

  it("treats authoritative session-list absence as already stopped", async () => {
    const mock = installMockVellum({
      browserSessionList: vi.fn(async () => ({ ok: true, data: [] })),
    });
    const ref = refOf("already-stopped");
    dock$.browserByRef[ref].set(payloadOf("already-stopped", "https://stop.example.com", "Stop"));
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
    dock$.browserByRef[ref].set(payloadOf("flag-off", "https://stop.example.com", "Stop"));
    dock$.registry.set(openSurface(dock$.registry.peek(), browserSlot(ref)).state);
    cacheBrowserSession(baseSession(ref, "flag-off", "ghost-handle"));

    await expect(stopDockBrowser(ref)).resolves.toBe(true);

    expect(dock$.registry.peek().surfaces).toEqual([]);
    expect(dock$.browserByRef[ref].peek()).toBeUndefined();
    expect(browser$.sessionByRef[ref].peek()).toBeUndefined();
    expect(dock$.opErrorByRef[ref].peek()).toBeUndefined();
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
    dock$.browserByRef[ref].set(payloadOf("stale-stopped", "https://stop.example.com", "Stop"));
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
    dock$.browserByRef[ref].set(payloadOf("replaced-runtime", "https://stop.example.com", "Stop"));
    dock$.registry.set(openSurface(dock$.registry.peek(), browserSlot(ref)).state);
    cacheBrowserSession(baseSession(ref, "replaced-runtime", "stale-handle"));

    await expect(stopDockBrowser(ref)).resolves.toBe(false);

    expect(mock.browserStop).toHaveBeenCalledTimes(1);
    expect(mock.browserStop).toHaveBeenCalledWith("stale-handle");
    expect(browser$.sessionByRef[ref].peek()?.sessionId).toBe("replacement-handle");
    expect(dock$.registry.peek().surfaces).toEqual([
      { id: ref, kind: "browser", zone: "focus" },
    ]);
    expect(dock$.opErrorByRef[ref].peek()).toEqual({
      op: "stop",
      message: "Page runtime changed while stopping; retry Stop Page.",
    });
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
    const opening = openDockBrowser(
      ref,
      payloadOf("n-stale-open", "https://a.example.com", "A"),
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

  it("reports a failed open on the surface instead of waiting silently", async () => {
    const ref = refOf("open-failed");
    installMockVellum({
      browserOpen: vi.fn(async () => ({
        ok: false,
        code: "resource_exhausted",
        message: "stop pages or automation to free capacity",
      })),
    });

    await openDockBrowser(ref, payloadOf("open-failed", "https://a.example.com", "A"));

    // The slot still exists (the operator can see and close it), and the
    // refusal is visible instead of an endless "waiting for session…".
    expect(dock$.registry.peek().surfaces).toEqual([
      { id: ref, kind: "browser", zone: "focus" },
    ]);
    expect(dock$.opErrorByRef[ref].peek()).toEqual({
      op: "open",
      message: "stop pages or automation to free capacity",
    });
  });

  it("reports a thrown open as an operator-facing failure", async () => {
    const ref = refOf("open-threw");
    installMockVellum({
      browserOpen: vi.fn(async () => {
        throw new Error("Object has been destroyed");
      }),
    });

    await openDockBrowser(ref, payloadOf("open-threw", "https://a.example.com", "A"));

    // The thrown internals stay internal; the outcome is what is reported.
    expect(dock$.opErrorByRef[ref].peek()).toEqual({
      op: "open",
      message: "The page could not be opened.",
    });
  });

  it("refuses a disallowed target before any IPC round trip", async () => {
    const mock = installMockVellum();
    const ref = refOf("open-local");

    await openDockBrowser(ref, payloadOf("open-local", "http://localhost:5173", "Local"));

    expect(mock.browserOpen).not.toHaveBeenCalled();
    expect(dock$.opErrorByRef[ref].peek()?.op).toBe("open");
    expect(dock$.opErrorByRef[ref].peek()?.message).toContain("Local and internal hostnames");
  });

  it("a stale open failure cannot mark a newer runtime failed", async () => {
    const ref = refOf("stale-failure");
    let resolveOpen: ((result: BrowserOpResult<BrowserSessionInfo>) => void) | undefined;
    const pendingOpen = new Promise<BrowserOpResult<BrowserSessionInfo>>((resolve) => {
      resolveOpen = resolve;
    });
    const mock = installMockVellum({ browserOpen: vi.fn(() => pendingOpen) });
    const opening = openDockBrowser(ref, payloadOf("stale-failure", "https://a.example.com", "A"));
    for (let i = 0; i < 20 && !mock.browserOpen.mock.calls.length; i++) {
      await Promise.resolve();
    }
    // A newer open attempt wins while the first is still in flight.
    cacheBrowserSession(baseSession(ref, "stale-failure", "newer-handle", { state: "ready" }));
    resolveOpen?.({ ok: false, code: "failed", message: "navigation cancelled" });
    await opening;
    expect(dock$.opErrorByRef[ref].peek()).toBeUndefined();
    expect(browser$.sessionByRef[ref].peek()?.sessionId).toBe("newer-handle");
  });

  it("a malformed ok open result is a visible failure, not a silent cache skip", async () => {
    const ref = refOf("malformed-open");
    installMockVellum({
      browserOpen: vi.fn(async () => ({
        ok: true,
        data: { ...baseSession(refOf("other"), "other", "other-handle") },
      })),
    });

    await openDockBrowser(ref, payloadOf("malformed-open", "https://a.example.com", "A"));

    expect(browser$.sessionByRef[ref].peek()).toBeUndefined();
    expect(dock$.opErrorByRef[ref].peek()).toEqual({
      op: "open",
      message: "The page session did not open correctly; try again.",
    });
  });

  it("a later open success clears a reported open failure", async () => {
    const ref = refOf("open-retry");
    const mock = installMockVellum({
      browserOpen: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, code: "failed", message: "no" })
        .mockResolvedValueOnce({ ok: true, data: baseSession(ref, "open-retry", "retry-handle") }),
    });
    await openDockBrowser(ref, payloadOf("open-retry", "https://a.example.com", "A"));
    expect(dock$.opErrorByRef[ref].peek()).toEqual({ op: "open", message: "no" });

    await openDockBrowser(ref, payloadOf("open-retry", "https://a.example.com", "A"));
    expect(mock.browserOpen).toHaveBeenCalledTimes(2);
    expect(dock$.opErrorByRef[ref].peek()).toBeUndefined();
    expect(browser$.sessionByRef[ref].peek()?.sessionId).toBe("retry-handle");
  });

  it("cacheBrowserSession never lets a late destroy establish or revive a handle", () => {
    const ref = refOf("destroy-rules");
    // Destroy for an unknown ref: must not create an entry.
    expect(
      cacheBrowserSession(baseSession(ref, "destroy-rules", "gone", { state: "destroyed" })),
    ).toBe(false);
    expect(browser$.sessionByRef[ref].peek()).toBeUndefined();

    // Live handle, then destroy, then a late nonterminal push for the same
    // handle: destroyed is terminal and cannot be revived.
    cacheBrowserSession(baseSession(ref, "destroy-rules", "live", { state: "ready" }));
    cacheBrowserSession(baseSession(ref, "destroy-rules", "live", { state: "destroyed" }));
    expect(browser$.sessionByRef[ref].peek()?.state).toBe("destroyed");
    expect(
      cacheBrowserSession(baseSession(ref, "destroy-rules", "live", { state: "ready" })),
    ).toBe(false);
    expect(browser$.sessionByRef[ref].peek()?.state).toBe("destroyed");
  });

  it("a failed detach reports close failure and parks the native view", async () => {
    const ref = refOf("close-failed");
    const mock = installMockVellum({
      browserClose: vi.fn(async () => ({
        ok: false,
        code: "failed",
        message: "detach refused",
      })),
      browserSetBounds: vi.fn(async () => ({
        ok: true,
        data: baseSession(ref, "close-failed", "warm-handle"),
      })),
    });
    dock$.browserByRef[ref].set(payloadOf("close-failed", "https://a.example.com", "A"));
    dock$.registry.set(openSurface(dock$.registry.peek(), browserSlot(ref)).state);
    cacheBrowserSession(baseSession(ref, "close-failed", "warm-handle", { state: "ready" }));

    closeDockBrowser(ref);
    await Promise.resolve();
    await Promise.resolve();

    expect(dock$.registry.peek().surfaces).toEqual([]);
    expect(browser$.sessionByRef[ref].peek()?.sessionId).toBe("warm-handle");
    expect(dock$.opErrorByRef[ref].peek()).toEqual({ op: "close", message: "detach refused" });
    expect(mock.browserSetBounds).toHaveBeenCalledWith("warm-handle", {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });

  it("a not_found detach clears the stale handle instead of reporting an error", async () => {
    const ref = refOf("close-stale");
    const mock = installMockVellum({
      browserClose: vi.fn(async () => ({
        ok: false,
        code: "not_found",
        message: "no session for warm-handle",
      })),
    });
    dock$.browserByRef[ref].set(payloadOf("close-stale", "https://a.example.com", "A"));
    dock$.registry.set(openSurface(dock$.registry.peek(), browserSlot(ref)).state);
    cacheBrowserSession(baseSession(ref, "close-stale", "warm-handle", { state: "ready" }));

    closeDockBrowser(ref);
    await Promise.resolve();
    await Promise.resolve();

    expect(dock$.registry.peek().surfaces).toEqual([]);
    expect(browser$.sessionByRef[ref].peek()).toBeUndefined();
    expect(dock$.opErrorByRef[ref].peek()).toBeUndefined();
    expect(mock.browserClose).toHaveBeenCalledWith("warm-handle");
  });

  it("degrades quietly when window.vellumCommand is absent", async () => {
    const ref = refOf("n1");
    await expect(openDockBrowser(ref, payloadOf("n1", "https://a.example.com", "A", "p"))).resolves.toBeUndefined();
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

    it("a manual tab activation survives later terminal opens (one-shot promote)", () => {
      openTerminalSurface(nativeTerminalNode("t1"), "focus");
      openTerminalSurface(nativeTerminalNode("t2"), "focus");
      // Operator clicks tab t1 — a path that bypasses lastOpenNodeId.
      dock$.registry.set(
        focusSurface(dock$.registry.peek(), terminalSurfaceId("t1")).state,
      );
      // A later open re-runs the observe; the stale t2 promote must not
      // replay and yank the operator's choice back behind t2.
      openTerminalSurface(nativeTerminalNode("t3"), "focus");
      expect(dock$.registry.peek().focusMru).toEqual([
        terminalSurfaceId("t3"),
        terminalSurfaceId("t1"),
        terminalSurfaceId("t2"),
      ]);
    });
  });

  describe("closeFocusModalSurface — Close dismisses the whole chrome-less modal", () => {
    it("one press closes a stack of cycled mirror terminals, views included", () => {
      // Mirror cycling: three actors opened in sequence, all parked in focus.
      for (const id of ["t1", "t2", "t3"]) {
        openTerminalSurface(nativeTerminalNode(id), "focus");
      }
      expect(dock$.registry.peek().surfaces).toHaveLength(3);
      closeFocusModalSurface(terminalSurfaceId("t3"));
      expect(dock$.registry.peek().surfaces).toEqual([]);
      expect(terminal$.openByNodeId.peek()).toEqual({});
    });

    it("never reaches into the pinned zone", () => {
      openTerminalSurface(nativeTerminalNode("dock"), "pinned");
      openTerminalSurface(nativeTerminalNode("t1"), "focus");
      openTerminalSurface(nativeTerminalNode("t2"), "focus");
      closeFocusModalSurface(terminalSurfaceId("t2"));
      expect(dock$.registry.peek().surfaces).toEqual([
        { id: terminalSurfaceId("dock"), kind: "terminal", zone: "pinned" },
      ]);
    });

    it("closing a pinned surface stays per-surface", () => {
      openTerminalSurface(nativeTerminalNode("dock"), "pinned");
      openTerminalSurface(nativeTerminalNode("t1"), "focus");
      closeFocusModalSurface(terminalSurfaceId("dock"));
      expect(dock$.registry.peek().surfaces).toEqual([
        { id: terminalSurfaceId("t1"), kind: "terminal", zone: "focus" },
      ]);
    });

    it("with tab chrome visible (mixed kinds) close stays per-surface", () => {
      openTerminalSurface(nativeTerminalNode("t1"), "focus");
      openAgentChatSurface({
        id: "agent-1",
        type: "text",
        x: 0,
        y: 0,
        width: 240,
        height: 96,
        text: "PROFILE-01",
        ether: { entity: { kind: "agent", name: "remote-a:profile-01" } },
      });
      closeFocusModalSurface(terminalSurfaceId("t1"));
      expect(dock$.registry.peek().surfaces).toEqual([
        { id: chatSurfaceId("agent-1"), kind: "chat", zone: "focus" },
      ]);
    });
  });
});
