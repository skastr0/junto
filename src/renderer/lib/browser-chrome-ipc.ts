/**
 * The page chrome over main's IPC (plan 0.10/06): main holds each page's tabs
 * and who drives it, rules the operator's commands, and says which page
 * changed by its shown tab's session.
 */
import type { BrowserChromeApi, BrowserChromeOutcome } from "@shared/browser-chrome";
import type { BrowserOpResult, JuntoBrowserApi } from "@shared/ipc";
import { setBrowserChromeApi } from "./browser-chrome-source";

type ChromeIpc = Pick<
  JuntoBrowserApi,
  | "browserPageState"
  | "browserTakeOver"
  | "browserRelease"
  | "browserGoto"
  | "browserTraverse"
  | "browserOpenTab"
  | "browserCloseTab"
  | "browserActivateTab"
  | "browserFocusPage"
  | "onBrowserPageChanged"
>;

/** Main's answer as the chrome reads it: done, or one line of why not. */
export const chromeOutcome = (result: BrowserOpResult): BrowserChromeOutcome => {
  if (result.ok) return { ok: true };
  if (result.code === "not_found") return { ok: false, refusal: { kind: "not_found" } };
  if (result.code === "operator_holds") return { ok: false, refusal: { kind: "operator_holds", since: 0 } };
  return { ok: false, refusal: { kind: "invalid", message: result.message ?? "the page refused" } };
};

const outcome = (pending: Promise<BrowserOpResult>): Promise<BrowserChromeOutcome> =>
  pending.then(chromeOutcome, (error: unknown) => ({
    ok: false as const,
    refusal: { kind: "invalid" as const, message: error instanceof Error ? error.message : String(error) },
  }));

export const makeIpcBrowserChrome = (api: ChromeIpc): BrowserChromeApi => ({
  state: async (sessionId) => {
    const result = await api.browserPageState(sessionId).catch(() => undefined);
    return result?.ok === true ? result.data : undefined;
  },
  takeOver: (sessionId) => outcome(api.browserTakeOver(sessionId)),
  release: (sessionId) => outcome(api.browserRelease(sessionId)),
  goto: (sessionId, url, tab) => outcome(api.browserGoto(sessionId, url, tab)),
  traverse: (sessionId, step) => outcome(api.browserTraverse(sessionId, step)),
  openTab: (sessionId, url) => outcome(api.browserOpenTab(sessionId, url)),
  closeTab: (sessionId, tab) => outcome(api.browserCloseTab(sessionId, tab)),
  activateTab: (sessionId, tab) => outcome(api.browserActivateTab(sessionId, tab)),
  focusPage: async (sessionId) => {
    const result = await api.browserFocusPage(sessionId).catch(() => undefined);
    return result?.ok === true && result.data === true;
  },
  onChanged: (listener) => api.onBrowserPageChanged(listener),
});

const CHROME_IPC: ReadonlyArray<keyof ChromeIpc> = [
  "browserPageState",
  "browserTakeOver",
  "browserRelease",
  "browserGoto",
  "browserTraverse",
  "browserOpenTab",
  "browserCloseTab",
  "browserActivateTab",
  "browserFocusPage",
  "onBrowserPageChanged",
];

/** Serve the chrome from main when the browser is in this build; without it the old header stays. */
export const installIpcBrowserChrome = (bridge: object | undefined): void => {
  const api = bridge as Partial<ChromeIpc> | undefined;
  if (api !== undefined && CHROME_IPC.every((key) => typeof api[key] === "function")) {
    setBrowserChromeApi(makeIpcBrowserChrome(api as ChromeIpc));
  }
};
