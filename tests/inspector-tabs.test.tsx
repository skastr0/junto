// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { InspectorTabs } = await import("../src/renderer/components/ui/InspectorTabs");

let root: Root;
let host: HTMLDivElement;

const TABS = [
  { id: "look", label: "look" },
  { id: "mood", label: "mood" },
];

const size = (el: HTMLElement, scrollWidth: number, clientWidth: number, scrollLeft = 0): void => {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: scrollWidth });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: clientWidth });
  el.scrollLeft = scrollLeft;
};

const row = (): HTMLElement => document.querySelector<HTMLElement>('[role="tablist"]')!;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the inspector tab row", () => {
  it("wears the house focus ring and keeps each tab on one line", async () => {
    await act(async () => root.render(<InspectorTabs tabs={TABS} active="look" onSelect={() => undefined} />));
    const tab = document.querySelector<HTMLElement>('[role="tab"]')!;
    expect(tab.className).toContain("whitespace-nowrap");
    expect(tab.className).toContain("focus-visible:shadow-[inset_0_0_0_2px_var(--color-cyan)]");
    expect(tab.className).toContain("outline-none");
  });

  it("fades only the edge that has more behind it, and not at all when the row fits", async () => {
    await act(async () => root.render(<InspectorTabs tabs={TABS} active="look" onSelect={() => undefined} />));
    const el = row();
    // Fits: no mask.
    size(el, 530, 530);
    await act(async () => void el.dispatchEvent(new Event("scroll")));
    expect(el.style.maskImage).toBe("");
    // Cut at the end: the end fades.
    size(el, 542, 530, 0);
    await act(async () => void el.dispatchEvent(new Event("scroll")));
    expect(el.style.maskImage).toContain("transparent");
    expect(el.style.maskImage).not.toMatch(/^linear-gradient\(to right, transparent/);
    // Scrolled to the end: only the start fades.
    size(el, 542, 530, 12);
    await act(async () => void el.dispatchEvent(new Event("scroll")));
    expect(el.style.maskImage).toMatch(/^linear-gradient\(to right, transparent/);
    expect(el.style.maskImage).not.toContain("calc(100%");
  });
});
