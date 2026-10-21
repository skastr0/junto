import { describe, expect, it, vi } from "vitest";
import { chromeOutcome, installIpcBrowserChrome, makeIpcBrowserChrome } from "../src/renderer/lib/browser-chrome-ipc";
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
    setBrowserChromeApi(undefined);
  });
});
