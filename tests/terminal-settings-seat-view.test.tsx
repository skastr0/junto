// @vitest-environment jsdom
/**
 * Settings → Terminal → Seat opens on: the row writes the choice through
 * settingsPatch and shows what landed.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySettingsPatch,
  defaultSettings,
  seatOpenView,
  type SettingsPatch,
} from "@shared/settings";
import { TerminalSettingsSection } from "../src/window/components/settings/TerminalSettingsSection";
import { state$ } from "../src/window/lib/state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let patches: SettingsPatch[];

beforeEach(() => {
  patches = [];
  (window as unknown as { junto: unknown }).junto = {
    settingsPatch: async (patch: SettingsPatch) => {
      patches.push(patch);
      return { ok: true, settings: applySettingsPatch(state$.settings.get() ?? defaultSettings(), patch) };
    },
  };
  state$.settings.set(defaultSettings());
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<TerminalSettingsSection />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  state$.settings.set(defaultSettings());
  delete (window as unknown as { junto?: unknown }).junto;
});

const click = async (element: Element | null | undefined): Promise<void> => {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

const trigger = (): HTMLButtonElement =>
  host.querySelector<HTMLButtonElement>('button[aria-label="Seat opens on"]')!;

const pick = async (label: string): Promise<void> => {
  await click(trigger());
  const options = [...document.querySelectorAll('[role="option"]')];
  expect(options.map((option) => option.textContent)).toEqual(["Terminal", "Threads"]);
  await click(options.find((option) => option.textContent === label));
};

describe("seat opens on", () => {
  it("writes threads, then terminal, and shows what landed", async () => {
    expect(trigger().textContent).toBe("Terminal");

    await pick("Threads");
    expect(patches).toEqual([{ terminal: { seatOpenView: "threads" } }]);
    expect(seatOpenView(state$.settings.get())).toBe("threads");
    expect(trigger().textContent).toBe("Threads");

    await pick("Terminal");
    expect(patches.at(-1)).toEqual({ terminal: { seatOpenView: "terminal" } });
    expect(seatOpenView(state$.settings.get())).toBe("terminal");
    expect(trigger().textContent).toBe("Terminal");
  });
});
