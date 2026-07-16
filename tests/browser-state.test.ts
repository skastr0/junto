import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserOpResult, BrowserSessionInfo } from "../src/shared/ipc";
import {
  browser$,
  closeBrowserSurface,
  openBrowserSurface,
  refreshBrowserSession,
  subscribeBrowserSessionEvents,
} from "../src/renderer/lib/browser-state";

const sessionOf = (nodeId: string) => browser$.sessionByNodeId[nodeId].peek();

// --- window.vellum mocked exactly like tests/chat-state.test.ts; one unique
// nodeId per test so browser$.sessionByNodeId never bleeds between cases. ---

interface MockVellum {
  browserOpen: ReturnType<typeof vi.fn>;
  browserClose: ReturnType<typeof vi.fn>;
  browserSessionState: ReturnType<typeof vi.fn>;
  onBrowserSessionChanged: ReturnType<typeof vi.fn>;
}

let idCounter = 0;
const freshNodeId = (): string => `node-${++idCounter}`;

const baseSession = (nodeId: string, overrides: Partial<BrowserSessionInfo> = {}): BrowserSessionInfo => ({
  nodeId,
  url: "https://example.com",
  profile: "personal",
  state: "ready",
  attached: false,
  ...overrides,
});

function installMockVellum(overrides: Partial<MockVellum> = {}): MockVellum {
  const mock: MockVellum = {
    browserOpen: vi.fn(async (input: { nodeId: string }): Promise<BrowserOpResult<BrowserSessionInfo>> => ({
      ok: true,
      data: baseSession(input.nodeId, { state: "loading" }),
    })),
    browserClose: vi.fn(async (nodeId: string): Promise<BrowserOpResult<BrowserSessionInfo>> => ({
      ok: true,
      data: baseSession(nodeId, { state: "detached" }),
    })),
    browserSessionState: vi.fn(async (): Promise<BrowserOpResult<BrowserSessionInfo | null>> => ({ ok: true, data: null })),
    onBrowserSessionChanged: vi.fn(() => () => undefined),
    ...overrides,
  };
  (globalThis as unknown as { window: { vellum: MockVellum } }).window = { vellum: mock };
  return mock;
}

function clearWindow(): void {
  delete (globalThis as { window?: unknown }).window;
}

describe("subscribeBrowserSessionEvents", () => {
  afterEach(() => {
    clearWindow();
    browser$.surface.set(null);
  });

  it("degrades to a no-op unsubscribe when onBrowserSessionChanged is absent", () => {
    clearWindow();
    const unsubscribe = subscribeBrowserSessionEvents();
    expect(() => unsubscribe()).not.toThrow();
  });

  it("routes a pushed BrowserSessionInfo into sessionByNodeId, keyed by nodeId", () => {
    const nodeId = freshNodeId();
    let handler: ((session: BrowserSessionInfo) => void) | undefined;
    installMockVellum({
      onBrowserSessionChanged: vi.fn((listener: (session: BrowserSessionInfo) => void) => {
        handler = listener;
        return () => undefined;
      }),
    });
    const unsubscribe = subscribeBrowserSessionEvents();
    expect(handler).toBeTypeOf("function");
    handler?.(baseSession(nodeId, { state: "ready", title: "Example" }));
    expect(sessionOf(nodeId)).toMatchObject({ state: "ready", title: "Example" });
    unsubscribe();
  });

  it("is a singleton — a second call reuses the first subscription", () => {
    const mock = installMockVellum();
    const first = subscribeBrowserSessionEvents();
    const second = subscribeBrowserSessionEvents();
    expect(second).toBe(first);
    expect(mock.onBrowserSessionChanged).toHaveBeenCalledTimes(1);
    first();
  });

  it("ignores a pushed session with no nodeId rather than throwing", () => {
    let handler: ((session: BrowserSessionInfo) => void) | undefined;
    installMockVellum({
      onBrowserSessionChanged: vi.fn((listener: (session: BrowserSessionInfo) => void) => {
        handler = listener;
        return () => undefined;
      }),
    });
    const unsubscribe = subscribeBrowserSessionEvents();
    expect(() => handler?.({ ...baseSession("") } as BrowserSessionInfo)).not.toThrow();
    unsubscribe();
  });
});

