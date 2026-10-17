// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Result } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MachineSettingsUnavailableError } from "@shared/machine-settings";
import { defaultSettings } from "@shared/settings";
import { MachineSettingsSection } from "../src/renderer/components/settings/MachineSettingsSection";
import { coreMachineSettingsSource, setMachineSettingsSource } from "../src/renderer/lib/machine-settings-source";
import { chooseSettingsMachine, forgetSettingsMachine } from "../src/renderer/lib/settings-machine";
import { state$ } from "../src/renderer/lib/state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let writes: unknown[];

beforeEach(() => {
  writes = [];
  const settings = defaultSettings();
  state$.settings.set({ ...settings, machine: { ...settings.machine, name: "desk" } });
  setMachineSettingsSource({
    ...coreMachineSettingsSource,
    record: async (machine) =>
      machine === "desk"
        ? Result.succeed({ machine, name: "desk", supervisedPreferred: false })
        : Result.fail(new MachineSettingsUnavailableError({ machine, reason: "unreachable", message: "no link" })),
    writeRecord: async (machine, patch) => {
      writes.push({ machine, patch });
      return Result.succeed({ machine, name: machine, supervisedPreferred: patch.supervisedPreferred ?? false });
    },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  forgetSettingsMachine();
  setMachineSettingsSource(coreMachineSettingsSource);
});

const render = async () => {
  await act(async () => root.render(<MachineSettingsSection />));
};
const supervised = () => host.querySelector<HTMLInputElement>('input[aria-label="Prefer supervised runtime"]')!;

describe("Name and startup, per machine", () => {
  it("writes the supervised preference to the chosen machine", async () => {
    await render();
    await act(async () => supervised().click());
    expect(writes).toEqual([{ machine: "desk", patch: { supervisedPreferred: true } }]);
    expect(supervised().checked).toBe(true);
  });

  it("names the machine by its list label and offers no rename", async () => {
    state$.machines.set([{ id: "desk", label: "Desk", isThisMachine: true } as never]);
    await render();
    const section = host.querySelector('[data-testid="settings-machine-section"]')!;
    expect(section.textContent).toContain("Desk");
    expect(section.querySelectorAll('input:not([type="checkbox"]), textarea').length).toBe(0);
  });

  it("says why another machine's record is not shown, and offers no write", async () => {
    state$.machines.set([
      { id: "desk", label: "Desk", isThisMachine: true } as never,
      { id: "mini", label: "Mini", isThisMachine: false } as never,
    ]);
    state$.machineFacts.set({ mini: { setUp: true, needsUpdate: false } } as never);
    chooseSettingsMachine("mini");
    await render();
    expect(host.textContent).toContain("No record from Mini: no link");
    expect(supervised().disabled).toBe(true);
  });
});
