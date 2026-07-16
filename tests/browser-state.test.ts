import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserOpResult, BrowserSessionInfo } from "../src/shared/ipc";
import {
  browser$,
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
  afterEach(clearWindow);

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

// Surface open/close moved to the work-surface dock — see tests/surface-dock.test.ts.

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
