// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { InspectorTabs } = await import("../src/window/components/ui/InspectorTabs");

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

  it("keeps the panel form as it was: a hairline under the row, tabs rounded at the top", async () => {
    await act(async () => root.render(<InspectorTabs tabs={TABS} active="look" onSelect={() => undefined} />));
    expect(row().style.borderBottom).toContain("1px solid");
    expect(row().className).toBe("flex items-end gap-0.5 overflow-x-auto [scrollbar-width:none]");
    const tab = document.querySelector<HTMLElement>('[role="tab"]')!;
    expect(tab.className).toContain("rounded-t-md px-2 py-1.5");
    expect(tab.hasAttribute("aria-controls")).toBe(false);
    expect(tab.hasAttribute("data-testid")).toBe(false);
  });

  it("is one stop in the Tab order: the shown tab, or the first when none is shown", async () => {
    const stops = () => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => tab.tabIndex);
    await act(async () => root.render(<InspectorTabs tabs={TABS} active="mood" onSelect={() => undefined} />));
    expect(stops()).toEqual([-1, 0]);
    await act(async () => root.render(<InspectorTabs tabs={TABS} active="look" onSelect={() => undefined} />));
    expect(stops()).toEqual([0, -1]);
    await act(async () => root.render(<InspectorTabs tabs={TABS} active="gone" onSelect={() => undefined} />));
    expect(stops()).toEqual([0, -1]);
    await act(async () =>
      root.render(<InspectorTabs frame="chrome" tabs={TABS} active="mood" onSelect={() => undefined} />),
    );
    expect(stops()).toEqual([-1, 0]);
  });

  it("walks the row on Left and Right, round the ends, with the keyboard on the tab it shows", async () => {
    const picked: string[] = [];
    const three = [...TABS, { id: "voice", label: "voice" }];
    await act(async () => root.render(<InspectorTabs tabs={three} active="look" onSelect={(id) => picked.push(id)} />));
    const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
    const arrow = async (from: HTMLElement, key: string, more: KeyboardEventInit = {}) => {
      await act(async () => void from.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...more })));
    };
    act(() => tabs[0]!.focus());
    await arrow(tabs[0]!, "ArrowRight");
    expect(picked).toEqual(["mood"]);
    expect(document.activeElement).toBe(tabs[1]);
    await arrow(tabs[0]!, "ArrowLeft");
    expect(picked).toEqual(["mood", "voice"]);
    expect(document.activeElement).toBe(tabs[2]);
    // A chord is someone else's key.
    await arrow(tabs[0]!, "ArrowRight", { metaKey: true });
    expect(picked).toHaveLength(2);
  });
});

describe("the tab row in a header", () => {
  const SEAT_VIEW = [
    { id: "terminal", label: "Terminal" },
    { id: "threads", label: "Threads", badge: 3, title: "Threads, 3 unread" },
  ];
  const render = async (active = "terminal", tabs: ReadonlyArray<{ id: string; label: string; badge?: number; title?: string }> = SEAT_VIEW) =>
    act(async () =>
      root.render(
        <InspectorTabs frame="chrome" label="Seat view" testId="seat-view" controls="stage" tabs={tabs} active={active} onSelect={() => undefined} />,
      ),
    );
  const tab = (id: string) => document.querySelector<HTMLElement>(`[data-testid="seat-view-${id}"]`)!;

  it("is one bordered pill: no hairline, no scroll, no fade", async () => {
    await render();
    const el = row();
    expect(el.getAttribute("aria-label")).toBe("Seat view");
    expect(el.className).toContain("inline-flex");
    expect(el.className).toContain("rounded-sm border border-stroke");
    expect(el.className).not.toContain("overflow");
    expect(el.style.borderBottom).toBe("");
    // A row that would be cut in a panel fades there; here it has no edge to fade.
    size(el, 542, 530, 0);
    await act(async () => void el.dispatchEvent(new Event("scroll")));
    expect(el.style.maskImage).toBe("");
  });

  it("gives each half the xs Button's box, the 24px hit area and the house focus ring", async () => {
    await render();
    for (const id of ["terminal", "threads"]) {
      const half = tab(id);
      expect(half.className).toContain("px-1.5 py-0.5 text-label");
      expect(half.className).toContain("before:h-6");
      expect(half.className).toContain("focus-visible:shadow-[inset_0_0_0_2px_var(--color-cyan)]");
      expect(half.className).not.toContain("rounded-t-md");
      // The pill's radius token, never a bare number.
      expect(half.className).toContain("first:rounded-l-sm last:rounded-r-sm");
      expect(half.className).not.toMatch(/rounded[a-z-]*-\[/);
      expect(half.getAttribute("aria-controls")).toBe("stage");
    }
  });

  it("marks the shown half with a tint and ink, never with an edge", async () => {
    await render("threads");
    expect(tab("threads").getAttribute("aria-selected")).toBe("true");
    expect(tab("threads").style.background).not.toBe("");
    expect(tab("terminal").getAttribute("aria-selected")).toBe("false");
    expect(tab("terminal").style.background).toBe("");
    expect(tab("terminal").className).toContain("hover:bg-ink/10");
    for (const id of ["terminal", "threads"]) {
      const half = tab(id);
      expect(half.className).not.toMatch(/border-[blrt]\b|border-[blrt]-/);
      expect(half.style.border).toBe("");
      expect(half.style.borderBottom).toBe("");
      expect(half.style.boxShadow).toBe("");
    }
  });

  it("draws what waits as the unread pill, capped at 99+, and nothing at zero", async () => {
    await render();
    const pill = tab("threads").querySelector("span")!;
    expect(pill.textContent).toBe("3");
    expect(pill.className).toContain("rounded-full");
    expect(pill.className).toContain("font-mono");
    // A minimum width only: the pill never makes its half taller.
    expect(pill.className).toContain("min-w-");
    expect(pill.className).not.toMatch(/(^|\s)h-/);
    expect(tab("threads").getAttribute("title")).toBe("Threads, 3 unread");
    expect(tab("terminal").querySelector("span")).toBeNull();
    // The tab is named with what the pill counts, so the pill is for the eye
    // only: a screen reader says "Threads, 3 unread", never "Threads 3".
    expect(tab("threads").getAttribute("aria-label")).toBe("Threads, 3 unread");
    expect(pill.getAttribute("aria-hidden")).toBe("true");
    expect(tab("terminal").hasAttribute("aria-label")).toBe(false);

    // A tab that gives no name keeps its label and its count as what is said.
    await render("terminal", [SEAT_VIEW[0]!, { id: "threads", label: "Threads", badge: 240 }]);
    expect(tab("threads").textContent).toBe("Threads99+");
    expect(tab("threads").hasAttribute("aria-label")).toBe(false);
    expect(tab("threads").querySelector("span")!.hasAttribute("aria-hidden")).toBe(false);
    await render("terminal", [SEAT_VIEW[0]!, { id: "threads", label: "Threads", badge: 0 }]);
    expect(tab("threads").textContent).toBe("Threads");
    expect(tab("threads").hasAttribute("title")).toBe(false);
  });
});
