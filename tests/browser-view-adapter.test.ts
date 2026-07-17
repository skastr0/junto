import { createContext, runInContext, type Context } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_MAX_EVAL_CODE_BYTES,
  BROWSER_MAX_EVAL_RESULT_BYTES,
  BROWSER_MAX_EVAL_RESULT_DEPTH,
  BROWSER_MAX_EVAL_RESULT_NODES,
  utf8ByteLength,
} from "../src/shared/browser-limits";

const electron = vi.hoisted(() => {
  type Listener = (...args: ReadonlyArray<unknown>) => void;

  class FakeSession {
    readonly listeners = new Map<string, Listener[]>();
    readonly webRequest = { onBeforeRequest: vi.fn() };
    readonly setPermissionCheckHandler = vi.fn();
    readonly setPermissionRequestHandler = vi.fn();
    readonly setDevicePermissionHandler = vi.fn();
    readonly setDisplayMediaRequestHandler = vi.fn();
    resolveHost(): Promise<{ endpoints: ReadonlyArray<{ address: string }> }> {
      return Promise.resolve({ endpoints: [{ address: "93.184.216.34" }] });
    }
    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }
    off(event: string, listener: Listener): this {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
      );
      return this;
    }
  }

  class FakeWebContents {
    readonly listeners = new Map<string, Listener[]>();
    currentUrl = "";
    title = "";
    loadError: (Error & { readonly code?: number }) | undefined;
    readonly isolatedCalls: Array<{
      readonly worldId: number;
      readonly scripts: ReadonlyArray<{ readonly code: string }>;
      readonly userGesture: boolean | undefined;
    }> = [];
    mainWorldEvalCalls = 0;

    constructor(readonly session: FakeSession) {}

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    once(event: string, listener: Listener): this {
      return this.on(event, listener);
    }

    off(event: string, listener: Listener): this {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
      );
      return this;
    }

    emit(event: string, ...args: ReadonlyArray<unknown>): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }

    loadURL(_url: string): Promise<void> {
      return this.loadError === undefined
        ? Promise.resolve()
        : Promise.reject(this.loadError);
    }

    getURL(): string {
      return this.currentUrl;
    }

    getTitle(): string {
      return this.title;
    }

    setWindowOpenHandler(): void {}
    setWebRTCIPHandlingPolicy(): void {}

    close(): void {}
    executeJavaScript(): Promise<unknown> {
      this.mainWorldEvalCalls += 1;
      return Promise.resolve(null);
    }
    executeJavaScriptInIsolatedWorld(
      worldId: number,
      scripts: ReadonlyArray<{ readonly code: string }>,
      userGesture?: boolean,
    ): Promise<unknown> {
      this.isolatedCalls.push({ worldId, scripts, userGesture });
      return Promise.resolve({ __vellumEval: 1, status: "ok", json: "null" });
    }
    capturePage(): Promise<{ toPNG(): Uint8Array }> {
      return Promise.resolve({ toPNG: () => new Uint8Array([1]) });
    }
  }

  class FakeWebContentsView {
    readonly webContents: FakeWebContents;
    constructor(session: FakeSession) {
      this.webContents = new FakeWebContents(session);
    }
    setBounds(): void {}
  }

  return {
    views: [] as FakeWebContentsView[],
    options: [] as unknown[],
    sessions: new Map<string, FakeSession>(),
    FakeSession,
    FakeWebContentsView,
  };
});

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  session: {
    fromPartition: (partition: string) => {
      const existing = electron.sessions.get(partition);
      if (existing !== undefined) return existing;
      const created = new electron.FakeSession();
      electron.sessions.set(partition, created);
      return created;
    },
  },
  WebContentsView: class extends electron.FakeWebContentsView {
    constructor(options: { readonly webPreferences?: { readonly session?: unknown } }) {
      super(options.webPreferences?.session as never);
      electron.views.push(this);
      electron.options.push(options);
    }
  },
}));

import {
  BROWSER_AUTOMATION_WORLD_ID,
  buildBoundedEvalScript,
  electronViewAdapter,
} from "../src/main/vellum/browser/view-adapter";
import type { BrowserViewEvents } from "../src/main/vellum/browser/sessions";

