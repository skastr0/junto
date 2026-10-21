// @vitest-environment jsdom
/**
 * The chrome's takeover notice: main's line on the tabs it names, with a
 * Reload that runs the operator's own reload; on any other tab, nothing.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEAT_CODE_NOTICE, type BrowserChromeState } from "../src/shared/browser-chrome";
import { initialPageDriving, reducePageDriving } from "../src/shared/page-driver";
import { initialPageTabs, reducePageTabs } from "../src/shared/page-tabs";
import { BrowserChrome } from "../src/renderer/components/browser/BrowserChrome";

const held = reducePageDriving(initialPageDriving, { kind: "take-over", at: 1 });
const loaded = (() => {
  const done = reducePageTabs(initialPageTabs("https://example.com/"), { kind: "loading", tab: "t1" as never, loading: false });
  if (!done.ok) throw new Error("loading");
  return done.state;
})();

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const mount = async (state: BrowserChromeState) => {
  const onCommand = vi.fn(async () => ({ ok: true as const }));
  await act(async () => {
    root.render(<BrowserChrome state={state} now={0} seatName={() => undefined} onCommand={onCommand} onFocusPage={() => undefined} />);
  });
  return onCommand;
};

describe("the takeover notice in the chrome", () => {
  it("shows main's line on a noticed tab, and Reload runs the operator's reload", async () => {
    const onCommand = await mount({ tabs: loaded, driving: held, seatCode: { tabs: [loaded.active], message: SEAT_CODE_NOTICE, at: 1 } });
    const line = host.querySelector('[data-testid="browser-chrome-seat-code"]');
    expect(line?.textContent).toContain(SEAT_CODE_NOTICE);
    expect(line?.getAttribute("role")).toBe("status");
    const reload = [...line!.querySelectorAll("button")].find((button) => button.textContent === "Reload")!;
    await act(async () => reload.click());
    expect(onCommand).toHaveBeenCalledWith({ kind: "traverse", step: "reload" });
  });

  it("draws nothing on another tab, or when main names none", async () => {
    await mount({ tabs: loaded, driving: held, seatCode: { tabs: ["t9" as never], message: SEAT_CODE_NOTICE, at: 1 } });
    expect(host.querySelector('[data-testid="browser-chrome-seat-code"]')).toBeNull();
    await mount({ tabs: loaded, driving: held });
    expect(host.querySelector('[data-testid="browser-chrome-seat-code"]')).toBeNull();
  });

  it("keeps the copy law: no middle dot", () => {
    expect(SEAT_CODE_NOTICE).not.toContain("·");
  });
});
