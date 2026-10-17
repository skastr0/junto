// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Result } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applySettingsPatch, defaultSettings, type Settings, type SettingsPatch } from "@shared/settings";
import { InventoryUnavailableError, paramsOfTemplate, type MachineInventory } from "@shared/harness-domain";
import { NativeConfigWriteError } from "@shared/harness-domain/native-config-write";
import { templateFor } from "@shared/managed-terminal-templates";
import { HarnessesSettingsSection } from "../src/renderer/components/settings/HarnessesSettingsSection";
import {
  pendingHarnessMachineSource,
  setHarnessMachineSource,
} from "../src/renderer/lib/harness-machine-source";
import { state$ } from "../src/renderer/lib/state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let patches: SettingsPatch[];
let asked: string[];

const withMachine = (settings: Settings): Settings => ({
  ...settings,
  machine: { ...settings.machine, name: "macbook" },
});

const miniInventory: MachineInventory = {
  machine: "mac-mini",
  harnesses: [
    {
      harness: "claude",
      machine: "mac-mini",
      installed: true,
      version: "2.1.0",
      models: [{ id: "mini-only-model", label: "Mini only" }],
      efforts: [],
      scannedAt: Date.now(),
      refreshing: false,
    },
  ],
};

const withClaude = (version: string): MachineInventory => ({
  machine: "mac-mini",
  harnesses: [{ ...miniInventory.harnesses[0]!, version }],
});

const render = async (machine?: string) => {
  await act(async () => {
    root.render(<HarnessesSettingsSection {...(machine ? { machine } : {})} />);
  });
};

const card = (harness: string) => host.querySelector(`[data-harness="${harness}"]`) as HTMLElement;

