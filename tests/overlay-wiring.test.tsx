// @vitest-environment jsdom
/**
 * Every overlay that can reach the top bar says so on <html> while it is up
 * (lib/overlay-open.ts) and takes it back when it goes, so the bar is no
 * window drag region under it. Real components, one by one, and a scan so a
 * new floating menu cannot forget to.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Dropdown } from "../src/window/components/ui/Dropdown";
import { HelpMap } from "../src/window/components/ui/HelpMap";
import { Popover } from "../src/window/components/ui/Popover";
import { OperatorModalShell } from "../src/window/components/operator-modal/OperatorModalShell";
import { closeOperatorModal, openOperatorModal } from "../src/window/lib/operator-modal";
import { resetModalStack } from "../src/window/lib/modal-stack";
import { resetOverlays } from "../src/window/lib/overlay-open";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => {};
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

const marked = (): boolean => document.documentElement.getAttribute("data-junto-overlay") === "open";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  act(() => closeOperatorModal());
  resetModalStack();
  resetOverlays();
});

describe("an overlay says it is open while it is up, and takes it back", () => {
  it("an operator modal that covers the bar", async () => {
    act(() => openOperatorModal("search"));
    await act(async () => root.render(<OperatorModalShell id="search" label="A modal"><p>in</p></OperatorModalShell>));
    expect(marked()).toBe(true);
    await act(async () => root.render(<div />));
    expect(marked()).toBe(false);
  });

  it("but not a panel under the bar, which crosses none of it", async () => {
    act(() => openOperatorModal("feed"));
    await act(async () => root.render(<OperatorModalShell id="feed" label="Under" belowBar><p>in</p></OperatorModalShell>));
    expect(marked()).toBe(false);
  });

  it("a popover, and so every menu that renders through it", async () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    await act(async () => root.render(<Popover anchor={anchor} onClose={() => undefined} label="Colour"><p>in</p></Popover>));
    expect(marked()).toBe(true);
    await act(async () => root.render(<div />));
    expect(marked()).toBe(false);
    anchor.remove();
  });

  it("a dropdown's list, only while it is open", async () => {
    await act(async () => root.render(<Dropdown aria-label="Canvas" value="a" options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} onChange={() => undefined} />));
    expect(marked()).toBe(false);
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    expect(marked()).toBe(true);
    await act(async () => root.render(<div />));
    expect(marked()).toBe(false);
  });

  it("a help map shown as a dialog", async () => {
    await act(async () => root.render(<HelpMap title="Help" onClose={() => undefined}><p>keys</p></HelpMap>));
    expect(marked()).toBe(true);
    await act(async () => root.render(<div />));
    expect(marked()).toBe(false);
  });
});

/** Overlays that live inside a surface that already holds it (a modal, a popover, the focus switcher) or inline in the page. */
const INSIDE_ANOTHER_HOLD: ReadonlyArray<string> = [
  // Inline lists drawn in the page's own flow, not floating over it.
  "components/RegionPathsModal.tsx",
  "components/SettingsPanel.tsx",
  "components/rts/ConnectEditor.tsx",
  "components/machines/MachinesWindow.tsx",
  "components/git/GitDetail.tsx",
  "components/feed/ThreadsModal.tsx",
  "components/feed/OperatorFeed.tsx",
  "components/ui/Combobox.tsx",
  "components/command-bar/CommandBar.tsx",
  // Their window is a modal on the stack.
  "components/quick-open/QuickOpen.tsx",
  "components/FocusSwitcherHud.tsx",
  "components/FocusSurface.tsx",
  "components/operator-modal/OperatorModalShell.tsx",
  // The popover is the menu's own shell (colour, artifact move).
  "components/artifacts/LabelColourMenu.tsx",
  "components/artifacts/ArtifactMove.tsx",
  // The lists and the listbox helper themselves.
  "lib/listbox-aria.ts",
  "components/node-palette/AgentHarnessPick.tsx",
  // A hover card, not a menu or a dialog: nothing is pressed on it, so a press under it never needs the bar's drag taken away.
  "components/nodes/SeatCacheStatus.tsx",
];

const sources = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((item) =>
    item.isDirectory() ? sources(join(dir, item.name)) : /\.(tsx|ts)$/.test(item.name) ? [join(dir, item.name)] : [],
  );

describe("a new floating menu or dialog cannot forget to say it is open", () => {
  const base = join(__dirname, "..", "src", "window");
  const floating = sources(base)
    .map((path) => [path.slice(base.length + 1), readFileSync(path, "utf8")] as const)
    // A role that names a menu or a dialog the file draws (not one it only looks for), or the layer popovers render in.
    .filter(([, text]) => /\brole="(menu|dialog)"|data-layer="popover"/.test(text));

  it("holds the overlay, or sits in a surface that does", () => {
    const unheld = floating
      .filter(([file, text]) => !/useOverlayHold\(|useModalLayer\(|holdOverlay\(/.test(text) && !INSIDE_ANOTHER_HOLD.includes(file))
      .map(([file]) => file);
    expect(unheld, "each of these draws a menu or dialog with no hold: call useOverlayHold, or list it with its reason").toEqual([]);
  });

  it("lists nothing that no longer exists or no longer draws one", () => {
    const names = new Set(floating.map(([file]) => file));
    const stale = INSIDE_ANOTHER_HOLD.filter((file) => !names.has(file) && !/(listbox|aria)/.test(file) && !readFileSync(join(base, file), "utf8").includes("listbox"));
    expect(stale).toEqual([]);
  });
});
