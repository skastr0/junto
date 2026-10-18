// @vitest-environment jsdom
/**
 * Settings -> Offboard: the cache window, for the machine and per harness. A
 * change is saved when it is entered; a value that is not whole minutes in
 * range is not saved.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../src/shared/settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const patchSettings = vi.fn(async (_patch: unknown) => true);
vi.mock("../src/renderer/lib/settings-state", () => ({ patchSettings: (patch: unknown) => patchSettings(patch) }));

const { state$ } = await import("../src/renderer/lib/state");
const { OffboardSettingsSection } = await import("../src/renderer/components/settings/OffboardSettingsSection");

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  patchSettings.mockClear();
  state$.settings.set(defaultSettings());
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<OffboardSettingsSection />));
  await act(async () => {});
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const field = (id: string) => host.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;

/** Type a value into a minutes field and leave it. */
const enter = async (id: string, value: string) => {
  const input = field(id);
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
};

describe("the cache window in Settings", () => {
  it("shows the one setting: a 60 minute window, and no other rule", () => {
    expect(field("offboard-cache-window").value).toBe("60");
    for (const retired of ["offboard-nudge-on", "offboard-nudge-minutes", "offboard-auto-on", "offboard-auto-minutes", "offboard-worth-work", "offboard-worth-tokens"]) {
      expect(host.querySelector(`[data-testid="${retired}"]`)).toBeNull();
    }
    expect(host.textContent).not.toMatch(/nudge|auto offboard|worth/iu);
  });

  it("saves any window in range, shorter or longer than before", async () => {
    await enter("offboard-cache-window", "5");
    expect(patchSettings).toHaveBeenLastCalledWith({ offboard: { cacheWindowMinutes: 5 } });
    await enter("offboard-cache-window", "180");
    expect(patchSettings).toHaveBeenLastCalledWith({ offboard: { cacheWindowMinutes: 180 } });
  });

  it("ignores a value that is not whole minutes in range", async () => {
    for (const value of ["0", "2.5", "10081", "soon"]) await enter("offboard-cache-window", value);
    expect(patchSettings).not.toHaveBeenCalled();
    expect(field("offboard-cache-window").value).toBe("60");
  });
});

describe("a harness with its own window", () => {
  beforeEach(async () => {
    state$.settings.set({
      ...defaultSettings(),
      offboard: { cacheWindowMinutes: 60, harness: { codex: { cacheWindowMinutes: 30 } } },
    });
    await act(async () => {});
  });

  it("shows that harness's window", () => {
    const row = host.querySelector('[data-testid="offboard-harness-codex"]')!;
    expect(row.textContent).toContain("Codex");
    expect(Array.from(row.querySelectorAll<HTMLInputElement>('input[type="number"]')).map((input) => input.value)).toEqual(["30"]);
  });

  it("saves that harness's window only", async () => {
    const input = host.querySelector<HTMLInputElement>('[aria-label="Codex cache window, minutes"]')!;
    input.setAttribute("data-testid", "codex-window");
    await enter("codex-window", "10");
    expect(patchSettings).toHaveBeenLastCalledWith({ offboard: { harness: { codex: { cacheWindowMinutes: 10 } } } });
  });

  it("removes the harness's row, back to the machine's window", async () => {
    const remove = host.querySelector<HTMLButtonElement>('[aria-label="Remove the Codex window"]')!;
    await act(async () => {
      remove.click();
    });
    expect(patchSettings).toHaveBeenLastCalledWith({ offboard: { harness: { codex: null } } });
  });
});
