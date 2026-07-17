import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  type Listener = (...args: ReadonlyArray<unknown>) => void;

  class FakeWebContents {
    readonly listeners = new Map<string, Listener[]>();
    currentUrl = "";
    title = "";
    loadError: (Error & { readonly code?: number }) | undefined;

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
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

    close(): void {}
    executeJavaScript(): Promise<unknown> {
      return Promise.resolve(null);
    }
    capturePage(): Promise<{ toPNG(): Uint8Array }> {
      return Promise.resolve({ toPNG: () => new Uint8Array([1]) });
    }
  }

  class FakeWebContentsView {
    readonly webContents = new FakeWebContents();
    setBounds(): void {}
  }

  return {
    views: [] as FakeWebContentsView[],
    FakeWebContentsView,
  };
});

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  WebContentsView: class extends electron.FakeWebContentsView {
    constructor() {
      super();
      electron.views.push(this);
    }
  },
}));

import { electronViewAdapter } from "../src/main/vellum/browser/view-adapter";
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

describe("electron browser view generation seam", () => {
  beforeEach(() => {
    electron.views.length = 0;
  });

  const setup = () => {
    const starts: Array<Parameters<BrowserViewEvents["onNavigationStart"]>[0]> = [];
    const urls: Array<readonly [string, string]> = [];
    const completed: Array<readonly [string, string | undefined]> = [];
    const failed: Array<readonly [string, string]> = [];
    const ambiguous: string[] = [];
    let pageGeneration = 1;
    const handle = electronViewAdapter("persist:test", {
      onNavigationStart: (event) => {
        starts.push(event);
        return event.expectedSessionId ?? `page-${pageGeneration++}`;
      },
      onNavigationAmbiguous: (sessionId) => ambiguous.push(sessionId),
      onNavigationUrl: (sessionId, url) => urls.push([sessionId, url]),
      onLoadOk: (sessionId, title) => completed.push([sessionId, title]),
      onLoadFail: (sessionId, message) => failed.push([sessionId, message]),
    });
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
});