const navigation = (
  url: string,
  overrides: Partial<{ isSameDocument: boolean; isMainFrame: boolean }> = {},
) => ({
  url,
  isSameDocument: false,
  isMainFrame: true,
  frame: null,
  ...overrides,
});

const runBoundedEval = async (context: Context, source: string): Promise<unknown> =>
  Promise.resolve(runInContext(buildBoundedEvalScript(source), context));

describe("electron browser view generation seam", () => {
  beforeEach(() => {
    electron.views.length = 0;
    electron.options.length = 0;
    electron.sessions.clear();
  });

  const setup = (exactTopLevelOrigin?: string) => {
    const starts: Array<Parameters<BrowserViewEvents["onNavigationStart"]>[0]> = [];
    const urls: Array<readonly [string, string]> = [];
    const completed: Array<readonly [string, string | undefined]> = [];
    const failed: Array<readonly [string, string]> = [];
    const ambiguous: string[] = [];
    let pageGeneration = 1;
    const handle = electronViewAdapter(
      "persist:test",
      {
        onNavigationStart: (event) => {
          starts.push(event);
          return event.expectedSessionId ?? `page-${pageGeneration++}`;
        },
        onNavigationAmbiguous: (sessionId) => ambiguous.push(sessionId),
        onNavigationUrl: (sessionId, url) => urls.push([sessionId, url]),
        onLoadOk: (sessionId, title) => completed.push([sessionId, title]),
        onLoadFail: (sessionId, message) => failed.push([sessionId, message]),
      },
      exactTopLevelOrigin === undefined ? undefined : { exactTopLevelOrigin },
    );
    const webContents = electron.views[0]?.webContents;
    if (webContents === undefined) throw new Error("view was not created");
    return { handle, webContents, starts, urls, completed, failed, ambiguous };
  };

  it("normalizes a programmatic URL before matching its expected generation", () => {
    const { handle, webContents, starts, completed } = setup();
    handle.loadUrl("https://example.com", "session-1");
    webContents.emit("did-start-navigation", navigation("https://example.com/"));
    webContents.currentUrl = "https://example.com/";
    webContents.emit("did-navigate", {}, "https://example.com/", 200, "OK");
    webContents.emit("did-finish-load");
    expect(starts).toEqual([
      {
        url: "https://example.com/",
        isSameDocument: false,
        expectedSessionId: "session-1",
      },
    ]);
    expect(completed).toEqual([["session-1", undefined]]);
  });

  it("keeps redirects on the same generation and completes at the final URL", () => {
    const { handle, webContents, starts, urls, completed } = setup();
    handle.loadUrl("https://example.com/start", "session-1");
    webContents.emit("did-start-navigation", navigation("https://example.com/start"));
    webContents.emit(
      "did-redirect-navigation",
      navigation("https://example.com/final"),
    );
    webContents.currentUrl = "https://example.com/final";
    webContents.emit("did-navigate", {}, "https://example.com/final", 200, "OK");
    webContents.emit("did-finish-load");
    expect(starts).toHaveLength(1);
    expect(urls).toContainEqual(["session-1", "https://example.com/final"]);
    expect(completed).toEqual([["session-1", undefined]]);
  });

  it("terminates an active generation when policy blocks its redirect", () => {
    const { handle, webContents, failed } = setup();
    handle.loadUrl("https://example.com/start", "session-1");
    webContents.emit("did-start-navigation", navigation("https://example.com/start"));
    const redirect = {
      ...navigation("http://127.0.0.1/private"),
      preventDefault: vi.fn(),
    };
    webContents.emit("will-redirect", redirect);

    expect(redirect.preventDefault).toHaveBeenCalledOnce();
    expect(failed).toEqual([
      ["session-1", "navigation blocked by browser policy (non_public_ip)"],
    ]);
  });

  it("pins automation views to an exact origin and retargets only deliberately", () => {
    const { handle, webContents, failed } = setup("https://example.com");
    handle.loadUrl("https://example.com/start", "session-1");
    webContents.emit("did-start-navigation", navigation("https://example.com/start"));

    const sameOrigin = {
      ...navigation("https://example.com/next"),
      preventDefault: vi.fn(),
    };
    webContents.emit("will-redirect", sameOrigin);
    expect(sameOrigin.preventDefault).not.toHaveBeenCalled();

    const crossOrigin = {
      ...navigation("https://public.example.net/escape"),
      preventDefault: vi.fn(),
    };
    webContents.emit("will-redirect", crossOrigin);
    expect(crossOrigin.preventDefault).toHaveBeenCalledOnce();
    expect(failed).toEqual([
      ["session-1", "navigation blocked by browser policy (origin_mismatch)"],
    ]);

    handle.setTopLevelOriginGuard?.("https://next.example.com");
    const deliberate = {
      ...navigation("https://next.example.com/path"),
      preventDefault: vi.fn(),
    };
    webContents.emit("will-frame-navigate", deliberate);
    expect(deliberate.preventDefault).not.toHaveBeenCalled();

    const staleOrigin = {
      ...navigation("https://example.com/again"),
      preventDefault: vi.fn(),
    };
    webContents.emit("will-frame-navigate", staleOrigin);
    expect(staleOrigin.preventDefault).toHaveBeenCalledOnce();
  });

  it("fails closed when main-frame navigations overlap without a correlation id", () => {
    const { webContents, completed, failed, ambiguous } = setup();
    webContents.emit("did-start-navigation", navigation("https://first.example.com/"));
    webContents.emit("did-start-navigation", navigation("https://second.example.com/"));
    webContents.emit(
      "did-fail-load",
      {},
      -2,
      "failed",
      "https://first.example.com/",
      true,
      1,
      1,
    );
    webContents.currentUrl = "https://second.example.com/";
    webContents.emit("did-navigate", {}, "https://second.example.com/", 200, "OK");
    webContents.emit("did-finish-load");
    expect(ambiguous).toEqual(["page-2"]);
    expect(failed).toEqual([]);
    expect(completed).toEqual([]);
  });

  it("reports same-document URL changes under the current generation", () => {
    const { handle, webContents, urls } = setup();
    handle.loadUrl("https://example.com/", "session-1");
    webContents.emit("did-start-navigation", navigation("https://example.com/"));
    webContents.emit(
      "did-navigate-in-page",
      {},
      "https://example.com/#section",
      true,
      1,
      1,
    );
    expect(urls).toContainEqual(["session-1", "https://example.com/#section"]);
  });

  it("turns a rejected programmatic load into a terminal session failure", async () => {
    const { handle, webContents, failed } = setup();
    webContents.loadError = new Error("network unavailable");

    handle.loadUrl("https://example.com/", "session-1");

    await vi.waitFor(() => {
      expect(failed).toEqual([["session-1", "network unavailable"]]);
    });
  });

  it("absorbs Electron's aborted-load rejection without failing the session", async () => {
    const { handle, webContents, failed } = setup();
    webContents.loadError = Object.assign(new Error("ERR_ABORTED"), { code: -3 });

    handle.loadUrl("https://example.com/", "session-1");

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failed).toEqual([]);
  });

  it("executes automation only in the fixed non-main isolated world", async () => {
    const { handle, webContents } = setup();

    await handle.executeJavaScript?.("document.title");

    expect(BROWSER_AUTOMATION_WORLD_ID).not.toBe(0);
    expect(BROWSER_AUTOMATION_WORLD_ID).not.toBe(999);
    expect(webContents.mainWorldEvalCalls).toBe(0);
    expect(webContents.isolatedCalls).toHaveLength(1);
    expect(webContents.isolatedCalls[0]).toMatchObject({
      worldId: BROWSER_AUTOMATION_WORLD_ID,
      userGesture: false,
      scripts: [{ code: expect.stringContaining("document.title") }],
    });
  });

  it("constructs every browser view with explicit hostile-web preferences", () => {
    setup();
    expect(electron.options[0]).toEqual({
      webPreferences: {
        session: electron.views[0]?.webContents.session,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        experimentalFeatures: false,
        navigateOnDragDrop: false,
        safeDialogs: true,
      },
    });
  });

  it("bounds direct adapter eval source at exact N/N+1 before Electron", async () => {
    const { handle, webContents } = setup();

    await handle.executeJavaScript?.("x".repeat(BROWSER_MAX_EVAL_CODE_BYTES));
    expect(webContents.isolatedCalls).toHaveLength(1);

    expect(() => handle.executeJavaScript?.("x".repeat(BROWSER_MAX_EVAL_CODE_BYTES + 1)))
      .toThrow("eval source exceeds the hard limit");
    expect(webContents.isolatedCalls).toHaveLength(1);
  });
});

