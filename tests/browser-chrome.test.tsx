import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/model";
import type { BrowserChromeState } from "../src/shared/browser-chrome";
import { initialPageDriving, reducePageDriving } from "../src/shared/page-driver";
import { initialPageTabs, reducePageTabs } from "../src/shared/page-tabs";
import { BrowserChrome } from "../src/renderer/components/browser/BrowserChrome";

const seat = asNodeId("seat-ada");
const tabsTwo = (() => {
  const opened = reducePageTabs(initialPageTabs("https://example.com/"), { kind: "open", url: "https://docs.example.com/", activate: true });
  if (!opened.ok) throw new Error("open failed");
  const titled = reducePageTabs(opened.state, { kind: "titled", tab: opened.tab, title: "Docs" });
  if (!titled.ok) throw new Error("title failed");
  return titled.state;
})();
const draw = (state: BrowserChromeState) =>
  renderToStaticMarkup(
    <BrowserChrome state={state} now={5_000} seatName={(id) => (id === seat ? "Ada" : undefined)} onCommand={async () => ({ ok: true })} onFocusPage={() => undefined} controls="surface" />,
  );

describe("BrowserChrome", () => {
  it("draws the tab strip with the active tab marked, titles first then hosts, and a close on each when there are two", () => {
    const html = draw({ tabs: tabsTwo, driving: initialPageDriving });
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("Docs");
    expect(html).toContain("example.com");
    expect(html).toContain("Close Docs");
    expect(html).toContain("New tab");
  });

  it("keeps the tablist to tabs: one tab in the tab order, new tab and close outside the tab keys", () => {
    const html = draw({ tabs: tabsTwo, driving: initialPageDriving });
    const list = html.slice(html.indexOf('role="tablist"'), html.indexOf("New tab") );
    expect((list.match(/role="tab"/g) ?? []).length).toBe(2);
    expect((list.match(/tabindex="0"/g) ?? []).length).toBe(1);
    expect((list.match(/tabindex="-1"/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html.indexOf('aria-label="New tab"')).toBeGreaterThan(html.indexOf("</div></div>", html.indexOf('role="tablist"')) - 1);
  });

  it("draws Stop in the Reload slot while the active tab loads, and Reload once it has", () => {
    const loading = draw({ tabs: initialPageTabs("https://example.com/"), driving: initialPageDriving });
    expect(loading).toContain('aria-label="Stop"');
    expect(loading).not.toContain('aria-label="Reload"');
    const done = reducePageTabs(initialPageTabs("https://example.com/"), { kind: "loading", tab: "t1" as never, loading: false });
    if (!done.ok) throw new Error("loading");
    const settled = draw({ tabs: done.state, driving: initialPageDriving });
    expect(settled).toContain('aria-label="Reload"');
    expect(settled).not.toContain('aria-label="Stop"');
  });

  it("says a refused navigation in main's words on the tab it happened on, and not on another tab", () => {
    const blocked = { tab: "t2" as never, message: "That page tried to go to a private address.", at: 1 };
    expect(draw({ tabs: tabsTwo, driving: initialPageDriving, blocked })).toContain("That page tried to go to a private address.");
    expect(draw({ tabs: tabsTwo, driving: initialPageDriving, blocked: { ...blocked, tab: "t1" as never } })).not.toContain("private address");
    expect(draw({ tabs: tabsTwo, driving: initialPageDriving })).not.toContain("browser-chrome-blocked");
  });

  it("hides close on the only tab", () => {
    const html = draw({ tabs: initialPageTabs("https://example.com/"), driving: initialPageDriving });
    expect(html).not.toContain("Close example.com");
  });

  it("shows the address of the active tab and disables history that cannot step", () => {
    const html = draw({ tabs: tabsTwo, driving: initialPageDriving });
    expect(html).toContain('value="https://docs.example.com/"');
    expect(/<button[^>]*aria-label="Back"[^>]*disabled=""/.test(html) || /<button[^>]*disabled=""[^>]*aria-label="Back"/.test(html)).toBe(true);
  });

  it("names who is driving and offers take over, then hand back once held", () => {
    const idle = draw({ tabs: tabsTwo, driving: initialPageDriving });
    expect(idle).toContain("Nobody is driving");
    expect(idle).toContain("Take over");
    const seatRuns = draw({ tabs: tabsTwo, driving: reducePageDriving(initialPageDriving, { kind: "seat-start", nodeId: seat, at: 4_500 }) });
    expect(seatRuns).toContain("Ada is driving");
    const held = draw({ tabs: tabsTwo, driving: reducePageDriving(initialPageDriving, { kind: "take-over", at: 1 }) });
    expect(held).toContain("You hold this page");
    expect(held).toContain("Hand back");
    expect(held).not.toContain("Take over");
  });

  it("keeps the driver quiet when nobody drives, and names the seat a takeover pauses", () => {
    const idle = draw({ tabs: tabsTwo, driving: initialPageDriving });
    expect(idle).toMatch(/<span class="sr-only" role="status">Nobody is driving<\/span>/);
    expect(idle).not.toContain('class="driver-mark"');
    const seatRuns = draw({ tabs: tabsTwo, driving: reducePageDriving(initialPageDriving, { kind: "seat-start", nodeId: seat, at: 4_500 }) });
    expect(seatRuns).toContain('aria-label="Take over from Ada"');
    expect(seatRuns).toContain('data-kind="seat" data-live="true"');
  });

  it("shows the page's host apart at rest, and colours the page's edge by who drives", () => {
    const idle = draw({ tabs: tabsTwo, driving: initialPageDriving });
    expect(idle).toContain('<span class="address-bar__shown" aria-hidden="true"><span class="address-bar__quiet">https://</span>docs.example.com<span class="address-bar__quiet">/</span></span>');
    expect(idle).toContain('data-driver="idle"');
    const seatRuns = draw({ tabs: tabsTwo, driving: reducePageDriving(initialPageDriving, { kind: "seat-start", nodeId: seat, at: 4_500 }) });
    expect(seatRuns).toContain('data-driver="seat-live"');
    const held = draw({ tabs: tabsTwo, driving: reducePageDriving(initialPageDriving, { kind: "take-over", at: 1 }) });
    expect(held).toContain('data-driver="operator-held"');
  });

  it("puts the surface's own actions in the tab band, apart from the page's row", () => {
    const html = renderToStaticMarkup(
      <BrowserChrome
        state={{ tabs: tabsTwo, driving: initialPageDriving }}
        now={5_000}
        seatName={() => undefined}
        onCommand={async () => ({ ok: true })}
        onFocusPage={() => undefined}
        trailing={<button type="button">Close</button>}
      />,
    );
    const top = html.slice(html.indexOf('class="browser-chrome__top"'), html.indexOf('class="browser-chrome__row"'));
    expect(top).toContain('class="browser-chrome__window"><button type="button">Close</button>');
  });
});
