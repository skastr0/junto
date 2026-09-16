import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserOpResult, BrowserSessionInfo } from "../src/shared/ipc";
import { formatNodeRef } from "../src/shared/node-ref";
import {
  browser$,
  refreshBrowserSession,
  subscribeBrowserSessionEvents,
} from "../src/renderer/lib/browser-state";

const sessionOf = (ref: string) => browser$.sessionByRef[ref].peek();

// --- window.vellumCommand mocked exactly like tests/chat-state.test.ts; one unique
// nodeId per test so browser$.sessionByRef never bleeds between cases. ---

interface MockJunto {
  browserSessionList: ReturnType<typeof vi.fn>;
  onBrowserSessionChanged: ReturnType<typeof vi.fn>;
}

let idCounter = 0;
const freshNodeId = (): string => `node-${++idCounter}`;
const refOf = (nodeId: string, canvasName = "portfolio"): string =>
  formatNodeRef({ canvasName, nodeId });

const baseSession = (
  ref: string,
  nodeId: string,
  overrides: Partial<BrowserSessionInfo> = {},
): BrowserSessionInfo => ({
  ref,
  sessionId: `session-${nodeId}`,
  nodeId,
  url: "https://example.com",
  hostId: "local",
  profile: "personal",
  state: "ready",
  attached: false,
  ...overrides,
});

function installMockJunto(overrides: Partial<MockJunto> = {}): MockJunto {
  const mock: MockJunto = {
    browserSessionList: vi.fn(async (): Promise<BrowserOpResult<ReadonlyArray<BrowserSessionInfo>>> => ({ ok: true, data: [] })),
    onBrowserSessionChanged: vi.fn(() => () => undefined),
    ...overrides,
  };
  (globalThis as unknown as { window: { vellumCommand: MockJunto } }).window = { vellumCommand: mock };
  return mock;
}

function clearWindow(): void {
  delete (globalThis as { window?: unknown }).window;
  browser$.sessionByRef.set({});
}

describe("subscribeBrowserSessionEvents", () => {
  afterEach(clearWindow);

  it("degrades to a no-op unsubscribe when onBrowserSessionChanged is absent", () => {
    clearWindow();
    const unsubscribe = subscribeBrowserSessionEvents();
    expect(() => unsubscribe()).not.toThrow();
  });

  it("routes a pushed session into sessionByRef, keyed only by canonical ref", () => {
    const nodeId = freshNodeId();
    const ref = refOf(nodeId);
    let handler: ((session: BrowserSessionInfo) => void) | undefined;
    installMockJunto({
      onBrowserSessionChanged: vi.fn((listener: (session: BrowserSessionInfo) => void) => {
        handler = listener;
        return () => undefined;
      }),
    });
    const unsubscribe = subscribeBrowserSessionEvents();
    expect(handler).toBeTypeOf("function");
    handler?.(baseSession(ref, nodeId, { state: "ready", title: "Example" }));
    expect(sessionOf(ref)).toMatchObject({ state: "ready", title: "Example" });
    expect(sessionOf(nodeId)).toBeUndefined();
    unsubscribe();
  });

  it("is a singleton — a second call reuses the first subscription", () => {
    const mock = installMockJunto();
    const first = subscribeBrowserSessionEvents();
    const second = subscribeBrowserSessionEvents();
    expect(second).toBe(first);
    expect(mock.onBrowserSessionChanged).toHaveBeenCalledTimes(1);
    first();
  });

  it("ignores pushed sessions with malformed refs or empty handles", () => {
    const nodeId = freshNodeId();
    const ref = refOf(nodeId);
    let handler: ((session: BrowserSessionInfo) => void) | undefined;
    installMockJunto({
      onBrowserSessionChanged: vi.fn((listener: (session: BrowserSessionInfo) => void) => {
        handler = listener;
        return () => undefined;
      }),
    });
    const unsubscribe = subscribeBrowserSessionEvents();
    expect(() => handler?.({ ...baseSession("", nodeId) } as BrowserSessionInfo)).not.toThrow();
    expect(() => handler?.(baseSession(ref, nodeId, { sessionId: "" }))).not.toThrow();
    expect(sessionOf(ref)).toBeUndefined();
    unsubscribe();
  });

  it("retires an older pushed handle when the same ref advances", () => {
    const nodeId = freshNodeId();
    const ref = refOf(nodeId);
    let handler: ((session: BrowserSessionInfo) => void) | undefined;
    installMockJunto({
      onBrowserSessionChanged: vi.fn((listener: (session: BrowserSessionInfo) => void) => {
        handler = listener;
        return () => undefined;
      }),
    });
    const unsubscribe = subscribeBrowserSessionEvents();
    handler?.(baseSession(ref, nodeId, { sessionId: "old-handle" }));
    handler?.(baseSession(ref, nodeId, { sessionId: "new-handle" }));
    handler?.(baseSession(ref, nodeId, { sessionId: "old-handle", state: "failed" }));
    expect(sessionOf(ref)?.sessionId).toBe("new-handle");
    unsubscribe();
  });
});

