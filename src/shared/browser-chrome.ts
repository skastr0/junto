/**
 * What the page's chrome reads and does (plan 0.10/06 "less hostile"): its
 * tabs, who is driving, and the operator's commands. One interface so the
 * window never knows whether main or a stand-in answers it. Main's side is
 * product-attention's (`sessions.ts`: `takeOver`, `release`, `drivingFor`, and
 * the page's `PageTabs`); the window's is product-modals' (the chrome in
 * `src/renderer/components/browser`).
 *
 * Built on the shared page types: tabs are `PageTabs` (page-tabs.ts), the mark
 * is read from `PageDriving` with `driverMark(state, now)` (page-driver.ts).
 * Pure types: no Node, no Electron.
 */
import type { BrowserTraverseStep } from "./browser";
import type { BrowserTabId } from "./browser-tab";
import type { PageDriving } from "./page-driver";
import type { PageTabs, PageTabsRefusal } from "./page-tabs";

/** Everything the chrome paints, read together so a frame is never torn. */
export type BrowserChromeState = {
  readonly tabs: PageTabs;
  readonly driving: PageDriving;
};

/**
 * Why a command did not happen. The tab refusals are the reducer's own; the
 * rest are the browser's: a seat's action in the way, a refused address or
 * busy view, a page that is gone.
 */
export type BrowserChromeRefusal =
  | PageTabsRefusal
  /** The operator holds the page, so a seat command is refused (never the operator's own). */
  | { readonly kind: "operator_holds"; readonly since: number }
  /** The command cannot run now (a busy view, a refused address): `message` says why. */
  | { readonly kind: "invalid"; readonly message: string }
  /** The page's session is gone. */
  | { readonly kind: "not_found" };

/** A command's answer: done, or why not. */
export type BrowserChromeOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: BrowserChromeRefusal };

/** The chrome's commands are the operator's. `sessionId` is the page's session. */
export type BrowserChromeApi = {
  readonly state: (sessionId: string) => Promise<BrowserChromeState | undefined>;
  /** Take the page over: every seat action is refused until `release`. */
  readonly takeOver: (sessionId: string) => Promise<BrowserChromeOutcome>;
  /** Hand the page back: seats resume under their grants. */
  readonly release: (sessionId: string) => Promise<BrowserChromeOutcome>;
  /** Go to a URL on a tab, or on the active tab when none is named. */
  readonly goto: (sessionId: string, url: string, tab?: BrowserTabId) => Promise<BrowserChromeOutcome>;
  /** Step the active tab through its history, or reload it. */
  readonly traverse: (sessionId: string, step: BrowserTraverseStep) => Promise<BrowserChromeOutcome>;
  readonly openTab: (sessionId: string, url?: string) => Promise<BrowserChromeOutcome>;
  readonly closeTab: (sessionId: string, tab: BrowserTabId) => Promise<BrowserChromeOutcome>;
  readonly activateTab: (sessionId: string, tab: BrowserTabId) => Promise<BrowserChromeOutcome>;
  /** Said whenever this page's state changed, by anyone (a seat, the operator, the page itself). */
  readonly onChanged: (listener: (sessionId: string) => void) => () => void;
};
