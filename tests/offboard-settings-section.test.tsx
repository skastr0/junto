// @vitest-environment jsdom
/**
 * Settings -> Cache window, for the machine chosen in the sidebar: the
 * default, and one row per harness that machine has, each following the
 * default or set on its own. Read and written through that machine's core; a
 * machine that does not answer shows what it last sent, read only.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Result } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MachineInventory } from "../src/shared/harness-domain";
import { MachineSettingsUnavailableError, type MachineCacheWindows } from "../src/shared/machine-settings";
import type { OffboardRulesPatch } from "../src/shared/seat-offboard";
import { defaultSettings } from "../src/shared/settings";
import { OffboardSettingsSection } from "../src/renderer/components/settings/OffboardSettingsSection";
import { harnessMachineSource, setHarnessMachineSource } from "../src/renderer/lib/harness-machine-source";
import { coreMachineSettingsSource, setMachineSettingsSource } from "../src/renderer/lib/machine-settings-source";
import { forgetSettingsMachine } from "../src/renderer/lib/settings-machine";
import { state$ } from "../src/renderer/lib/state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const realHarnessSource = harnessMachineSource();

let host: HTMLDivElement;
let root: Root;
let windows: MachineCacheWindows;
let writes: OffboardRulesPatch[];
let answering: "yes" | "no" | "lost";

const inventory = (...installed: string[]): MachineInventory => ({
  machine: "desk",
  harnesses: ["claude", "codex", "grok"].map((harness) => ({
    harness, machine: "desk", installed: installed.includes(harness), models: [], efforts: [],
  })),
} as never);

const unreachable = (machine: string, failure?: string) =>
  new MachineSettingsUnavailableError({ machine, reason: "unreachable", message: "no link", ...(failure ? { failure } : {}) });

const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
};

const render = async () => {
  await act(async () => root.render(<OffboardSettingsSection />));
  await settle();
};

beforeEach(() => {
  writes = [];
  answering = "yes";
  windows = { machine: "desk", cacheWindowMinutes: 60, harness: { codex: 30 }, cacheMode: "hybrid" };
  state$.settings.set({ ...defaultSettings(), machine: { ...defaultSettings().machine, name: "desk" } });
  setMachineSettingsSource({
    ...coreMachineSettingsSource,
    cacheWindows: async (machine) =>
      answering === "yes" ? Result.succeed(windows) : Result.fail(unreachable(machine)),
    writeCacheWindows: async (machine, patch) => {
      writes.push(patch);
      if (answering === "lost") return Result.fail(unreachable(machine, "LinkClosed"));
      if (answering === "no") return Result.fail(unreachable(machine, "NoPathToMachine"));
      const harness = { ...windows.harness };
      for (const [id, over] of Object.entries(patch.harness ?? {})) {
        if (over === null) delete harness[id];
        else harness[id] = over.cacheWindowMinutes;
      }
      windows = {
        ...windows,
        cacheWindowMinutes: patch.cacheWindowMinutes ?? windows.cacheWindowMinutes,
        harness,
        ...(patch.cacheMode === undefined ? {} : { cacheMode: patch.cacheMode }),
      };
      return Result.succeed(windows);
    },
  });
  setHarnessMachineSource({ ...realHarnessSource, inventory: async () => Result.succeed(inventory("claude", "codex")) });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  forgetSettingsMachine();
  setMachineSettingsSource(coreMachineSettingsSource);
  setHarnessMachineSource(realHarnessSource);
  state$.settings.set(defaultSettings());
});

const input = (label: string) => host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
const row = (harness: string) => host.querySelector(`[data-testid="offboard-harness-${harness}"]`)!;
const ownSwitch = (harness: string) => row(harness).querySelector<HTMLInputElement>('input[role="switch"]')!;
const ownMinutes = (harness: string) => row(harness).querySelector<HTMLInputElement>('input[type="number"]');

/** Type a value into a minutes field and leave it. */
const enter = async (label: string, value: string) => {
  const field = input(label);
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  await settle();
};

const toggle = async (harness: string) => {
  await act(async () => {
    ownSwitch(harness).click();
  });
  await settle();
};

