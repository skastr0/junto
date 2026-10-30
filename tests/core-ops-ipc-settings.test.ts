import { Effect, Layer, ManagedRuntime } from "effect";
import { expect, it } from "vitest";
import { defaultSettings, type Settings } from "../src/shared/settings";
import { inProcessCore, type CoreRunner } from "./support/in-process-core";
import "../src/main/core-process/ops/ipc-settings";
import { SettingsService } from "../src/main/junto/settings/service";

// Settings answer from the core, masked for the renderer before they cross to main.
it("answers Settings in the core, masks provider secrets before they cross, and refuses malformed input there", async () => {
  const defaults = defaultSettings();
  const stored: Settings = { ...defaults, machine: { ...defaults.machine, name: "studio" }, providers: { openai: { apiKey: "sk-secret" } } } as Settings;
  const patches: unknown[] = [];
  const runtime = ManagedRuntime.make(Layer.succeed(SettingsService, {
    get: Effect.succeed(stored),
    patch: (patch: unknown) => (patches.push(patch), Effect.succeed(stored)),
    reset: () => Effect.succeed(stored),
  } as never));
  const core = inProcessCore(runtime as unknown as CoreRunner);
  try {
    const got = await core.call("settings.get", {});
    expect(got.ok).toBe(true);
    expect(JSON.stringify(got)).not.toContain("sk-secret");
    expect(got.settings?.appearance).toEqual(stored.appearance);

    expect(await core.call("settings.patch", { patch: [1] })).toMatchObject({ ok: false });
    expect(patches).toEqual([]);
    expect(JSON.stringify(await core.call("settings.patch", { patch: { appearance: {} } }))).not.toContain("sk-secret");
    expect(patches).toEqual([{ appearance: {} }]);
    expect(await core.call("settings.reset", { section: "no-such-section" })).toMatchObject({ ok: false });
    expect(await core.call("settings.machineProviders", { machine: 7 })).toMatchObject({
      ok: false, error: { _tag: "MachineSettingsUnavailableError", reason: "unreachable" },
    });
    expect(await core.call("settings.machineCacheWindowsWrite", { input: { machine: stored.machine.name, patch: { nope: 1 } } }))
      .toMatchObject({ ok: false, error: { reason: "failed" } });
  } finally {
    await runtime.dispose();
  }
});
