import { describe, expect, expectTypeOf, it } from "vitest";
import type { BrowserTabId } from "../src/shared/browser-tab";
import {
  BROWSER_MAX_TABS_PER_PAGE,
  activeTab,
  initialPageTabs,
  mintTabId,
  reducePageTabs,
  resolveTab,
  type PageTabs,
  type PageTabsEvent,
  type PageTabsResult,
} from "../src/shared/page-tabs";

const t = mintTabId;

const ok = (result: PageTabsResult): PageTabs => {
  if (!result.ok) throw new Error(`refused: ${result.refusal.kind}`);
  return result.state;
};

const apply = (state: PageTabs, ...events: PageTabsEvent[]): PageTabs =>
  events.reduce((current, event) => ok(reducePageTabs(current, event)), state);

/** The invariants every reachable state keeps. */
const expectInvariants = (state: PageTabs): void => {
  const ids = state.tabs.map((tab) => tab.id);
  expect(state.tabs.length).toBeGreaterThan(0);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toContain(state.active);
  for (const id of ids) expect(Number(id.slice(1))).toBeLessThan(state.nextOrdinal);
};

describe("page tabs", () => {
  it("starts with one active tab on the page's home url", () => {
    const state = initialPageTabs("https://example.com/");
    expect(state.tabs.map((tab) => [tab.id, tab.url])).toEqual([["t1", "https://example.com/"]]);
    expect(state.active).toBe("t1");
    expectInvariants(state);
  });

  it("opens a tab with a new id, activating it only when asked", () => {
    const base = initialPageTabs("https://a.test/");
    const background = reducePageTabs(base, { kind: "open", url: "https://b.test/", activate: false });
    expect(background).toMatchObject({ ok: true, tab: "t2" });
    expect(ok(background).active).toBe("t1");
    const foreground = apply(base, { kind: "open", url: "https://b.test/", activate: true });
    expect(foreground.active).toBe("t2");
    expectInvariants(foreground);
  });

  it("never reuses a closed tab's id", () => {
    const state = apply(
      initialPageTabs("https://a.test/"),
      { kind: "open", url: "https://b.test/", activate: true },
      { kind: "close", tab: t(2) },
      { kind: "open", url: "https://c.test/", activate: true },
    );
    expect(state.tabs.map((tab) => tab.id)).toEqual(["t1", "t3"]);
    expect(resolveTab(state, t(2))).toEqual({ ok: false, refusal: { kind: "no_such_tab", tab: "t2" } });
    expectInvariants(state);
  });

  it("refuses to close the last tab", () => {
    expect(reducePageTabs(initialPageTabs("https://a.test/"), { kind: "close", tab: t(1) })).toEqual({
      ok: false,
      refusal: { kind: "last_tab", tab: "t1" },
    });
  });

  it("closing the active tab activates its right neighbour, else its left", () => {
    const three = apply(
      initialPageTabs("https://a.test/"),
      { kind: "open", url: "https://b.test/", activate: false },
      { kind: "open", url: "https://c.test/", activate: false },
      { kind: "activate", tab: t(2) },
    );
    expect(apply(three, { kind: "close", tab: t(2) }).active).toBe("t3");
    const last = apply(three, { kind: "activate", tab: t(3) }, { kind: "close", tab: t(3) });
    expect(last.active).toBe("t2");
    expect(apply(three, { kind: "close", tab: t(1) }).active).toBe("t2");
  });

  it("refuses the tab past the limit instead of evicting one", () => {
    let state = initialPageTabs("https://a.test/");
    for (let i = 1; i < BROWSER_MAX_TABS_PER_PAGE; i += 1) {
      state = apply(state, { kind: "open", url: "https://b.test/", activate: false });
    }
    expect(reducePageTabs(state, { kind: "open", url: "https://c.test/", activate: true })).toEqual({
      ok: false,
      refusal: { kind: "too_many_tabs", limit: BROWSER_MAX_TABS_PER_PAGE },
    });
  });

  it("moves a tab to an index and refuses an index outside the strip", () => {
    const three = apply(
      initialPageTabs("https://a.test/"),
      { kind: "open", url: "https://b.test/", activate: false },
      { kind: "open", url: "https://c.test/", activate: false },
    );
    expect(apply(three, { kind: "move", tab: t(3), index: 0 }).tabs.map((tab) => tab.id)).toEqual(["t3", "t1", "t2"]);
    expect(apply(three, { kind: "move", tab: t(1), index: 2 }).tabs.map((tab) => tab.id)).toEqual(["t2", "t3", "t1"]);
    expect(reducePageTabs(three, { kind: "move", tab: t(1), index: 3 })).toEqual({
      ok: false,
      refusal: { kind: "bad_index", index: 3 },
    });
  });

  it("tracks a tab's url, history, title and loading from its view", () => {
    const state = apply(
      initialPageTabs("https://a.test/"),
      { kind: "navigated", tab: t(1), url: "https://a.test/next", canGoBack: true, canGoForward: false },
      { kind: "titled", tab: t(1), title: "Next" },
      { kind: "loading", tab: t(1), loading: false },
    );
    expect(activeTab(state)).toEqual({
      id: "t1",
      url: "https://a.test/next",
      title: "Next",
      loading: false,
      canGoBack: true,
      canGoForward: false,
    });
  });

  it("resolves the active tab when none is named, and refuses an unknown one", () => {
    const state = apply(initialPageTabs("https://a.test/"), { kind: "open", url: "https://b.test/", activate: true });
    expect(resolveTab(state)).toMatchObject({ ok: true, tab: { id: "t2" } });
    expect(resolveTab(state, t(1))).toMatchObject({ ok: true, tab: { id: "t1" } });
    for (const kind of ["close", "activate", "titled"] as const) {
      const event = kind === "titled" ? { kind, tab: t(9), title: "x" } : { kind, tab: t(9) };
      expect(reducePageTabs(state, event)).toEqual({ ok: false, refusal: { kind: "no_such_tab", tab: "t9" } });
    }
  });

  it("keeps its contract closed at the type level", () => {
    expectTypeOf(mintTabId(1)).toEqualTypeOf<BrowserTabId>();
    expectTypeOf<PageTabs["tabs"][0]>().not.toBeUndefined();
    expectTypeOf<PageTabsEvent["kind"]>().toEqualTypeOf<
      "open" | "close" | "activate" | "move" | "navigated" | "titled" | "loading"
    >();
    // @ts-expect-error a plain string is not a tab id
    resolveTab(initialPageTabs("https://a.test/"), "t1");
  });
});