// Surface open/close moved to the work-surface dock — see tests/surface-dock.test.ts.

describe("refreshBrowserSession", () => {
  afterEach(clearWindow);

  it("hydrates by exact ref from browserSessionList, not by matching nodeId", async () => {
    const nodeId = freshNodeId();
    const wantedRef = refOf(nodeId, "portfolio");
    const otherRef = refOf(nodeId, "archive");
    installMockJunto({
      browserSessionList: vi.fn(async () => ({
        ok: true,
        data: [
          baseSession(otherRef, nodeId, { sessionId: "wrong-canvas" }),
          baseSession(wantedRef, nodeId, { sessionId: "right-handle", state: "failed", lastError: "boom" }),
        ],
      })),
    });
    await refreshBrowserSession(wantedRef);
    expect(sessionOf(wantedRef)).toMatchObject({
      sessionId: "right-handle",
      state: "failed",
      lastError: "boom",
    });
    expect(sessionOf(otherRef)).toBeUndefined();
  });

  it("removes a stale cached handle when the authoritative list has no exact ref", async () => {
    const nodeId = freshNodeId();
    const ref = refOf(nodeId);
    browser$.sessionByRef[ref].set(baseSession(ref, nodeId, { sessionId: "stale" }));
    installMockJunto();
    await refreshBrowserSession(ref);
    expect(sessionOf(ref)).toBeUndefined();
  });

  it("does not let stale hydration overwrite a newer pushed generation", async () => {
    const nodeId = freshNodeId();
    const ref = refOf(nodeId);
    const oldSession = baseSession(ref, nodeId, { sessionId: "old-hydration" });
    const newSession = baseSession(ref, nodeId, { sessionId: "new-push", state: "ready" });
    let handler: ((session: BrowserSessionInfo) => void) | undefined;
    let resolveList: ((result: BrowserOpResult<ReadonlyArray<BrowserSessionInfo>>) => void) | undefined;
    const pendingList = new Promise<BrowserOpResult<ReadonlyArray<BrowserSessionInfo>>>((resolve) => {
      resolveList = resolve;
    });
    installMockJunto({
      browserSessionList: vi.fn(() => pendingList),
      onBrowserSessionChanged: vi.fn((listener: (session: BrowserSessionInfo) => void) => {
        handler = listener;
        return () => undefined;
      }),
    });
    const unsubscribe = subscribeBrowserSessionEvents();
    handler?.(oldSession);
    const hydration = refreshBrowserSession(ref);
    handler?.(newSession);
    handler?.({ ...oldSession, state: "failed", lastError: "late old push" });
    resolveList?.({ ok: true, data: [oldSession] });
    await hydration;
    expect(sessionOf(ref)).toMatchObject({ sessionId: "new-push", state: "ready" });
    unsubscribe();
  });

  it("degrades quietly when window.vellumCommand is absent", async () => {
    clearWindow();
    await expect(refreshBrowserSession(refOf(freshNodeId()))).resolves.toBeUndefined();
  });
});
