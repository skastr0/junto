// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserChromeApi, BrowserChromeState } from "../src/shared/browser-chrome";
import { initialPageDriving } from "../src/shared/page-driver";
import { initialPageTabs, reducePageTabs, type PageTabs } from "../src/shared/page-tabs";
import { useBrowserChromeState } from "../src/renderer/lib/browser-chrome-source";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const twoTabs: PageTabs = (() => {
  const opened = reducePageTabs(initialPageTabs("https://a.example.com/"), { kind: "open", url: "https://b.example.com/", activate: true });
  if (!opened.ok) throw new Error("open");
  return opened.state;
})();
const oneTab: PageTabs = (() => {
  const closed = reducePageTabs(twoTabs, { kind: "close", tab: twoTabs.active });
  if (!closed.ok) throw new Error("close");
  return closed.state;
})();

/** Main's chrome, with each session's state answered when the test says. */
const pendingChrome = () => {
  const waiting = new Map<string, (state: BrowserChromeState | undefined) => void>();
  const chrome = {
    state: (sessionId: string) => new Promise<BrowserChromeState | undefined>((resolve) => waiting.set(sessionId, resolve)),
    onChanged: () => () => undefined,
  } as unknown as BrowserChromeApi;
  const answer = async (sessionId: string, state: BrowserChromeState | undefined) => {
    await act(async () => {
      waiting.get(sessionId)?.(state);
    });
  };
  return { chrome, answer };
};

describe("useBrowserChromeState", () => {
  it("keeps the strip up while a closed tab's page swaps to the next tab's session", async () => {
    const { chrome, answer } = pendingChrome();
    const seen: Array<BrowserChromeState | undefined> = [];
    const Probe = ({ sessionId }: { readonly sessionId: string | undefined }) => {
      seen.push(useBrowserChromeState(chrome, sessionId));
      return null;
    };
    await act(async () => root.render(<Probe sessionId="tab-2" />));
    await answer("tab-2", { tabs: twoTabs, driving: initialPageDriving });
    expect(seen.at(-1)?.tabs.tabs).toHaveLength(2);

    // Tab 2 closes: the page's shown session is tab 1's now.
    const before = seen.length;
    await act(async () => root.render(<Probe sessionId="tab-1" />));
    expect(seen.slice(before).every((state) => state !== undefined)).toBe(true);
    await answer("tab-1", { tabs: oneTab, driving: initialPageDriving });
    expect(seen.at(-1)?.tabs.tabs).toHaveLength(1);
    expect(seen.slice(before).every((state) => state !== undefined)).toBe(true);
  });

  it("lets go of the strip when the page has no session", async () => {
    const { chrome, answer } = pendingChrome();
    const seen: Array<BrowserChromeState | undefined> = [];
    const Probe = ({ sessionId }: { readonly sessionId: string | undefined }) => {
      seen.push(useBrowserChromeState(chrome, sessionId));
      return null;
    };
    await act(async () => root.render(<Probe sessionId="tab-1" />));
    await answer("tab-1", { tabs: oneTab, driving: initialPageDriving });
    await act(async () => root.render(<Probe sessionId={undefined} />));
    expect(seen.at(-1)).toBeUndefined();
  });
});
