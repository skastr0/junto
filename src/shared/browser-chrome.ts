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

/**
 * A top-level navigation the browser refused on a tab, said in one line.
 * It stands until that tab shows another document.
 */
export type BrowserNavigationBlock = {
  readonly tab: BrowserTabId;
  readonly message: string;
  readonly at: number;
};

/** Everything the chrome paints, read together so a frame is never torn. */
export type BrowserChromeState = {
  readonly tabs: PageTabs;
  readonly driving: PageDriving;
  /** The page's last refused navigation, while it stands. */
  readonly blocked?: BrowserNavigationBlock;
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

/** A box on the page, in page CSS pixels (a `PageBoxRequest` without its kind). */
export type BrowserBoxRect = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

/**
 * A box the operator drew, with the shot main took of it and is holding. The
 * shot is staged under `shotId`: posting names that id, so the comment carries
 * exactly the image shown, never a second capture taken later (remote-security's
 * ask: what crosses machines is what the operator saw and chose). PNG bytes,
 * encoded by main (`page-shot.ts`).
 */
export type BrowserBoxDraft = {
  readonly shotId: string;
  readonly rect: BrowserBoxRect;
  /** The page the box was drawn on, as the comment will carry it. */
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly png: Uint8Array;
};

/** How box drawing ended: a box with its staged shot, no box (Escape, left the page), or a refusal. */
export type BrowserBoxResult =
  | { readonly kind: "drawn"; readonly draft: BrowserBoxDraft }
  | { readonly kind: "ended" }
  | { readonly kind: "refused"; readonly refusal: BrowserChromeRefusal };

/**
 * Commenting on an area of the page. Absent when main does not serve it: the
 * chrome then offers no comment control. The box itself is drawn in the page's
 * view (a native view paints above the window, so the window cannot draw over it).
 */
export type BrowserBoxApi = {
  /**
   * Enter box drawing on the page's view. Resolves when drawing ends: with the
   * staged draft when the operator releases a box, `ended` without one, or the
   * refusal when the capture was refused (`page-shot.ts` words, as `invalid`).
   */
  readonly start: (sessionId: string) => Promise<BrowserBoxResult>;
  /** Post the comment with exactly the staged shot; the staged shot is dropped either way. */
  readonly post: (sessionId: string, shotId: string, text: string) => Promise<BrowserChromeOutcome>;
  /** Drop a staged shot the operator did not post. */
  readonly discard: (sessionId: string, shotId: string) => Promise<void>;
};

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
  /**
   * Move keyboard focus into the page's view (`webContents.focus()`). False
   * when the view is detached or hidden, and the caller then focuses the
   * surface root instead. The one place focus goes to the page.
   */
  readonly focusPage: (sessionId: string) => Promise<boolean>;
  /** Comment on an area, when main serves it. */
  readonly box?: BrowserBoxApi;
  /** Said whenever this page's state changed, by anyone (a seat, the operator, the page itself). */
  readonly onChanged: (listener: (sessionId: string) => void) => () => void;
};