describe("isolated-world bounded eval serializer", () => {
  const freshContext = (): Context => createContext({
    TextEncoder,
    document: { title: "isolated title" },
  });

  it("preserves indirect-eval completion values and awaits promises", async () => {
    const result = await runBoundedEval(
      freshContext(),
      "Promise.resolve({ title: document.title, values: [1, true, null] })",
    );

    expect(result).toEqual({
      __vellumEval: 1,
      status: "ok",
      json: '{"title":"isolated title","values":[1,true,null]}',
    });
  });

  it("accepts exactly the byte cap and rejects N+1 before returning to Electron", async () => {
    const atLimit = await runBoundedEval(
      freshContext(),
      `"a".repeat(${BROWSER_MAX_EVAL_RESULT_BYTES - 2})`,
    );
    expect(atLimit).toMatchObject({ __vellumEval: 1, status: "ok" });
    if (
      typeof atLimit !== "object" ||
      atLimit === null ||
      !("json" in atLimit) ||
      typeof atLimit.json !== "string"
    ) {
      throw new Error("bounded eval did not return JSON");
    }
    expect(utf8ByteLength(atLimit.json)).toBe(BROWSER_MAX_EVAL_RESULT_BYTES);

    expect(await runBoundedEval(
      freshContext(),
      `"a".repeat(${BROWSER_MAX_EVAL_RESULT_BYTES - 1})`,
    )).toMatchObject({ __vellumEval: 1, status: "result_too_large" });
  });

  it("accepts exactly the depth cap and rejects N+1", async () => {
    const nested = (depth: number): string =>
      `(() => { let value = 0; for (let i = 0; i < ${depth}; i += 1) value = [value]; return value; })()`;

    expect(await runBoundedEval(freshContext(), nested(BROWSER_MAX_EVAL_RESULT_DEPTH)))
      .toMatchObject({ status: "ok" });
    expect(await runBoundedEval(freshContext(), nested(BROWSER_MAX_EVAL_RESULT_DEPTH + 1)))
      .toMatchObject({ status: "result_too_large" });
  });

  it("accepts exactly the node cap and rejects N+1", async () => {
    expect(await runBoundedEval(
      freshContext(),
      `Array.from({ length: ${BROWSER_MAX_EVAL_RESULT_NODES - 1} }, (_, index) => index)`,
    )).toMatchObject({ status: "ok" });
    expect(await runBoundedEval(
      freshContext(),
      `Array.from({ length: ${BROWSER_MAX_EVAL_RESULT_NODES} }, (_, index) => index)`,
    )).toMatchObject({ status: "result_too_large" });
  });

  it.each([
    ["undefined", "undefined"],
    ["function", "() => 1"],
    ["symbol", "Symbol('x')"],
    ["bigint", "1n"],
    ["non-finite number", "Number.POSITIVE_INFINITY"],
    ["cycle", "(() => { const value = {}; value.self = value; return value; })()"],
    ["accessor", "Object.defineProperty({}, 'x', { enumerable: true, get: () => 1 })"],
    ["non-plain object", "new Date()"],
    ["throwing proxy", "new Proxy({}, { ownKeys: () => { throw new Error('trap'); } })"],
  ])("rejects unsupported %s results", async (_label, source) => {
    expect(await runBoundedEval(freshContext(), source))
      .toMatchObject({ __vellumEval: 1, status: "unsupported_result" });
  });

  it("keeps serializer intrinsics pristine across hostile prior automation", async () => {
    const context = freshContext();
    expect(await runBoundedEval(
      context,
      "JSON.stringify = () => 'poison'; TextEncoder = class {}; eval = () => 'poison'; 'first'",
    )).toEqual({ __vellumEval: 1, status: "ok", json: '"first"' });

    expect(await runBoundedEval(context, "({ title: document.title })"))
      .toEqual({
        __vellumEval: 1,
        status: "ok",
        json: '{"title":"isolated title"}',
      });
  });
});
