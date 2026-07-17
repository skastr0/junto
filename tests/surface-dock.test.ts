import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserOpResult, BrowserSessionInfo } from "../src/shared/ipc";
import { formatNodeRef, parseNodeRef } from "../src/shared/node-ref";
import {
  closeSurface,
  dockBrowserSurfaces,
  dockInteractiveSurface,
  initialDockState,
  isInteractiveSurface,
  openSurface,
  setMaxVisible,
  type DockState,
} from "../src/renderer/lib/surface-registry";
import {
  HERDR_DOCK_ID,
  closeDockBrowser,
  dock$,
  hydrateDockConfig,
  openDockBrowser,
  reconcileDockFromLiveSessions,
  syncDockHerdrSlot,
} from "../src/renderer/lib/dock-state";
import { browser$, cacheBrowserSession } from "../src/renderer/lib/browser-state";
import { herdr$ } from "../src/renderer/lib/herdr-state";

// --- pure registry ---------------------------------------------------------

const browserSlot = (id: string) => ({ id, kind: "browser" as const });
const herdrSlot = (id: string) => ({ id, kind: "herdr" as const });

describe("surface-registry (pure)", () => {
  it("opens surfaces up to maxVisible without eviction", () => {
    let state: DockState = initialDockState(2);
    let t = openSurface(state, browserSlot("a"));
    expect(t.evicted).toEqual([]);
    t = openSurface(t.state, browserSlot("b"));
    expect(t.evicted).toEqual([]);
    expect(t.state.surfaces.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("evicts the OLDEST surface when the dock is full", () => {
    let t = openSurface(initialDockState(2), browserSlot("a"));
    t = openSurface(t.state, browserSlot("b"));
    t = openSurface(t.state, browserSlot("c"));
    expect(t.evicted.map((s) => s.id)).toEqual(["a"]);
    expect(t.state.surfaces.map((s) => s.id)).toEqual(["b", "c"]);
  });

  it("re-requesting an open surface is a no-op that keeps its slot position", () => {
    let t = openSurface(initialDockState(2), browserSlot("a"));
    t = openSurface(t.state, browserSlot("b"));
    const again = openSurface(t.state, browserSlot("a"));
    expect(again.evicted).toEqual([]);
    expect(again.state.surfaces.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("enforces ONE interactive surface: a second herdr/chat evicts the first", () => {
    let t = openSurface(initialDockState(3), browserSlot("a"));
    t = openSurface(t.state, herdrSlot("term"));
    t = openSurface(t.state, { id: "chat-1", kind: "chat" });
    expect(t.evicted.map((s) => s.id)).toEqual(["term"]);
    expect(dockInteractiveSurface(t.state)?.id).toBe("chat-1");
    expect(dockBrowserSurfaces(t.state).map((s) => s.id)).toEqual(["a"]);
  });

  it("a browser never evicts the interactive surface unless the cap forces it", () => {
    let t = openSurface(initialDockState(2), herdrSlot("term"));
    t = openSurface(t.state, browserSlot("a"));
    expect(t.evicted).toEqual([]);
    expect(t.state.surfaces.map((s) => s.id)).toEqual(["term", "a"]);
    // Cap of 2: a second browser evicts the oldest slot (the terminal).
    t = openSurface(t.state, browserSlot("b"));
    expect(t.evicted.map((s) => s.id)).toEqual(["term"]);
  });

  it("same id changing kind replaces the stale slot (evicted for cleanup)", () => {
    const t0 = openSurface(initialDockState(2), browserSlot("x"));
    const t = openSurface(t0.state, herdrSlot("x"));
    expect(t.evicted).toEqual([browserSlot("x")]);
    expect(t.state.surfaces).toEqual([herdrSlot("x")]);
  });

  it("closeSurface removes the slot; unknown ids are a no-op", () => {
    const t0 = openSurface(initialDockState(2), browserSlot("a"));
    const closed = closeSurface(t0.state, "a");
    expect(closed.state.surfaces).toEqual([]);
    expect(closed.evicted.map((s) => s.id)).toEqual(["a"]);
    const noop = closeSurface(closed.state, "ghost");
    expect(noop.evicted).toEqual([]);
  });

  it("setMaxVisible shrinking below the open count evicts oldest-first", () => {
    let t = openSurface(initialDockState(3), browserSlot("a"));
    t = openSurface(t.state, browserSlot("b"));
    t = openSurface(t.state, browserSlot("c"));
    const shrunk = setMaxVisible(t.state, 1);
    expect(shrunk.evicted.map((s) => s.id)).toEqual(["a", "b"]);
    expect(shrunk.state.surfaces.map((s) => s.id)).toEqual(["c"]);
  });

  it("clamps nonsense maxVisible to the default rather than bricking the dock", () => {
    expect(initialDockState(0).maxVisible).toBe(2);
    expect(initialDockState(Number.NaN).maxVisible).toBe(2);
    expect(setMaxVisible(initialDockState(2), -1).state.maxVisible).toBe(2);
  });

  it("classifies browser as non-interactive; herdr/chat as interactive", () => {
    expect(isInteractiveSurface("browser")).toBe(false);
    expect(isInteractiveSurface("herdr")).toBe(true);
    expect(isInteractiveSurface("chat")).toBe(true);
  });
});

// --- dock-state (observable + side effects) --------------------------------

interface MockVellum {
  browserOpen: ReturnType<typeof vi.fn>;
  browserClose: ReturnType<typeof vi.fn>;
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
    browserSessionList: vi.fn(async () => ({ ok: true, data: [...sessions.values()] })),
    ...overrides,
  };
  (globalThis as unknown as { window: { vellum: MockVellum } }).window = { vellum: mock };
  return mock;
}

function resetDock(): void {
  dock$.registry.set(initialDockState());
  dock$.browserByRef.set({});
  dock$.configHydrated.set(false);
  browser$.sessionByRef.set({});
  herdr$.terminal.set(null);
}

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
    expect(dock$.registry.peek().surfaces).toEqual([{ id: ref, kind: "browser" }]);
    expect(dock$.browserByRef.peek()[ref]).toMatchObject({ url: "https://example.com" });
    expect(mock.browserOpen).toHaveBeenCalledWith({ ref });
    expect(browser$.sessionByRef[ref].peek()).toMatchObject({
      ref,
      sessionId: "session-1",
      state: "loading",
    });
  });

  it("a full dock detaches the evicted browser by its exact returned handle", async () => {
    const mock = installMockVellum();
    const refs = [refOf("n1"), refOf("n2"), refOf("n3")];
    await openDockBrowser(refs[0]!, payloadOf("n1", "https://a.example", "A"));
    await openDockBrowser(refs[1]!, payloadOf("n2", "https://b.example", "B"));
    await openDockBrowser(refs[2]!, payloadOf("n3", "https://c.example", "C"));
    expect(dock$.registry.peek().surfaces.map((s) => s.id)).toEqual(refs.slice(1));
    expect(mock.browserClose).toHaveBeenCalledWith("session-1");
    expect(dock$.browserByRef.peek()[refs[0]!]).toBeUndefined();
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
    await vi.waitFor(() => expect(mock.browserOpen).toHaveBeenCalledWith({ ref }));
    cacheBrowserSession(newSession);
    resolveOpen?.({ ok: true, data: oldSession });
    await opening;
    expect(browser$.sessionByRef[ref].peek()?.sessionId).toBe("new-push");
  });

  it("degrades quietly when window.vellum is absent", async () => {
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
    expect(dock$.registry.peek().surfaces).toEqual([{ id: attachedRef, kind: "browser" }]);
    expect(dock$.browserByRef[attachedRef].peek()?.nodeId).toBe("attached");
    expect(browser$.sessionByRef[attachedRef].peek()?.sessionId).toBe("attached-handle");
    expect(dock$.browserByRef[detachedRef].peek()).toBeUndefined();
  });

  it("hydrateDockConfig adopts maxVisibleSurfaces from the service config (once)", async () => {
    installMockVellum({
      browserSurfaceConfig: vi.fn(async () => ({ ok: true, data: { maxVisibleSurfaces: 3, maxWarmSessions: 3 } })),
    });
    await hydrateDockConfig();
    expect(dock$.registry.peek().maxVisible).toBe(3);
    await hydrateDockConfig(); // second call is a no-op
    expect((window as unknown as { vellum: MockVellum }).vellum.browserSurfaceConfig).toHaveBeenCalledTimes(1);
  });

  describe("herdr slot sync — single control stream invariant", () => {
    const openTerminal = () =>
      herdr$.terminal.set({ nodeId: "h1", herdr: { host: "local" } as never, title: "term" });

    it("docks the terminal only while a browser surface is open", async () => {
      installMockVellum();
      openTerminal();
      syncDockHerdrSlot();
      // No browser open — terminal stays in the full-window modal, not the dock.
      expect(dock$.registry.peek().surfaces).toEqual([]);

      const ref = refOf("n1");
      await openDockBrowser(ref, payloadOf("n1", "https://a.example", "A", "p"));
      syncDockHerdrSlot();
      expect(dock$.registry.peek().surfaces).toEqual([
        { id: ref, kind: "browser" },
        { id: HERDR_DOCK_ID, kind: "herdr" },
      ]);
      // herdr$.terminal remains the single source — exactly one terminal open.
      expect(herdr$.terminal.peek()?.nodeId).toBe("h1");
    });

    it("removes the dock slot when the terminal closes, without touching the stream", async () => {
      installMockVellum();
      const ref = refOf("n1");
      await openDockBrowser(ref, payloadOf("n1", "https://a.example", "A", "p"));
      openTerminal();
      syncDockHerdrSlot();
      expect(dock$.registry.peek().surfaces.some((s) => s.kind === "herdr")).toBe(true);

      herdr$.terminal.set(null); // closeHerdrTerminal already released the stream
      syncDockHerdrSlot();
      expect(dock$.registry.peek().surfaces.some((s) => s.kind === "herdr")).toBe(false);
      expect(dock$.registry.peek().surfaces.map((s) => s.id)).toEqual([ref]);
    });

    it("returns the terminal to the modal when the last browser closes", async () => {
      installMockVellum();
      const ref = refOf("n1");
      await openDockBrowser(ref, payloadOf("n1", "https://a.example", "A", "p"));
      openTerminal();
      syncDockHerdrSlot();
      closeDockBrowser(ref);
      syncDockHerdrSlot();
      // Slot gone (modal takes over) but the terminal itself is still open.
      expect(dock$.registry.peek().surfaces).toEqual([]);
      expect(herdr$.terminal.peek()?.nodeId).toBe("h1");
    });

    it("docking the terminal never spawns a second herdr slot on re-sync", async () => {
      installMockVellum();
      await openDockBrowser(refOf("n1"), payloadOf("n1", "https://a.example", "A", "p"));
      openTerminal();
      syncDockHerdrSlot();
      syncDockHerdrSlot();
      const herdrSlots = dock$.registry.peek().surfaces.filter((s) => s.kind === "herdr");
      expect(herdrSlots).toHaveLength(1);
    });

    it("a browser landing in a full dock evicts the OLDEST slot (browser detached); the terminal keeps its single stream", async () => {
      const mock = installMockVellum();
      dock$.registry.set(initialDockState(2));
      const firstRef = refOf("n1");
      const secondRef = refOf("n2");
      await openDockBrowser(firstRef, payloadOf("n1", "https://a.example", "A", "p"));
      openTerminal();
      syncDockHerdrSlot();
      // Dock is full at 2 (n1 + terminal); a second browser evicts oldest (n1).
      await openDockBrowser(secondRef, payloadOf("n2", "https://b.example", "B", "p"));
      expect(dock$.registry.peek().surfaces).toEqual([
        { id: HERDR_DOCK_ID, kind: "herdr" },
        { id: secondRef, kind: "browser" },
      ]);
      expect(mock.browserClose).toHaveBeenCalledWith("session-1");
      // Terminal untouched — still exactly one control stream.
      expect(herdr$.terminal.peek()?.nodeId).toBe("h1");
    });
  });
});