describe("openBrowserSurface / closeBrowserSurface", () => {
  afterEach(() => {
    clearWindow();
    browser$.surface.set(null);
  });

  it("sets the surface immediately, then adopts the resolved session into the cache", async () => {
    const nodeId = freshNodeId();
    const mock = installMockVellum();
    const promise = openBrowserSurface(nodeId, { profile: "personal" }, "https://example.com", "Example");
    expect(browser$.surface.peek()).toMatchObject({ nodeId, url: "https://example.com", title: "Example" });
    await promise;
    expect(mock.browserOpen).toHaveBeenCalledWith({ nodeId, url: "https://example.com", profile: "personal" });
    expect(sessionOf(nodeId)).toMatchObject({ state: "loading" });
  });

  it("degrades quietly when window.vellum is absent — surface still opens, no throw", async () => {
    clearWindow();
    const nodeId = freshNodeId();
    await expect(
      openBrowserSurface(nodeId, { profile: "work" }, "https://example.com", "Example"),
    ).resolves.toBeUndefined();
    expect(browser$.surface.peek()).toMatchObject({ nodeId });
  });

  it("degrades quietly when browserOpen rejects", async () => {
    const nodeId = freshNodeId();
    installMockVellum({ browserOpen: vi.fn(async () => { throw new Error("ipc down"); }) });
    await expect(
      openBrowserSurface(nodeId, { profile: "personal" }, "https://example.com", "Example"),
    ).resolves.toBeUndefined();
  });

  it("clears the surface immediately (UI first) and requests detach for the closed nodeId", () => {
    const nodeId = freshNodeId();
    const mock = installMockVellum();
    browser$.surface.set({ nodeId, browser: { profile: "personal" }, url: "https://example.com", title: "Example" });

    closeBrowserSurface();

    expect(browser$.surface.peek()).toBeNull();
    expect(mock.browserClose).toHaveBeenCalledWith(nodeId);
  });

  it("closeBrowserSurface with no open surface is a no-op — never throws", () => {
    expect(() => closeBrowserSurface()).not.toThrow();
  });

  it("an explicit nodeId always requests detach for THAT node, even when a different surface is portaled", () => {
    const openNodeId = freshNodeId();
    const otherNodeId = freshNodeId();
    const mock = installMockVellum();
    browser$.surface.set({ nodeId: openNodeId, browser: { profile: "personal" }, url: "https://example.com", title: "Example" });

    closeBrowserSurface(otherNodeId);

    expect(mock.browserClose).toHaveBeenCalledWith(otherNodeId);
    // Portal state is untouched — it wasn't the surface being closed.
    expect(browser$.surface.peek()).toMatchObject({ nodeId: openNodeId });
  });

  it("an explicit nodeId still requests detach when no surface is portaled at all", () => {
    const nodeId = freshNodeId();
    const mock = installMockVellum();

    closeBrowserSurface(nodeId);

    expect(mock.browserClose).toHaveBeenCalledWith(nodeId);
    expect(browser$.surface.peek()).toBeNull();
  });
});

describe("refreshBrowserSession", () => {
  afterEach(clearWindow);

  it("hydrates sessionByNodeId from browserSessionState when a session exists", async () => {
    const nodeId = freshNodeId();
    installMockVellum({
      browserSessionState: vi.fn(async () => ({ ok: true, data: baseSession(nodeId, { state: "failed", lastError: "boom" }) })),
    });
    await refreshBrowserSession(nodeId);
    expect(sessionOf(nodeId)).toMatchObject({ state: "failed", lastError: "boom" });
  });

  it("degrades quietly when window.vellum is absent", async () => {
    clearWindow();
    await expect(refreshBrowserSession(freshNodeId())).resolves.toBeUndefined();
  });
});
