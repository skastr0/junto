import type { BrowserTabId } from "./browser-tab";

/**
 * A page node's tabs (plan 06): an ordered, never empty list with one active
 * tab. Each tab is one live view that the operator and the driving seat share.
 *
 * Tabs are runtime state on the page's own machine, not canvas state: a
 * navigation must not become a canvas write. The page node's `url` is the
 * first tab's home.
 *
 * Tab ids are minted `t1`, `t2`, ... per page and never reused, so a command
 * that names a closed tab is refused instead of reaching a newer one.
 */

/** A page holds at most this many tabs; one more is refused, not evicted. */
export const BROWSER_MAX_TABS_PER_PAGE = 12;

export interface BrowserTab {
  readonly id: BrowserTabId;
  readonly url: string;
  /** The document title, empty until the page names itself. */
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export type NonEmpty<T> = readonly [T, ...T[]];

export interface PageTabs {
  readonly tabs: NonEmpty<BrowserTab>;
  readonly active: BrowserTabId;
  /** The ordinal the next opened tab takes. Only grows. */
  readonly nextOrdinal: number;
}

export type PageTabsEvent =
  | { readonly kind: "open"; readonly url: string; readonly activate: boolean }
  | { readonly kind: "close"; readonly tab: BrowserTabId }
  | { readonly kind: "activate"; readonly tab: BrowserTabId }
  | { readonly kind: "move"; readonly tab: BrowserTabId; readonly index: number }
  | {
      readonly kind: "navigated";
      readonly tab: BrowserTabId;
      readonly url: string;
      readonly canGoBack: boolean;
      readonly canGoForward: boolean;
    }
  | { readonly kind: "titled"; readonly tab: BrowserTabId; readonly title: string }
  | { readonly kind: "loading"; readonly tab: BrowserTabId; readonly loading: boolean };

export type PageTabsRefusal =
  | { readonly kind: "no_such_tab"; readonly tab: BrowserTabId }
  /** The last tab cannot close: stopping the page is a separate act. */
  | { readonly kind: "last_tab"; readonly tab: BrowserTabId }
  | { readonly kind: "too_many_tabs"; readonly limit: number }
  | { readonly kind: "bad_index"; readonly index: number };

export type PageTabsResult =
  | { readonly ok: true; readonly state: PageTabs; readonly tab: BrowserTabId }
  | { readonly ok: false; readonly refusal: PageTabsRefusal };

export type ResolvedTab =
  | { readonly ok: true; readonly tab: BrowserTab }
  | { readonly ok: false; readonly refusal: Extract<PageTabsRefusal, { kind: "no_such_tab" }> };

/** The id of the tab with this ordinal. Minting is the only way to make one. */
export const mintTabId = (ordinal: number): BrowserTabId => `t${ordinal}` as BrowserTabId;

const freshTab = (id: BrowserTabId, url: string): BrowserTab => ({
  id,
  url,
  title: "",
  loading: true,
  canGoBack: false,
  canGoForward: false,
});

export const initialPageTabs = (url: string): PageTabs => {
  const id = mintTabId(1);
  return { tabs: [freshTab(id, url)], active: id, nextOrdinal: 2 };
};

/** The named tab, or the active one when none is named. */
export const resolveTab = (state: PageTabs, tab?: BrowserTabId): ResolvedTab => {
  const id = tab ?? state.active;
  const found = state.tabs.find((candidate) => candidate.id === id);
  return found ? { ok: true, tab: found } : { ok: false, refusal: { kind: "no_such_tab", tab: id } };
};

export const activeTab = (state: PageTabs): BrowserTab =>
  state.tabs.find((tab) => tab.id === state.active) ?? state.tabs[0];

const nonEmpty = <T,>(items: ReadonlyArray<T>): NonEmpty<T> | undefined =>
  items.length > 0 ? (items as NonEmpty<T>) : undefined;

const patchTab = (
  state: PageTabs,
  id: BrowserTabId,
  patch: (tab: BrowserTab) => BrowserTab,
): PageTabsResult => {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return { ok: false, refusal: { kind: "no_such_tab", tab: id } };
  const tabs = state.tabs.map((tab, at) => (at === index ? patch(tab) : tab));
  return { ok: true, state: { ...state, tabs: tabs as unknown as NonEmpty<BrowserTab> }, tab: id };
};

const assertNever = (value: never): never => {
  throw new Error(`unknown page tabs event: ${JSON.stringify(value)}`);
};

/** Pure: one event applied to a page's tabs, or the reason it cannot be. */
export const reducePageTabs = (state: PageTabs, event: PageTabsEvent): PageTabsResult => {
  switch (event.kind) {
    case "open": {
      if (state.tabs.length >= BROWSER_MAX_TABS_PER_PAGE) {
        return { ok: false, refusal: { kind: "too_many_tabs", limit: BROWSER_MAX_TABS_PER_PAGE } };
      }
      const id = mintTabId(state.nextOrdinal);
      return {
        ok: true,
        tab: id,
        state: {
          tabs: [...state.tabs, freshTab(id, event.url)],
          active: event.activate ? id : state.active,
          nextOrdinal: state.nextOrdinal + 1,
        },
      };
    }
    case "close": {
      const index = state.tabs.findIndex((tab) => tab.id === event.tab);
      if (index < 0) return { ok: false, refusal: { kind: "no_such_tab", tab: event.tab } };
      const tabs = nonEmpty(state.tabs.filter((tab) => tab.id !== event.tab));
      if (!tabs) return { ok: false, refusal: { kind: "last_tab", tab: event.tab } };
      // Closing the active tab activates its right neighbour, else its left.
      const active = state.active === event.tab ? (tabs[Math.min(index, tabs.length - 1)] ?? tabs[0]).id : state.active;
      return { ok: true, tab: event.tab, state: { ...state, tabs, active } };
    }
    case "activate":
      return resolveTab(state, event.tab).ok
        ? { ok: true, tab: event.tab, state: { ...state, active: event.tab } }
        : { ok: false, refusal: { kind: "no_such_tab", tab: event.tab } };
    case "move": {
      const from = state.tabs.findIndex((tab) => tab.id === event.tab);
      if (from < 0) return { ok: false, refusal: { kind: "no_such_tab", tab: event.tab } };
      if (!Number.isInteger(event.index) || event.index < 0 || event.index >= state.tabs.length) {
        return { ok: false, refusal: { kind: "bad_index", index: event.index } };
      }
      const rest = state.tabs.filter((tab) => tab.id !== event.tab);
      const tabs = [...rest.slice(0, event.index), state.tabs[from]!, ...rest.slice(event.index)];
      return { ok: true, tab: event.tab, state: { ...state, tabs: tabs as unknown as NonEmpty<BrowserTab> } };
    }
    case "navigated":
      return patchTab(state, event.tab, (tab) => ({
        ...tab,
        url: event.url,
        canGoBack: event.canGoBack,
        canGoForward: event.canGoForward,
      }));
    case "titled":
      return patchTab(state, event.tab, (tab) => ({ ...tab, title: event.title }));
    case "loading":
      return patchTab(state, event.tab, (tab) => ({ ...tab, loading: event.loading }));
    default:
      return assertNever(event);
  }
};
