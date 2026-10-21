// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserChromeState } from "../src/shared/browser-chrome";
import { initialPageDriving } from "../src/shared/page-driver";
import { initialPageTabs, reducePageTabs, type PageTabs } from "../src/shared/page-tabs";
import { BrowserChrome } from "../src/renderer/components/browser/BrowserChrome";
import { runPageChromeKey } from "../src/renderer/lib/page-chrome-keys";
import type { ChromeCommand } from "../src/renderer/lib/browser-chrome-source";

let host: HTMLDivElement;
let root: Root;

const open = (tabs: PageTabs, url: string): PageTabs => {
  const result = reducePageTabs(tabs, { kind: "open", url, activate: false });
  if (!result.ok) throw new Error("open");
  return result.state;
};
const three = open(open(initialPageTabs("https://a.example.com/"), "https://b.example.com/"), "https://c.example.com/");

const mount = async (tabs: PageTabs, commands: ChromeCommand[], focusPage = vi.fn()) => {
  const state: BrowserChromeState = { tabs, driving: initialPageDriving };
  await act(async () => {
    root.render(
      <BrowserChrome
        state={state}
        now={0}
        seatName={() => undefined}
        controls="surface"
        onFocusPage={focusPage}
        onCommand={async (command) => {
          commands.push(command);
          return { ok: true };
        }}
      />,
    );
  });
  return focusPage;
};
const tabButtons = (): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const key = async (target: Element, init: KeyboardEventInit) => {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
};

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

describe("tab strip keys (manual activation)", () => {
  it("has one tab stop, on the active tab, and every tab controls the surface", async () => {
    await mount(three, []);
    const tabs = tabButtons();
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    expect(tabs.every((tab) => tab.getAttribute("aria-controls") === "surface")).toBe(true);
  });

  it("moves focus with Right, Left (wrapping), Home and End, and activates nothing", async () => {
    const commands: ChromeCommand[] = [];
    await mount(three, commands);
    const tabs = tabButtons();
    tabs[0]!.focus();
    await key(tabs[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[1]);
    await key(tabs[1]!, { key: "End" });
    expect(document.activeElement).toBe(tabs[2]);
    await key(tabs[2]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[0]);
    await key(tabs[0]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tabs[2]);
    await key(tabs[2]!, { key: "Home" });
    expect(document.activeElement).toBe(tabs[0]);
    expect(commands).toEqual([]);
  });

  it("activates on click, which Enter and Space make on a button", async () => {
    const commands: ChromeCommand[] = [];
    await mount(three, commands);
    await act(async () => tabButtons()[1]!.click());
    expect(commands).toEqual([{ kind: "activateTab", tab: "t2" }]);
  });

  it("closes the focused tab on Delete and puts focus where it was, but never closes the last tab", async () => {
    const commands: ChromeCommand[] = [];
    await mount(three, commands);
    const tabs = tabButtons();
    tabs[1]!.focus();
    await key(tabs[1]!, { key: "Delete" });
    expect(commands).toEqual([{ kind: "closeTab", tab: "t2" }]);
    const closed = reducePageTabs(three, { kind: "close", tab: "t2" as never });
    if (!closed.ok) throw new Error("close");
    await mount(closed.state, commands);
    expect(document.activeElement).toBe(tabButtons()[1]);
    expect(tabButtons()).toHaveLength(2);
    const last = initialPageTabs("https://a.example.com/");
    const before = commands.length;
    await mount(last, commands);
    await key(tabButtons()[0]!, { key: "Delete" });
    expect(commands).toHaveLength(before);
  });

  it("keeps the close buttons out of the tab order", async () => {
    await mount(three, []);
    const closes = [...host.querySelectorAll<HTMLButtonElement>('button[aria-label^="Close "]')];
    expect(closes).toHaveLength(3);
    expect(closes.every((button) => button.tabIndex === -1)).toBe(true);
  });
});

describe("address bar keys", () => {
  const input = () => host.querySelector<HTMLInputElement>('input[aria-label="Address"]')!;
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("Escape puts the page's address back and sends focus to the page, and stops there", async () => {
    const focusPage = await mount(three, []);
    await type("typed.example.org");
    expect(input().value).toBe("typed.example.org");
    const seen = vi.fn();
    document.addEventListener("keydown", seen);
    await key(input(), { key: "Escape" });
    document.removeEventListener("keydown", seen);
    expect(input().value).toBe("https://a.example.com/");
    expect(focusPage).toHaveBeenCalledOnce();
    expect(seen).not.toHaveBeenCalled();
  });

  it("Enter goes to the address, then focus goes to the page", async () => {
    const commands: ChromeCommand[] = [];
    const focusPage = await mount(three, commands);
    await type("docs.example.com/guide");
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(commands).toEqual([{ kind: "goto", url: "https://docs.example.com/guide" }]);
    expect(focusPage).toHaveBeenCalledOnce();
  });

  it("a refused address stays in the bar and focus stays put", async () => {
    const commands: ChromeCommand[] = [];
    const focusPage = await mount(three, commands);
    await type("localhost:3000");
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(commands).toEqual([]);
    expect(focusPage).not.toHaveBeenCalled();
  });
});

describe("the page's keys (Cmd+L, Cmd+R) while the chrome shows", () => {
  it("Cmd+L focuses the address field with its address selected, Cmd+R reloads, and both pass once the chrome is gone", async () => {
    const commands: ChromeCommand[] = [];
    await mount(three, commands);
    expect(runPageChromeKey("address")).toBe(true);
    const field = host.querySelector<HTMLInputElement>('input[aria-label="Address"]')!;
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(field.value.length);
    expect(runPageChromeKey("reload")).toBe(true);
    expect(commands).toEqual([{ kind: "traverse", step: "reload" }]);
    await act(async () => root.render(<div />));
    expect(runPageChromeKey("address")).toBe(false);
    expect(runPageChromeKey("reload")).toBe(false);
  });
});

describe("the Reload and Stop slot", () => {
  it("sends stop while loading and reload otherwise, from the same button", async () => {
    const commands: ChromeCommand[] = [];
    await mount(initialPageTabs("https://example.com/"), commands);
    const slot = () => host.querySelector<HTMLButtonElement>('[data-testid="browser-reload-stop"]')!;
    const first = slot();
    await act(async () => first.click());
    expect(commands).toEqual([{ kind: "traverse", step: "stop" }]);
    const done = reducePageTabs(initialPageTabs("https://example.com/"), { kind: "loading", tab: "t1" as never, loading: false });
    if (!done.ok) throw new Error("loading");
    await mount(done.state, commands);
    expect(slot()).toBe(first);
    await act(async () => slot().click());
    expect(commands.at(-1)).toEqual({ kind: "traverse", step: "reload" });
  });
});
