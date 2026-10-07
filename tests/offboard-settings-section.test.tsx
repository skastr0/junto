// @vitest-environment jsdom
/**
 * Settings -> Offboard: a change is saved when it is entered, unless it
 * would break the order the cache window sets; then nothing is saved and the
 * section says why.
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

describe("the offboard rules in Settings", () => {
  it("shows the defaults: a 60 minute window, the nudge off at 40, auto offboard on at 120", () => {
    expect(field("offboard-cache-window").value).toBe("60");
    expect(field("offboard-nudge-minutes").value).toBe("40");
    expect(field("offboard-nudge-on").checked).toBe(false);
    expect(field("offboard-auto-minutes").value).toBe("120");
    expect(field("offboard-auto-on").checked).toBe(true);
    expect(host.querySelector('[data-testid="offboard-settings-problem"]')).toBeNull();
  });

  it("saves a change that keeps the order", async () => {
    await enter("offboard-nudge-minutes", "30");
    expect(patchSettings).toHaveBeenCalledWith({ offboard: { nudge: { minutes: 30 } } });
    expect(host.querySelector('[data-testid="offboard-settings-problem"]')).toBeNull();
  });

  it("does not save a nudge at the window: it says why and shows the stored value again", async () => {
    await enter("offboard-nudge-minutes", "60");
    expect(patchSettings).not.toHaveBeenCalled();
    const problem = host.querySelector('[data-testid="offboard-settings-problem"]');
    expect(problem?.getAttribute("role")).toBe("alert");
    expect(problem?.textContent).toMatch(/^Not saved\. The idle nudge must come before the cache window \(60 min\)/u);
    expect(field("offboard-nudge-minutes").value).toBe("40");
  });

  it("does not save an auto offboard inside the window, nor a window that would strand a rule", async () => {
    await enter("offboard-auto-minutes", "45");
    expect(host.querySelector('[data-testid="offboard-settings-problem"]')?.textContent).toContain(
      "The auto offboard must come at or after the cache window",
    );
    await enter("offboard-cache-window", "30");
    expect(host.querySelector('[data-testid="offboard-settings-problem"]')?.textContent).toContain("The idle nudge must come before");
    expect(patchSettings).not.toHaveBeenCalled();
  });

  it("ignores a value that is not whole minutes", async () => {
    await enter("offboard-cache-window", "2.5");
    expect(patchSettings).not.toHaveBeenCalled();
    expect(field("offboard-cache-window").value).toBe("60");
  });

  it("shows the worth-cutting thresholds: 30 minutes of work, 200,000 tokens", () => {
    expect(field("offboard-worth-work").value).toBe("30");
    expect(field("offboard-worth-tokens").value).toBe("200000");
  });

  it("saves a threshold, and ignores a size outside 1,000 to 100,000,000", async () => {
    await enter("offboard-worth-work", "45");
    expect(patchSettings).toHaveBeenLastCalledWith({ offboard: { worth: { workMinutes: 45 } } });
    await enter("offboard-worth-tokens", "350000");
    expect(patchSettings).toHaveBeenLastCalledWith({ offboard: { worth: { tokens: 350_000 } } });
    patchSettings.mockClear();
    await enter("offboard-worth-tokens", "500");
    expect(patchSettings).not.toHaveBeenCalled();
    expect(field("offboard-worth-tokens").value).toBe("200000");
  });

  it("turns a rule on or off with its switch", async () => {
    await act(async () => {
      field("offboard-auto-on").click();
    });
    expect(patchSettings).toHaveBeenCalledWith({ offboard: { auto: { enabled: false } } });
    await act(async () => {
      field("offboard-nudge-on").click();
    });
    expect(patchSettings).toHaveBeenLastCalledWith({ offboard: { nudge: { enabled: true } } });
  });

  it("a saved good change clears an earlier problem", async () => {
    await enter("offboard-nudge-minutes", "60");
    expect(host.querySelector('[data-testid="offboard-settings-problem"]')).not.toBeNull();
    await enter("offboard-nudge-minutes", "20");
    expect(host.querySelector('[data-testid="offboard-settings-problem"]')).toBeNull();
  });
});

describe("a harness with its own rules", () => {
  beforeEach(async () => {
    state$.settings.set({
      ...defaultSettings(),
      offboard: {
        cacheWindowMinutes: 60,
        auto: { enabled: true, minutes: 120 },
        nudge: { enabled: false, minutes: 40 },
        harness: { codex: { cacheWindowMinutes: 30, auto: { enabled: true, minutes: 90 }, nudge: { enabled: false, minutes: 20 } } },
      },
    });
    await act(async () => {});
  });

  it("shows that harness's window, and each rule's switch and minutes", () => {
    const row = host.querySelector('[data-testid="offboard-harness-codex"]')!;
    expect(row.textContent).toContain("Codex");
    expect(Array.from(row.querySelectorAll<HTMLInputElement>('input[type="number"]')).map((input) => input.value)).toEqual(["30", "20", "90", "30", "200000"]);
    expect(field("offboard-harness-codex-nudge-on").checked).toBe(false);
    expect(field("offboard-harness-codex-auto-on").checked).toBe(true);
  });

  it("turns a rule on or off for that harness only", async () => {
    await act(async () => {
      field("offboard-harness-codex-auto-on").click();
    });
    expect(patchSettings).toHaveBeenLastCalledWith({ offboard: { harness: { codex: { auto: { enabled: false } } } } });
    await act(async () => {
      field("offboard-harness-codex-nudge-on").click();
    });
    expect(patchSettings).toHaveBeenLastCalledWith({ offboard: { harness: { codex: { nudge: { enabled: true } } } } });
  });

  it("removes the harness's row, back to the installation's rules", async () => {
    const remove = host.querySelector<HTMLButtonElement>('[aria-label="Remove the Codex override"]')!;
    await act(async () => {
      remove.click();
    });
    expect(patchSettings).toHaveBeenLastCalledWith({ offboard: { harness: { codex: null } } });
  });
});