beforeEach(() => {
  patches = [];
  asked = [];
  (window as unknown as { junto: unknown }).junto = {
    settingsPatch: async (patch: SettingsPatch) => {
      patches.push(patch);
      const next = applySettingsPatch(state$.settings.peek(), patch);
      return { ok: true, settings: next };
    },
  };
  state$.settings.set(withMachine(defaultSettings()));
  setHarnessMachineSource({
    ...pendingHarnessMachineSource,
    inventory: async (machine) => {
      asked.push(machine);
      return machine === "mac-mini"
        ? Result.succeed(miniInventory)
        : Result.fail({ error: new InventoryUnavailableError({ machine, reason: "unreachable", message: "no route" }) });
    },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setHarnessMachineSource(pendingHarnessMachineSource);
});

describe("Settings > Agents, per machine", () => {
  it("asks the named machine, this one included, the same way", async () => {
    await render();
    await render("mac-mini");
    expect(asked).toEqual(["macbook", "mac-mini"]);
  });

  it("offers the chosen machine's models, not this window's", async () => {
    await render("mac-mini");
    const options = [...card("claude").querySelectorAll("datalist option")].map((o) => o.getAttribute("value"));
    expect(options).toContain("mini-only-model");
    expect(card("claude").textContent).toContain("version 2.1.0");
  });

  it("shows Harness default for an unset key and never a forced value", async () => {
    await render("mac-mini");
    expect(card("claude").textContent).toContain("Seats on mac-mini start with: Harness default");
  });

  it("names where a resolved value came from", async () => {
    state$.settings.set(
      applySettingsPatch(state$.settings.peek(), {
        harnesses: {
          byHarness: { claude: { model: "opus" } },
          byMachine: { "mac-mini": { byHarness: { claude: { effort: "high" } } } },
        },
      }),
    );
    await render("mac-mini");
    const text = card("claude").textContent ?? "";
    expect(text).toContain("opus, from All machines");
    expect(text).toContain("high, from mac-mini");
  });

  it("writes a machine override under that machine only", async () => {
    await render("mac-mini");
    const input = [...card("claude").querySelectorAll("input")].find((el) =>
      el.getAttribute("aria-label")?.endsWith("model, mac-mini"),
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "sonnet");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(patches).toContainEqual({
      harnesses: { byMachine: { "mac-mini": { byHarness: { claude: { model: "sonnet" } } } } },
    });
  });

  it("shows a saved value the harness refuses instead of passing it quietly", async () => {
    const codex = paramsOfTemplate(templateFor("codex")).params.find((spec) => spec.key === "permissionMode");
    const listed = codex?.options.source === "fixed" ? codex.options.values : [];
    expect(listed).not.toContain("untrusted");
    state$.settings.set(
      applySettingsPatch(state$.settings.peek(), {
        harnesses: { byMachine: { "mac-mini": { byHarness: { codex: { permissionMode: "untrusted" } } } } },
      }),
    );
    await render("mac-mini");
    expect(card("codex").querySelector('[data-layer="machineDefault"] [role="alert"]')?.textContent).toContain(
      "untrusted is not one of",
    );
  });

  it("drops a machine override back to the all machines value", async () => {
    state$.settings.set(
      applySettingsPatch(state$.settings.peek(), {
        harnesses: { byMachine: { "mac-mini": { byHarness: { claude: { model: "sonnet" } } } } },
      }),
    );
    await render("mac-mini");
    const button = [...card("claude").querySelectorAll("button")].find((el) => el.textContent === "Use all machines");
    await act(async () => button?.click());
    expect(patches).toContainEqual({
      harnesses: { byMachine: { "mac-mini": { byHarness: { claude: { inherit: ["model"] } } } } },
    });
  });

  it("says none when a machine opts out of the all machines arguments", async () => {
    state$.settings.set(
      applySettingsPatch(state$.settings.peek(), {
        harnesses: {
          byHarness: { claude: { extraArgs: ["--verbose"] } },
          byMachine: { "mac-mini": { byHarness: { claude: { extraArgs: [] } } } },
        },
      }),
    );
    await render("mac-mini");
    expect(card("claude").textContent).toContain("start with: none, from mac-mini");
  });

  it("offers the declared native settings for the machine's installed version and writes through the machine", async () => {
    const writes: unknown[] = [];
    setHarnessMachineSource({
      ...pendingHarnessMachineSource,
      inventory: async () => Result.succeed(withClaude("2.1.302")),
      readNativeSettings: async () => Result.succeed({ values: { effortLevel: "high", alwaysThinkingEnabled: true }, unfit: [] }),
      writeNativeSetting: async (write) => {
        writes.push(write);
        return Result.succeed(write.value);
      },
    });
    await render("mac-mini");
    const native = card("claude").querySelector('[data-native-config="claude"]') as HTMLElement;
    expect(native.textContent).toContain("permissions.defaultMode");
    const toggle = native.querySelector('[aria-label^="Claude Code always think"]') as HTMLElement;
    await act(async () => toggle.click());
    expect(writes).toEqual([{ machine: "mac-mini", harness: "claude", key: "alwaysThinkingEnabled", value: false }]);
  });

  it("shows a file value Junto does not offer as unset, and says the file holds one", async () => {
    setHarnessMachineSource({
      ...pendingHarnessMachineSource,
      inventory: async () => Result.succeed(withClaude("2.1.302")),
      readNativeSettings: async () =>
        Result.succeed({ values: { effortLevel: "turbo", alwaysThinkingEnabled: true }, unfit: ["effortLevel"] }),
    });
    await render("mac-mini");
    const native = card("claude").querySelector('[data-native-config="claude"]') as HTMLElement;
    expect(native.textContent).not.toContain("turbo");
    expect(native.querySelector('[data-unfit="effortLevel"]')?.textContent).toContain(
      "holds a value Junto does not offer",
    );
  });

  it("names the link's typed failure when a machine's config cannot be read", async () => {
    setHarnessMachineSource({
      ...pendingHarnessMachineSource,
      inventory: async () => Result.succeed(withClaude("2.1.302")),
      readNativeSettings: async (machine) =>
        Result.fail({
          error: new InventoryUnavailableError({ machine, reason: "unreachable", message: "the link is down" }),
          failure: "LinkUnavailable",
        }),
    });
    await render("mac-mini");
    const native = card("claude").querySelector('[data-native-config="claude"]') as HTMLElement;
    expect(native.textContent).toContain("LinkUnavailable: the link is down");
  });

  it("reads the file again after a conflict and never retries on its own", async () => {
    let reads = 0;
    let writes = 0;
    setHarnessMachineSource({
      ...pendingHarnessMachineSource,
      inventory: async () => Result.succeed(withClaude("2.1.302")),
      readNativeSettings: async () => {
        reads += 1;
        return Result.succeed({ values: { alwaysThinkingEnabled: reads > 1 }, unfit: [] });
      },
      writeNativeSetting: async (write) => {
        writes += 1;
        return Result.fail({
          error: new NativeConfigWriteError({ machine: write.machine, harness: write.harness, key: write.key, reason: "conflict", message: "changed" }),
        });
      },
    });
    await render("mac-mini");
    const native = card("claude").querySelector('[data-native-config="claude"]') as HTMLElement;
    const toggle = () => native.querySelector('[aria-label^="Claude Code always think"]') as HTMLElement;
    await act(async () => toggle().click());
    expect(writes).toBe(1);
    expect(reads).toBe(2);
    expect(native.textContent).toContain("the file changed on mac-mini since it was read");
    expect(toggle().getAttribute("aria-checked") ?? String((toggle() as HTMLInputElement).checked)).toBe("true");
  });

  it("asks the cache again while a scan runs, and shows the version when it lands", async () => {
    vi.useFakeTimers();
    let asks = 0;
    setHarnessMachineSource({
      ...pendingHarnessMachineSource,
      inventory: async () => {
        asks += 1;
        const row = { ...miniInventory.harnesses[0]!, version: "2.1.302", refreshing: asks === 1 };
        return Result.succeed({ machine: "mac-mini", harnesses: [asks === 1 ? { ...row, version: undefined } as never : row] });
      },
    });
    await render("mac-mini");
    expect(card("claude").textContent).toContain("rescanning");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    vi.useRealTimers();
    expect(asks).toBe(2);
    expect(card("claude").textContent).toContain("version 2.1.302");
  });

  it("says what was tested against the installed version, and never calls it broken", async () => {
    setHarnessMachineSource({
      ...pendingHarnessMachineSource,
      inventory: async () =>
        Result.succeed({
          machine: "mac-mini",
          harnesses: [
            {
              ...miniInventory.harnesses[0]!,
              version: "2.1.400",
              verification: { verdict: "newer", from: "2.1.200", through: "2.1.302" },
            },
          ],
        }),
    });
    await render("mac-mini");
    const line = card("claude").querySelector('[data-verdict="newer"]');
    expect(line?.textContent).toBe("Newer than tested (verified through 2.1.302)");
    expect(line?.getAttribute("role")).toBeNull();
  });

  it("names a failed scan by its reason when the machine sent no message", async () => {
    setHarnessMachineSource({
      ...pendingHarnessMachineSource,
      inventory: async () =>
        Result.succeed({
          machine: "mac-mini",
          harnesses: [{ ...miniInventory.harnesses[0]!, lastFailure: { reason: "timeout", at: 1 } }],
        }),
    });
    await render("mac-mini");
    expect(card("claude").textContent).toContain("version 2.1.0, last scan timeout");
    expect(card("claude").textContent).not.toContain("undefined");
  });

  it("offers no native setting for a version nobody verified", async () => {
    setHarnessMachineSource({
      ...pendingHarnessMachineSource,
      inventory: async () => Result.succeed(withClaude("2.0.1")),
    });
    await render("mac-mini");
    expect(card("claude").querySelector("[data-native-config]")).toBeNull();
    expect(card("claude").textContent).toContain("No settings are declared for Claude Code 2.0.1.");
  });

  it("shows an unreachable machine's last snapshot with its age and the typed failure", async () => {
    setHarnessMachineSource({
      ...pendingHarnessMachineSource,
      inventory: async (machine) =>
        Result.fail({
          error: new InventoryUnavailableError({ machine, reason: "unreachable", message: "the link is down" }),
          failure: "LinkUnavailable",
          last: { inventory: miniInventory, receivedAt: Date.now() - 5 * 60_000 },
        }),
    });
    await render("mac-mini");
    const note = host.querySelector('[data-testid="harness-inventory-refused"]')!;
    expect(note.getAttribute("data-failure")).toBe("LinkUnavailable");
    expect(note.textContent).toContain("did not answer (LinkUnavailable): the link is down.");
    expect(note.textContent).toContain("Showing what it sent 5m ago.");
    expect(card("claude").textContent).toContain("version 2.1.0");
    const options = [...card("claude").querySelectorAll("datalist option")].map((o) => o.getAttribute("value"));
    expect(options).toContain("mini-only-model");
  });

  it("says why a machine has no inventory instead of waiting", async () => {
    await render("macbook");
    expect(host.textContent).toContain("macbook did not answer (unreachable): no route.");
    expect(host.textContent).toContain("It has not sent an inventory yet.");
    expect(host.querySelectorAll("[data-harness]").length).toBeGreaterThan(0);
  });
});
