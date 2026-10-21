// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Result } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIVE_OVERSEER_ENABLED, USAGE_ENABLED } from "@shared/features";
import { MachineSettingsUnavailableError, machineProvidersOf } from "@shared/machine-settings";
import { defaultSettings, type ProvidersPatch, type Settings } from "@shared/settings";
import { NATIVE_USAGE_PROVIDERS } from "@shared/usage";
import { ProvidersSettingsSection } from "../src/renderer/components/settings/ProvidersSettingsSection";
import {
  coreMachineSettingsSource,
  setMachineSettingsSource,
} from "../src/renderer/lib/machine-settings-source";
import { chooseSettingsMachine, forgetSettingsMachine } from "../src/renderer/lib/settings-machine";
import { state$ } from "../src/renderer/lib/state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let writes: Array<{ machine: string; patch: ProvidersPatch }>;

const thisMachine = (settings: Settings): Settings => ({ ...settings, machine: { ...settings.machine, name: "desk" } });

const render = async (): Promise<string> => {
  await act(async () => root.render(<ProvidersSettingsSection />));
  return host.innerHTML;
};

const checkboxes = () => [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];

beforeEach(() => {
  writes = [];
  state$.settings.set(thisMachine(defaultSettings()));
  setMachineSettingsSource({
    ...coreMachineSettingsSource,
    providers: async (machine) =>
      machine === "desk"
        ? Result.succeed(machineProvidersOf(state$.settings.peek(), machine))
        : Result.fail(new MachineSettingsUnavailableError({ machine, reason: "unreachable", message: "no link" })),
    writeProviders: async (machine, patch) => {
      writes.push({ machine, patch });
      return Result.succeed(machineProvidersOf(state$.settings.peek(), machine));
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
  state$.settings.set(defaultSettings());
});

describe("provider access settings", () => {
  it.runIf(USAGE_ENABLED)("shows every source as explicit opt-in and discloses sensitive access", async () => {
    const html = await render();
    expect(html).toContain("Provider access on desk is off by default");
    expect(html).toContain("Usage sources refresh every five minutes");
    expect(html).toContain("macOS Keychain");
    expect(html).toContain("Chrome profile local storage");
    expect(html).toContain("process command lines and ports");
    expect(html).toContain("This does not run hermes CLI commands");
    expect(html.match(/aria-label="Allow [^"]+ usage access"/gu)).toHaveLength(NATIVE_USAGE_PROVIDERS.length);
    expect(checkboxes()).toHaveLength(NATIVE_USAGE_PROVIDERS.length);
    expect(checkboxes().every((input) => !input.checked)).toBe(true);
    expect(html).not.toContain("Hermes host snapshot");
  });

  it.runIf(USAGE_ENABLED)("renders only the sources the operator enabled as checked", async () => {
    state$.settings.providers.set({ enabledSources: ["claude", "cursor"] });
    const html = await render();
    expect(checkboxes().filter((input) => input.checked)).toHaveLength(2);
    expect(html).toContain("access on");
  });

  it.runIf(USAGE_ENABLED)("writes a source toggle to the chosen machine", async () => {
    await render();
    await act(async () => checkboxes()[0]!.click());
    expect(writes[0]?.machine).toBe("desk");
    expect(writes[0]?.patch.sourceAccess?.enabled).toBe(true);
  });

  it.runIf(USAGE_ENABLED)("says why another machine's providers are not shown, and offers no write", async () => {
    state$.machines.set([
      { id: "desk", label: "Desk", isThisMachine: true } as never,
      { id: "mini", label: "Mini", isThisMachine: false } as never,
    ]);
    state$.machineFacts.set({ mini: { setUp: true, needsUpdate: false, reachable: false } } as never);
    chooseSettingsMachine("mini");
    const html = await render();
    expect(host.textContent).toContain("Mini did not answer (unreachable): no link.");
    expect(checkboxes().every((input) => input.disabled)).toBe(true);
    const secrets = [...host.querySelectorAll<HTMLInputElement>('input[type="password"]')];
    expect(secrets.length).toBeGreaterThan(0);
    expect(secrets.every((input) => input.disabled)).toBe(true);
    expect(html).not.toContain('aria-label="GPT-Live settings"');
  });

  it.runIf(USAGE_ENABLED)("an answering machine's toggles write there, its credentials are set on it", async () => {
    state$.machines.set([
      { id: "desk", label: "Desk", isThisMachine: true } as never,
      { id: "mini", label: "Mini", isThisMachine: false } as never,
    ]);
    setMachineSettingsSource({
      ...coreMachineSettingsSource,
      providers: async (machine) => Result.succeed(machineProvidersOf(state$.settings.peek(), machine)),
      writeProviders: async (machine, patch) => {
        writes.push({ machine, patch });
        return Result.fail(
          new MachineSettingsUnavailableError({ machine, reason: "unreachable", message: "the link dropped", failure: "LinkUnavailable" }),
        );
      },
    });
    chooseSettingsMachine("mini");
    await render();
    expect(checkboxes().every((input) => !input.disabled)).toBe(true);
    const secrets = [...host.querySelectorAll<HTMLInputElement>('input[type="password"]')];
    expect(secrets.every((input) => input.disabled)).toBe(true);
    expect(host.querySelector('[data-testid="providers-credentials-remote"]')?.textContent).toContain(
      "Set these on Mini itself",
    );
    await act(async () => checkboxes()[0]!.click());
    expect(writes[0]?.machine).toBe("mini");
    expect(host.textContent).toContain("Not saved on Mini: LinkUnavailable: the link dropped");
  });

  it.runIf(LIVE_OVERSEER_ENABLED)("offers write-only OpenAI credentials and explicit per-call limits", async () => {
    state$.settings.providers.set({ openai: { apiKeyConfigured: true } });
    const html = await render();
    expect(html).toContain('aria-label="GPT-Live settings"');
    expect(html).toContain("API key configured");
    expect(html).toContain("A call starts only when you choose Start live conversation");
    expect(html).toContain('aria-label="Live backend model"');
    expect(html).toContain('aria-label="Maximum call minutes"');
    expect(html).toContain('aria-label="Voice limit per call in USD"');
    expect(html).toContain("Backend token charges are separate");
    expect(html).toContain("credential vault");
    expect(html).not.toContain("Reveal OpenAI API key");
  });
});