describe("the cache window in Settings", () => {
  it("shows the machine's default and a row per harness it has, and no other rule", async () => {
    await render();
    expect(input("Cache window, minutes").value).toBe("60");
    expect([...host.querySelectorAll(".offboard-settings__harness")].map((row) => row.getAttribute("data-testid")))
      .toEqual(["offboard-harness-claude", "offboard-harness-codex"]);
    expect(ownSwitch("claude").checked).toBe(false);
    expect(ownSwitch("codex").checked).toBe(true);
    expect(ownMinutes("codex")!.value).toBe("30");
    expect(host.textContent).not.toMatch(/nudge|auto offboard|worth/iu);
  });

  it("writes the default on the machine and shows what it read back", async () => {
    await render();
    await enter("Cache window, minutes", "5");
    expect(writes).toEqual([{ cacheWindowMinutes: 5 }]);
    expect(input("Cache window, minutes").value).toBe("5");
  });

  it("ignores a value that is not whole minutes in range", async () => {
    await render();
    for (const value of ["0", "2.5", "10081", "soon"]) await enter("Cache window, minutes", value);
    expect(writes).toEqual([]);
    expect(input("Cache window, minutes").value).toBe("60");
  });

  it("sets a harness on its own from the default, and back to following it", async () => {
    await render();
    await toggle("claude");
    expect(writes).toEqual([{ harness: { claude: { cacheWindowMinutes: 60 } } }]);
    await enter(ownMinutes("claude")!.getAttribute("aria-label")!, "10");
    expect(writes.at(-1)).toEqual({ harness: { claude: { cacheWindowMinutes: 10 } } });
    await toggle("codex");
    expect(writes.at(-1)).toEqual({ harness: { codex: null } });
    expect(ownMinutes("codex")).toBeNull();
  });
});

describe("the cache mode", () => {
  const mode = (name: string) => host.querySelector<HTMLButtonElement>(`[data-testid="offboard-cache-mode-${name}"]`)!;
  const checked = () =>
    [...host.querySelectorAll('[role="radio"][aria-checked="true"]')].map((radio) => radio.getAttribute("data-testid"));

  it("shows the machine's mode as one choice of four, each with its line", async () => {
    await render();
    expect([...host.querySelectorAll('[role="radiogroup"][aria-label="Cache mode"] [role="radio"]')].map((radio) => radio.textContent))
      .toEqual([
        "OffJunto never acts on the cache window. Seats always continue.",
        "ManualA seat past its window shows it, and you start it fresh yourself.",
        "AutoA seat off screen past its window starts fresh. A seat open in front of you asks first.",
        "HybridLike auto, but a seat open in front of you is never started fresh or asked; it shows the warning.",
      ]);
    expect(checked()).toEqual(["offboard-cache-mode-hybrid"]);
    expect(host.textContent).not.toContain("\u00b7");
  });

  it("writes the mode on the machine and shows what it read back", async () => {
    await render();
    await act(async () => mode("manual").click());
    await settle();
    expect(writes).toEqual([{ cacheMode: "manual" }]);
    expect(checked()).toEqual(["offboard-cache-mode-manual"]);
    await act(async () => mode("manual").click());
    await settle();
    expect(writes).toHaveLength(1);
  });

  it("asks a linked machine from before the mode to be updated, and offers no choice", async () => {
    const { cacheMode: _gone, ...old } = windows;
    windows = old;
    await render();
    expect(host.querySelector('[data-testid="offboard-cache-mode-old"]')!.textContent).toBe("Update this machine to choose a mode.");
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
    // Its windows still read and write.
    await enter("Cache window, minutes", "20");
    expect(writes).toEqual([{ cacheWindowMinutes: 20 }]);
  });
});

describe("a machine that does not answer", () => {
  it("shows what it last sent, read only", async () => {
    await render();
    answering = "no";
    await act(async () => root.unmount());
    root = createRoot(host);
    await render();
    expect(host.querySelector('[data-testid="offboard-machine-refused"]')!.textContent).toMatch(/desk did not answer.*Showing what it sent/u);
    expect(input("Cache window, minutes").value).toBe("60");
    expect(input("Cache window, minutes").disabled).toBe(true);
  });

  it("says a write the link lost may not have been saved, and reads again", async () => {
    await render();
    answering = "lost";
    await enter("Cache window, minutes", "15");
    expect(host.textContent).toContain("May not have been saved on desk");
  });

  it("says a write that never left was not saved", async () => {
    await render();
    answering = "no";
    await enter("Cache window, minutes", "15");
    expect(host.textContent).toContain("Not saved on desk");
  });
});
