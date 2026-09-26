// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/renderer/lib/theme-mode", async () => {
  const { observable } = await import("@legendapp/state");
  return { themeMode$: observable<"dark" | "bright">("dark") };
});

const { PortraitEditButton } = await import("../src/renderer/components/portrait/PortraitEditor");
const { portraitOverrides$ } = await import("../src/renderer/lib/portrait-overrides-state");
const { normalizePortraitOverride } = await import("../src/shared/portrait-overrides");
const { installCosmeticPacks } = await import("../src/shared/cosmetics/catalog");
const { decodeCosmeticPacks } = await import("../src/shared/cosmetics/load");

let host: HTMLDivElement;
let root: Root;
const patches: unknown[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  patches.length = 0;
  portraitOverrides$.set({});
  // The main-process store: normalizes and echoes the stored override.
  (window as unknown as { junto: unknown }).junto = {
    portraitOverrideSet: async (seatId: string, override: unknown) => {
      patches.push({ seatId, override });
      return { ok: true, seatId, override: override === null ? null : normalizePortraitOverride(override) };
    },
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const open = (): HTMLElement => {
  act(() => root.render(<PortraitEditButton identity="seat-1" name="planner" harness="claude" />));
  act(() => (host.querySelector('[data-testid="portrait-edit-button"]') as HTMLButtonElement).click());
  const editor = document.querySelector('[data-testid="portrait-editor"]');
  if (!(editor instanceof HTMLElement)) throw new Error("editor did not open");
  return editor;
};

const settle = async (): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(300);
    await Promise.resolve();
  });
};

// Every option is a live thumbnail; under a loaded machine a full editor
// render takes a few seconds in jsdom.
describe("portrait editor", { timeout: 30_000 }, () => {
  it("opens from the portrait with every trait grid and a mood strip", () => {
    const editor = open();
    for (const label of ["color", "body", "ears and toppers", "hats and props", "eyes", "brows", "mouth", "pattern", "accent"]) {
      expect(editor.querySelector(`[role="radiogroup"][aria-label="${label}"]`)).not.toBeNull();
    }
    expect(editor.querySelectorAll(".portrait-editor__moods figure")).toHaveLength(6);
    expect(editor.querySelectorAll('[role="radio"][aria-checked="true"]').length).toBe(9);
  });

  it("saves a picked option for the seat and resets to identity", async () => {
    const editor = open();
    act(() => (editor.querySelector('[aria-label="body Toast"]') as HTMLButtonElement).click());
    await settle();
    expect(portraitOverrides$.peek()["seat-1"]).toEqual({ shape: "toast" });
    expect(editor.querySelector('[aria-label="body Toast"]')?.getAttribute("aria-checked")).toBe("true");

    const reset = [...editor.querySelectorAll("button")].find((button) => button.textContent === "Reset");
    act(() => reset?.click());
    await settle();
    expect(patches.at(-1)).toEqual({ seatId: "seat-1", override: null });
    expect(portraitOverrides$.peek()["seat-1"]).toBeUndefined();
  });

  it("moves temperament and randomizes within the offered options", async () => {
    const editor = open();
    const slider = editor.querySelector('input[type="range"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(slider, "-0.8");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    expect(portraitOverrides$.peek()["seat-1"]?.temperament).toBe(-0.8);
    expect(editor.textContent).toContain("moody");

    const randomize = [...editor.querySelectorAll("button")].find((button) => button.textContent === "Randomize");
    act(() => randomize?.click());
    await settle();
    const saved = portraitOverrides$.peek()["seat-1"];
    expect(saved?.shape).toBeDefined();
    expect(saved?.eyes).toBeDefined();
  });

  it("groups bundled pack items under their pack and saves the pack key", async () => {
    installCosmeticPacks(
      decodeCosmeticPacks([
        {
          format: 1,
          id: "test-pack",
          name: "Test pack",
          tier: "premium",
          accessories: [
            {
              id: "top-hat",
              name: "Top hat",
              hat: true,
              parts: [{ layer: "hat", anchor: { x: "center", y: "top" }, shapes: [{ kind: "circle", cx: 0, cy: -6, r: 6, paint: "inked", color: "ink" }] }],
            },
          ],
        },
      ]),
    );
    try {
      const editor = open();
      const props = editor.querySelector('[role="radiogroup"][aria-label="hats and props"]');
      expect(props?.querySelector('[data-pack="premium"] .portrait-editor__pack-head')?.textContent).toContain("Test pack");
      act(() => (props?.querySelector('[aria-label="hats and props Top hat"]') as HTMLButtonElement).click());
      await settle();
      expect(portraitOverrides$.peek()["seat-1"]).toEqual({ accessory: "test-pack:top-hat" });
    } finally {
      installCosmeticPacks([]);
    }
  });
});
