// @vitest-environment jsdom
/**
 * Focus modal chrome: every control in a modal's top bar is clickable, a
 * TwoPane sidebar collapses, and a modal that can grow has a maximize toggle.
 *
 * The click bug (0.10.1): the station bar is a window drag region on darwin,
 * and Electron's drag regions ignore z-index. A focus panel's header sits
 * inside the bar's 64px, so each press on it became a window drag. The panel
 * must cut itself out of the drag, and nothing else may be made a drag region
 * that could sit under a modal.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FocusWindowContext } from "../src/renderer/components/ui/FocusWindow";
import { OverlayHeader } from "../src/renderer/components/ui/OverlayHeader";
import { PaneHeader, TwoPane } from "../src/renderer/components/ui/TwoPane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const root = resolve(__dirname, "..");
const css = readFileSync(join(root, "src/renderer/styles.css"), "utf8");

/** Every rule whose declarations set the app region, as selector list -> value. */
const appRegions = (sheet: string): Array<{ selectors: string[]; value: string }> =>
  [...sheet.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*-webkit-app-region:\s*([\w-]+)[^{}]*)\}/g)].map((m) => ({
    selectors: m[1]!.split(",").map((s) => s.trim()),
    value: m[3]!,
  }));

describe("focus modal chrome: the top bar never eats a click", () => {
  it("the panel and its rail are no-drag on darwin", () => {
    const noDrag = appRegions(css).filter((r) => r.value === "no-drag").flatMap((r) => r.selectors);
    expect(noDrag).toContain('html[data-junto-platform="darwin"] .focus-surface__panel');
    expect(noDrag).toContain('html[data-junto-platform="darwin"] .focus-surface__aside');
  });

  it("the station bar stays the only drag region", () => {
    const drag = appRegions(css).filter((r) => r.value === "drag").flatMap((r) => r.selectors);
    expect(drag).toEqual(['html[data-junto-platform="darwin"] .station-bar']);
  });

  it("no component stylesheet or inline style makes another drag region", () => {
    for (const rel of ["src/renderer/components/UsageHud.css"]) {
      expect(appRegions(readFileSync(join(root, rel), "utf8")).filter((r) => r.value === "drag")).toEqual([]);
    }
  });
});

describe("focus modal chrome: maximize and sidebar collapse", () => {
  let host: HTMLDivElement;
  let reactRoot: Root;
  let toggles = 0;

  const render = (node: React.ReactNode): void => {
    act(() => reactRoot.render(node));
  };
  /** The first control of that name that is showing: a collapsed sidebar keeps its own, hidden. */
  const button = (name: string): HTMLButtonElement | null =>
    [...host.querySelectorAll<HTMLButtonElement>(`button[aria-label="${name}"]`)].find((b) => b.closest("[hidden]") === null) ??
    null;

  beforeEach(() => {
    toggles = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    reactRoot = createRoot(host);
  });
  afterEach(() => {
    act(() => reactRoot.unmount());
    host.remove();
  });

  const growable = (maximized: boolean) => ({ maximized, toggleMaximized: () => void toggles++ });

  it("an overlay header in a growable modal carries Maximize, ahead of the caller's actions", () => {
    render(
      <FocusWindowContext.Provider value={growable(false)}>
        <OverlayHeader title="Grid" actions={<button aria-label="Close" />} />
      </FocusWindowContext.Provider>,
    );
    const labels = [...host.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Maximize", "Close"]);
    act(() => button("Maximize")!.click());
    expect(toggles).toBe(1);
  });

  it("a maximized modal keeps the name Maximize and says pressed; the tooltip offers Restore", () => {
    render(
      <FocusWindowContext.Provider value={growable(true)}>
        <OverlayHeader title="Grid" />
      </FocusWindowContext.Provider>,
    );
    expect(button("Maximize")?.getAttribute("aria-pressed")).toBe("true");
    expect(button("Maximize")?.title).toBe("Restore size");
  });

  it("outside a modal that can grow, a header has no Maximize", () => {
    render(<OverlayHeader title="Seat" actions={<button aria-label="Close" />} />);
    expect(button("Maximize")).toBeNull();
    expect(button("Close")).not.toBeNull();
  });

  it("the sidebar collapses to a strip that keeps Expand, and keeps its state mounted", () => {
    render(
      <TwoPane
        sidebarLabel="Lock test sidebar"
        mainLabel="Main"
        sidebar={
          <>
            <PaneHeader eyebrow="Things" actions={<button aria-label="New thing" />} />
            <input aria-label="Search things" />
          </>
        }
      >
        <p>main</p>
      </TwoPane>,
    );
    const pane = host.querySelector<HTMLElement>(".two-pane")!;
    expect(pane.dataset.sidebar).toBeUndefined();
    const field = host.querySelector("input")!;

    act(() => button("Sidebar")!.click());
    expect(pane.dataset.sidebar).toBe("collapsed");
    expect(host.querySelector(".two-pane__sidebar-body")!.hasAttribute("hidden")).toBe(true);
    expect(host.querySelector("input")).toBe(field);
    expect(button("Sidebar")?.getAttribute("aria-expanded")).toBe("false");
    expect(button("Sidebar")?.title).toBe("Expand sidebar");

    act(() => button("Sidebar")!.click());
    expect(pane.dataset.sidebar).toBeUndefined();
    expect(button("Sidebar")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("a collapsed sidebar stays collapsed when the pane remounts", () => {
    const pane = (key: string) => (
      <TwoPane key={key} sidebarLabel="Remount sidebar" mainLabel="Main" sidebar={<PaneHeader eyebrow="Things" />}>
        <p>main</p>
      </TwoPane>
    );
    render(pane("a"));
    act(() => button("Sidebar")!.click());
    render(pane("b"));
    expect(host.querySelector<HTMLElement>(".two-pane")!.dataset.sidebar).toBe("collapsed");
  });

  it("the sidebar header and the strip both carry Maximize inside a growable modal", () => {
    render(
      <FocusWindowContext.Provider value={growable(false)}>
        <TwoPane sidebarLabel="Maximize sidebar" mainLabel="Main" sidebar={<PaneHeader eyebrow="Things" />}>
          <p>main</p>
        </TwoPane>
      </FocusWindowContext.Provider>,
    );
    expect(button("Maximize")).not.toBeNull();
    act(() => button("Sidebar")!.click());
    const strip = [...host.querySelectorAll(".two-pane__strip button")].map((b) => b.getAttribute("aria-label"));
    expect(strip).toEqual(["Maximize", "Sidebar"]);
  });

  it("the sidebar toggle's twin takes the keyboard after each switch", () => {
    render(
      <TwoPane sidebarLabel="Focus handoff sidebar" mainLabel="Main" sidebar={<PaneHeader eyebrow="Things" />}>
        <p>main</p>
      </TwoPane>,
    );
    const press = (): void => act(() => button("Sidebar")!.click());
    press();
    expect(document.activeElement).toBe(button("Sidebar"));
    expect(document.activeElement?.closest(".two-pane__strip")).not.toBeNull();
    press();
    expect(document.activeElement).toBe(button("Sidebar"));
    expect(document.activeElement?.closest(".two-pane__strip")).toBeNull();
  });

  it("the maximized panel is sized by flex basis, so a remembered inline width cannot hold it", () => {
    expect(css).toMatch(
      /\.focus-surface\[data-maximized="true"\] \.focus-surface__panel \{[^}]*flex: 1 1 0%;[^}]*max-width: none !important;/,
    );
  });
});
