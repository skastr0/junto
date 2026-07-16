import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserOpResult, BrowserSessionInfo } from "../src/shared/ipc";
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
  syncDockHerdrSlot,
} from "../src/renderer/lib/dock-state";
import { browser$ } from "../src/renderer/lib/browser-state";
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
}

const baseSession = (nodeId: string, overrides: Partial<BrowserSessionInfo> = {}): BrowserSessionInfo => ({
  nodeId,
  url: "https://example.com",
  profile: "personal",
  state: "loading",
  attached: false,
  ...overrides,
});

function installMockVellum(overrides: Partial<MockVellum> = {}): MockVellum {
  const mock: MockVellum = {
    browserOpen: vi.fn(async (input: { nodeId: string }): Promise<BrowserOpResult<BrowserSessionInfo>> => ({
      ok: true,
      data: baseSession(input.nodeId),
    })),
    browserClose: vi.fn(async (nodeId: string): Promise<BrowserOpResult<BrowserSessionInfo>> => ({
      ok: true,
      data: baseSession(nodeId, { state: "detached" }),
    })),
    ...overrides,
  };
  (globalThis as unknown as { window: { vellum: MockVellum } }).window = { vellum: mock };
  return mock;
}

function resetDock(): void {
  dock$.registry.set(initialDockState());
  dock$.browserByNodeId.set({});
  dock$.configHydrated.set(false);
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
    await openDockBrowser("n1", { profile: "personal" }, "https://example.com", "Example");
    expect(dock$.registry.peek().surfaces).toEqual([{ id: "n1", kind: "browser" }]);
    expect(dock$.browserByNodeId.peek()["n1"]).toMatchObject({ url: "https://example.com" });
    expect(mock.browserOpen).toHaveBeenCalledWith({ nodeId: "n1", url: "https://example.com", profile: "personal" });
    expect(browser$.sessionByNodeId["n1"].peek()).toMatchObject({ state: "loading" });
  });

  it("a full dock detaches the evicted browser over IPC — session stays warm, never destroyed", async () => {
    const mock = installMockVellum();
    await openDockBrowser("n1", { profile: "personal" }, "https://a.example", "A");
    await openDockBrowser("n2", { profile: "personal" }, "https://b.example", "B");
    await openDockBrowser("n3", { profile: "personal" }, "https://c.example", "C");
    expect(dock$.registry.peek().surfaces.map((s) => s.id)).toEqual(["n2", "n3"]);
    // Detach-only: browserClose, which the session service maps to detach.
    expect(mock.browserClose).toHaveBeenCalledWith("n1");
    expect(dock$.browserByNodeId.peek()["n1"]).toBeUndefined();
  });

  it("closeDockBrowser always issues the IPC detach, docked or not", () => {
    const mock = installMockVellum();
    closeDockBrowser("ghost");
    expect(mock.browserClose).toHaveBeenCalledWith("ghost");
  });

  it("degrades quietly when window.vellum is absent", async () => {
    await expect(openDockBrowser("n1", { profile: "p" }, "https://a.example", "A")).resolves.toBeUndefined();
    expect(() => closeDockBrowser("n1")).not.toThrow();
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

      await openDockBrowser("n1", { profile: "p" }, "https://a.example", "A");
      syncDockHerdrSlot();
      expect(dock$.registry.peek().surfaces).toEqual([
        { id: "n1", kind: "browser" },
        { id: HERDR_DOCK_ID, kind: "herdr" },
      ]);
      // herdr$.terminal remains the single source — exactly one terminal open.
      expect(herdr$.terminal.peek()?.nodeId).toBe("h1");
    });

    it("removes the dock slot when the terminal closes, without touching the stream", async () => {
      installMockVellum();
      await openDockBrowser("n1", { profile: "p" }, "https://a.example", "A");
      openTerminal();
      syncDockHerdrSlot();
      expect(dock$.registry.peek().surfaces.some((s) => s.kind === "herdr")).toBe(true);

      herdr$.terminal.set(null); // closeHerdrTerminal already released the stream
      syncDockHerdrSlot();
      expect(dock$.registry.peek().surfaces.some((s) => s.kind === "herdr")).toBe(false);
      expect(dock$.registry.peek().surfaces.map((s) => s.id)).toEqual(["n1"]);
    });

    it("returns the terminal to the modal when the last browser closes", async () => {
      installMockVellum();
      await openDockBrowser("n1", { profile: "p" }, "https://a.example", "A");
      openTerminal();
      syncDockHerdrSlot();
      closeDockBrowser("n1");
      syncDockHerdrSlot();
      // Slot gone (modal takes over) but the terminal itself is still open.
      expect(dock$.registry.peek().surfaces).toEqual([]);
      expect(herdr$.terminal.peek()?.nodeId).toBe("h1");
    });

    it("docking the terminal never spawns a second herdr slot on re-sync", async () => {
      installMockVellum();
      await openDockBrowser("n1", { profile: "p" }, "https://a.example", "A");
      openTerminal();
      syncDockHerdrSlot();
      syncDockHerdrSlot();
      const herdrSlots = dock$.registry.peek().surfaces.filter((s) => s.kind === "herdr");
      expect(herdrSlots).toHaveLength(1);
    });

    it("a browser landing in a full dock evicts the OLDEST slot (browser detached); the terminal keeps its single stream", async () => {
      const mock = installMockVellum();
      dock$.registry.set(initialDockState(2));
      await openDockBrowser("n1", { profile: "p" }, "https://a.example", "A");
      openTerminal();
      syncDockHerdrSlot();
      // Dock is full at 2 (n1 + terminal); a second browser evicts oldest (n1).
      await openDockBrowser("n2", { profile: "p" }, "https://b.example", "B");
      expect(dock$.registry.peek().surfaces).toEqual([
        { id: HERDR_DOCK_ID, kind: "herdr" },
        { id: "n2", kind: "browser" },
      ]);
      expect(mock.browserClose).toHaveBeenCalledWith("n1");
      // Terminal untouched — still exactly one control stream.
      expect(herdr$.terminal.peek()?.nodeId).toBe("h1");
    });
  });
});
