// @vitest-environment jsdom
/**
 * A canvas menu closes on Escape even when another Escape listener, earlier
 * on the window, re-renders the menu's owner during the same keypress.
 *
 * That is what happens in the app: with a seat selected and the keyboard
 * outside the menu, App's Escape listener clears the selection first, the
 * canvas re-renders at once, and the menu is handed a new `onClose`. A
 * dismiss hook that re-subscribes for every new callback takes its listener
 * off the window in the middle of the keypress, and the browser never calls
 * a listener removed during dispatch: the selection went and the menu stayed
 * (automation-lead's walk F, step 2, on d0c9bbbd0).
 */
import { act, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useMenuDismiss } from "../src/renderer/lib/menu-dismiss";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Menu({ onClose }: { readonly onClose: () => void }) {
  useMenuDismiss(true, onClose);
  return (
    <div data-canvas-menu-surface data-testid="menu">
      <button>row</button>
    </div>
  );
}

/** Owns the menu like Canvas does: an inline close callback, new on every render. */
let clearSelection: () => void = () => undefined;
function Owner() {
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState(true);
  clearSelection = () => setSelected(false);
  return (
    <div data-selected={selected ? "true" : "false"} data-testid="owner">
      {open ? <Menu onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

let host: HTMLDivElement;
let root: Root;
let appEscape: (event: KeyboardEvent) => void;

beforeEach(() => {
  // App's listener is on the window before any menu opens.
  appEscape = (event) => {
    if (event.key !== "Escape") return;
    // React renders a state change made in a keydown listener before the
    // next listener runs; flushSync stands in for that here.
    flushSync(() => clearSelection());
  };
  window.addEventListener("keydown", appEscape);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Owner />));
});

afterEach(() => {
  window.removeEventListener("keydown", appEscape);
  act(() => root.unmount());
  host.remove();
});

const menu = () => host.querySelector('[data-testid="menu"]');
const owner = () => host.querySelector('[data-testid="owner"]')!;

describe("closing a canvas menu", () => {
  it("Escape closes it although the selection was cleared, and the owner re-rendered, in the same keypress", () => {
    expect(menu()).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(owner().getAttribute("data-selected")).toBe("false");
    expect(menu()).toBeNull();
  });

  it("a press outside closes it; a press on the menu does not", () => {
    act(() => {
      menu()!.querySelector("button")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(menu()).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(menu()).toBeNull();
  });

  it("another key leaves it open", () => {
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    });
    expect(menu()).not.toBeNull();
  });
});
