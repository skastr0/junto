/**
 * Where the page chrome reads its state and sends the operator's commands
 * (plan 0.10/06). The contract is `src/shared/browser-chrome.ts`; main's side
 * is product-attention's. Until it is served over IPC, `makeLocalBrowserChrome`
 * holds a page's tabs and driving in memory, ruled by the same shared reducers
 * (`reducePageTabs`, `reducePageDriving`), for the gallery and the tests.
 */
import { useEffect, useRef, useState } from "react";
import type { BrowserTraverseStep } from "@shared/browser";
import type {
  BrowserChromeApi,
  BrowserChromeOutcome,
  BrowserChromeState,
} from "@shared/browser-chrome";
import type { BrowserTabId } from "@shared/browser-tab";
import { initialPageDriving, reducePageDriving, type PageDriving } from "@shared/page-driver";
import { initialPageTabs, reducePageTabs, resolveTab, type PageTabs } from "@shared/page-tabs";

/** What the chrome asks for, as data, so one handler runs every one of them. */
export type ChromeCommand =
  | { readonly kind: "takeOver" }
  | { readonly kind: "release" }
  | { readonly kind: "goto"; readonly url: string }
  | { readonly kind: "traverse"; readonly step: BrowserTraverseStep }
  | { readonly kind: "openTab"; readonly url?: string }
  | { readonly kind: "closeTab"; readonly tab: BrowserTabId }
  | { readonly kind: "activateTab"; readonly tab: BrowserTabId };

export const runChromeCommand = (
  api: BrowserChromeApi,
  sessionId: string,
  command: ChromeCommand,
): Promise<BrowserChromeOutcome> => {
  switch (command.kind) {
    case "takeOver":
      return api.takeOver(sessionId);
    case "release":
      return api.release(sessionId);
    case "goto":
      return api.goto(sessionId, command.url);
    case "traverse":
      return api.traverse(sessionId, command.step);
    case "openTab":
      return api.openTab(sessionId, command.url);
    case "closeTab":
      return api.closeTab(sessionId, command.tab);
    case "activateTab":
      return api.activateTab(sessionId, command.tab);
  }
};

const OK: BrowserChromeOutcome = { ok: true };

/** A local page: tabs and driving in memory. `seatStart` and `seatEnd` stand for a seat acting. */
export type LocalBrowserChrome = BrowserChromeApi & {
  readonly seat: (sessionId: string, event: Extract<Parameters<typeof reducePageDriving>[1], { kind: "seat-start" | "seat-end" }>) => void;
};

export const makeLocalBrowserChrome = (homeUrl = "https://example.com/"): LocalBrowserChrome => {
  const pages = new Map<string, BrowserChromeState>();
  const listeners = new Set<(sessionId: string) => void>();
  const stateOf = (sessionId: string): BrowserChromeState => {
    const held = pages.get(sessionId);
    if (held !== undefined) return held;
    const fresh: BrowserChromeState = { tabs: initialPageTabs(homeUrl), driving: initialPageDriving };
    pages.set(sessionId, fresh);
    return fresh;
  };
  const put = (sessionId: string, next: Partial<BrowserChromeState>): void => {
    pages.set(sessionId, { ...stateOf(sessionId), ...next });
    for (const listener of listeners) listener(sessionId);
  };
  const tabsEvent = (
    sessionId: string,
    run: (tabs: PageTabs) => ReturnType<typeof reducePageTabs>,
  ): BrowserChromeOutcome => {
    const result = run(stateOf(sessionId).tabs);
    if (!result.ok) return { ok: false, refusal: result.refusal };
    put(sessionId, { tabs: result.state });
    return OK;
  };
  const drive = (sessionId: string, driving: PageDriving): void => put(sessionId, { driving });

  return {
    state: async (sessionId) => stateOf(sessionId),
    takeOver: async (sessionId) => {
      drive(sessionId, reducePageDriving(stateOf(sessionId).driving, { kind: "take-over", at: Date.now() }));
      return OK;
    },
    release: async (sessionId) => {
      drive(sessionId, reducePageDriving(stateOf(sessionId).driving, { kind: "release", at: Date.now() }));
      return OK;
    },
    goto: async (sessionId, url, tab) =>
      tabsEvent(sessionId, (tabs) => {
        const resolved = resolveTab(tabs, tab);
        if (!resolved.ok) return { ok: false, refusal: resolved.refusal };
        return reducePageTabs(tabs, { kind: "navigated", tab: resolved.tab.id, url, canGoBack: true, canGoForward: false });
      }),
    traverse: async (sessionId, step) =>
      tabsEvent(sessionId, (tabs) => reducePageTabs(tabs, { kind: "loading", tab: tabs.active, loading: step === "reload" })),
    openTab: async (sessionId, url) => tabsEvent(sessionId, (tabs) => reducePageTabs(tabs, { kind: "open", url: url ?? "", activate: true })),
    closeTab: async (sessionId, tab) => tabsEvent(sessionId, (tabs) => reducePageTabs(tabs, { kind: "close", tab })),
    activateTab: async (sessionId, tab) => tabsEvent(sessionId, (tabs) => reducePageTabs(tabs, { kind: "activate", tab })),
    focusPage: async () => true,
    onChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    seat: (sessionId, event) => drive(sessionId, reducePageDriving(stateOf(sessionId).driving, event)),
  };
};

let api: BrowserChromeApi | undefined;

/** The window's page chrome API; undefined until main serves it (the old header stays). */
export const browserChromeApi = (): BrowserChromeApi | undefined => api;

export const setBrowserChromeApi = (next: BrowserChromeApi | undefined): void => {
  api = next;
};

/**
 * A page's chrome state, kept fresh. Undefined while it first loads or when
 * the page has no session. Each tab is its own session, so a tab shown or
 * closed swaps the session under the same page: the strip stays up with the
 * page's last state until the new session's state lands, never flashing back
 * to the old header.
 */
export const useBrowserChromeState = (
  chrome: BrowserChromeApi | undefined,
  sessionId: string | undefined,
): BrowserChromeState | undefined => {
  const [state, setState] = useState<BrowserChromeState | undefined>(undefined);
  const key = `${sessionId ?? ""}`;
  const latest = useRef(0);
  useEffect(() => {
    if (chrome === undefined || sessionId === undefined) {
      setState(undefined);
      return;
    }
    let live = true;
    const read = (): void => {
      const mine = ++latest.current;
      void chrome.state(sessionId).then((next) => {
        if (live && mine === latest.current) setState(next);
      });
    };
    read();
    const off = chrome.onChanged((changed) => {
      if (changed === sessionId) read();
    });
    return () => {
      live = false;
      off();
    };
  }, [chrome, key]);
  return state;
};
