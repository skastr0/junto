// @vitest-environment jsdom
/**
 * The limits of a region token are a dialog: it takes the keyboard on open,
 * whether a key or a pointer opened it, and a key that closes it gives the
 * keyboard back to the token. A pointer that closes it leaves focus where the
 * pointer went.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RegionToken } from "../src/window/components/quick-thread/BroadcastParts";
import type { QuickThreadRegion } from "../src/window/lib/quick-thread";
import { resetOperatorGesture } from "../src/window/lib/focus-ownership";
import { resetOverlays } from "../src/window/lib/overlay-open";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

const REGION: QuickThreadRegion = { kind: "region", id: "r", name: "Big", outer: [], seats: 12 };

let host: HTMLDivElement;
let root: Root;

const frames = async (n = 20) => {
  for (let i = 0; i < n; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 16)));
};

const mount = async () => {
  await act(async () =>
    root.render(
      <ul>
        <RegionToken region={REGION} pick={{ regionId: "r", doing: [], needs: [] }} count={12} total={12} countAlone={() => 0} onToggle={() => undefined} onRemove={() => undefined} />
      </ul>,
    ),
  );
};
const token = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>('[data-testid="quick-thread-region-press"]')!;
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"]');

beforeEach(() => {
  resetOperatorGesture();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetOverlays();
});

/** A press as the app hears one: the key, or the pointer, then the click. */
const press = async (how: "key" | "pointer") => {
  act(() => {
    token().focus();
    if (how === "key") token().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    else token().dispatchEvent(new Event("pointerdown", { bubbles: true }));
    token().click();
  });
  await frames();
};

describe("the limits of a region token", () => {
  it("take the keyboard to the first chip when a key opens them, and give it back to the token on Escape", async () => {
    await mount();
    await press("key");
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(dialog()!.querySelector('[data-testid="quick-thread-limit"]'));
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await frames();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(token());
  });

  it("give the keyboard back to the token on Escape even when a pointer opened them", async () => {
    await mount();
    await press("pointer");
    expect(document.activeElement).toBe(dialog()!.querySelector('[data-testid="quick-thread-limit"]'));
    act(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await frames();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(token());
  });

  it("take it when a pointer opens them too, and a press outside leaves focus where it went", async () => {
    await mount();
    await press("pointer");
    expect(document.activeElement).toBe(dialog()!.querySelector('[data-testid="quick-thread-limit"]'));
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    act(() => {
      elsewhere.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      elsewhere.focus();
    });
    await frames();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});
