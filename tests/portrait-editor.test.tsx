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

describe("portrait editor", () => {
  it("opens from the portrait with every trait grid and a mood strip", () => {
    const editor = open();
    for (const label of ["color", "body", "ears and toppers", "eyes", "brows", "mouth", "pattern", "accent"]) {
      expect(editor.querySelector(`[role="radiogroup"][aria-label="${label}"]`)).not.toBeNull();
    }
    expect(editor.querySelectorAll(".portrait-editor__moods figure")).toHaveLength(6);
    expect(editor.querySelectorAll('[role="radio"][aria-checked="true"]').length).toBe(8);
  });

  it("saves a picked option for the seat and resets to identity", async () => {
    const editor = open();
    act(() => (editor.querySelector('[aria-label="body toast"]') as HTMLButtonElement).click());
    await settle();
    expect(portraitOverrides$.peek()["seat-1"]).toEqual({ shape: "toast" });
    expect(editor.querySelector('[aria-label="body toast"]')?.getAttribute("aria-checked")).toBe("true");

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
});
