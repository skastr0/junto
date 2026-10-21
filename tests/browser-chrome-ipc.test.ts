import { describe, expect, it, vi } from "vitest";
import { chromeOutcome, installIpcBrowserChrome, makeIpcBrowserBox, makeIpcBrowserChrome } from "../src/renderer/lib/browser-chrome-ipc";
import { browserChromeApi, setBrowserChromeApi } from "../src/renderer/lib/browser-chrome-source";
import { initialPageDriving } from "../src/shared/page-driver";
import { initialPageTabs } from "../src/shared/page-tabs";

const bridge = () => ({
  browserPageState: vi.fn(async (_sessionId: string) => ({
    ok: true,
    data: { tabs: initialPageTabs("https://example.com/"), driving: initialPageDriving },
  })),
  browserTakeOver: vi.fn(async () => ({ ok: true })),
  browserRelease: vi.fn(async () => ({ ok: false, code: "invalid", message: "the page is outside a seat's grant" })),
  browserGoto: vi.fn(async () => ({ ok: true })),
  browserTraverse: vi.fn(async () => ({ ok: false, code: "not_found", message: "gone" })),
  browserOpenTab: vi.fn(async () => ({ ok: false, code: "resource_exhausted", message: "a page holds at most 12 tabs" })),
  browserCloseTab: vi.fn(async () => ({ ok: true })),
  browserActivateTab: vi.fn(async () => Promise.reject(new Error("bridge down"))),
  browserFocusPage: vi.fn(async () => ({ ok: true, data: true })),
  onBrowserPageChanged: vi.fn((_listener: (sessionId: string) => void) => () => undefined),
});

const box = () => ({
  browserBoxStart: vi.fn(async (_sessionId: string) => ({
    ok: true,
    data: {
      kind: "drawn",
      draft: { shotId: "01M5ESMJV6GNZ0891YFFWS0S3Q", rect: { x: 1, y: 2, w: 3, h: 4 }, url: "https://example.com/", width: 3, height: 4, png: new Uint8Array(8) },
    },
  })),
  browserBoxPost: vi.fn(async (_sessionId: string, _shotId: string, _text: string) => ({ ok: true, data: { messageId: "m", threadId: "m" } })),
  browserBoxDiscard: vi.fn(async (_sessionId: string, _shotId: string) => ({ ok: true, data: null })),
});

describe("page chrome over main's IPC", () => {
  it("reads main's answers as the chrome's outcomes", async () => {
    const ipc = bridge();
    const chrome = makeIpcBrowserChrome(ipc as never);
    expect(await chrome.state("s1")).toMatchObject({ tabs: { active: "t1" } });
    expect(await chrome.takeOver("s1")).toEqual({ ok: true });
    expect(await chrome.release("s1")).toEqual({
      ok: false,
      refusal: { kind: "invalid", message: "the page is outside a seat's grant" },
    });
    expect(await chrome.traverse("s1", "stop")).toEqual({ ok: false, refusal: { kind: "not_found" } });
    expect(await chrome.openTab("s1")).toMatchObject({ ok: false, refusal: { kind: "invalid" } });
    expect(await chrome.activateTab("s1", "t2" as never)).toEqual({
      ok: false,
      refusal: { kind: "invalid", message: "bridge down" },
    });
    expect(await chrome.focusPage("s1")).toBe(true);
    await chrome.goto("s1", "https://example.com/2", "t1" as never);
    expect(ipc.browserGoto).toHaveBeenCalledWith("s1", "https://example.com/2", "t1");
    expect(chromeOutcome({ ok: false, code: "operator_holds" })).toMatchObject({ refusal: { kind: "operator_holds" } });
  });

  it("installs only where the bridge serves every command", () => {
    setBrowserChromeApi(undefined);
    installIpcBrowserChrome({ browserPageState: async () => ({ ok: true }) });
    expect(browserChromeApi()).toBeUndefined();
    installIpcBrowserChrome(bridge());
    expect(browserChromeApi()).toBeDefined();
    expect(browserChromeApi()?.box).toBeUndefined();
    installIpcBrowserChrome({ ...bridge(), ...box() });
    expect(browserChromeApi()?.box).toBeDefined();
    setBrowserChromeApi(undefined);
  });

  it("serves box comments: a drawn draft, no box, a refusal, and a post of the staged id", async () => {
    const ipc = box();
    const api = makeIpcBrowserBox(ipc as never);
    expect(await api.start("s1")).toMatchObject({ kind: "drawn", draft: { shotId: "01M5ESMJV6GNZ0891YFFWS0S3Q" } });
    ipc.browserBoxStart.mockResolvedValueOnce({ ok: true, data: { kind: "ended" } } as never);
    expect(await api.start("s1")).toEqual({ kind: "ended" });
    ipc.browserBoxStart.mockResolvedValueOnce({ ok: false, code: "invalid", message: "That box is over 4096 pixels on a side: draw a smaller box." } as never);
    expect(await api.start("s1")).toEqual({
      kind: "refused",
      refusal: { kind: "invalid", message: "That box is over 4096 pixels on a side: draw a smaller box." },
    });
    expect(await api.post("s1", "01M5ESMJV6GNZ0891YFFWS0S3Q", "look")).toEqual({ ok: true });
    expect(ipc.browserBoxPost).toHaveBeenCalledWith("s1", "01M5ESMJV6GNZ0891YFFWS0S3Q", "look");
    await api.discard("s1", "01M5ESMJV6GNZ0891YFFWS0S3Q");
    expect(ipc.browserBoxDiscard).toHaveBeenCalledWith("s1", "01M5ESMJV6GNZ0891YFFWS0S3Q");
  });
});
