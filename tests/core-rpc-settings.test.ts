/**
 * The settings group (src/contract/core/settings.ts) through the group's own
 * client on the core's handlers: answers masked for the renderer before they
 * cross, a change for this machine applied here, and a watch subscribed once
 * per server that publishes the settings as they stand and then each change.
 * What the window sends that this build does not read is refused at main's
 * edge (src/shared/settings.ts, src/shared/machine-settings.ts), before the
 * core is asked.
 */
import { Effect, Exit, Layer, Result, Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { describe, expect, it } from "vitest";
import { SETTINGS_CHANGED } from "../src/contract/core/channels";
import { SettingsRpcs } from "../src/contract/core/settings";
import { HostsService } from "../src/core/hosts/service";
import { MachineLink } from "../src/core/link/service";
import { MachineRepository } from "../src/core/machines/repository";
import { ModelRecords } from "../src/core/model/records";
import { ModelService } from "../src/core/model/service";
import { SettingsHandlers } from "../src/core/ops/ipc-settings";
import { CorePushes } from "../src/core/push";
import { SettingsService } from "../src/core/settings/service";
import {
  machineCacheWindowsWriteFromWindow,
  machineFromWindow,
  machineProvidersWriteFromWindow,
} from "../src/shared/machine-settings";
import {
  defaultSettings,
  redactProvidersForIpc,
  settingsPatchFromWindow,
  settingsResetSectionFromWindow,
  SettingsError,
  type Settings,
} from "../src/shared/settings";

const defaults = defaultSettings();
const stored: Settings = {
  ...defaults,
  machine: { ...defaults.machine, name: "studio" },
  providers: { openai: { apiKey: "sk-secret" } },
};

/** The core's settings handlers on a scope of their own, and the group's client on them. */
const served = async (settings: Layer.Layer<SettingsService>) => {
  const pushed: Array<readonly [string, unknown]> = [];
  const scope = await Effect.runPromise(Scope.make());
  const handlers = await Effect.runPromise(
    Layer.buildWithScope(
      SettingsHandlers.pipe(
        Layer.provide(
          Layer.mergeAll(
            settings,
            Layer.succeed(CorePushes, { publish: (channel, payload) => Effect.sync(() => void pushed.push([channel, payload])) }),
            // Asked only for another machine, which no case here names.
            Layer.mock(HostsService, {}),
            Layer.mock(MachineLink, {}),
            Layer.mock(MachineRepository, {}),
            Layer.mock(ModelRecords, {}),
            Layer.mock(ModelService, { subscribeChanges: () => () => undefined, subscribeCanvasesChanges: () => () => undefined }),
          ),
        ),
      ),
      scope,
    ),
  );
  const client = await Effect.runPromise(
    RpcTest.makeClient(SettingsRpcs).pipe(Effect.provideContext(handlers), Effect.provideService(Scope.Scope, scope)),
  );
  return { client, pushed, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
};

describe("the settings group", () => {
  it("answers Settings in the core, masks provider secrets before they cross, and applies this machine's changes there", async () => {
    const patches: unknown[] = [];
    const resets: unknown[] = [];
    const { client, close } = await served(Layer.mock(SettingsService, {
      get: Effect.succeed(stored),
      patch: (patch) => Effect.sync(() => (patches.push(patch), stored)),
      reset: (section) => Effect.sync(() => (resets.push(section), stored)),
      subscribe: () => () => undefined,
    }));
    try {
      const got = await Effect.runPromise(client.SettingsGet());
      expect(got.ok).toBe(true);
      expect(JSON.stringify(got)).not.toContain("sk-secret");
      expect(got.settings?.appearance).toEqual(stored.appearance);

      expect(JSON.stringify(await Effect.runPromise(client.SettingsPatch({ patch: { appearance: {} } })))).not.toContain("sk-secret");
      expect(patches).toEqual([{ appearance: {} }]);
      await Effect.runPromise(client.SettingsReset({ section: "appearance" }));
      await Effect.runPromise(client.SettingsReset({}));
      expect(resets).toEqual(["appearance", undefined]);

      // This machine answers for itself: names and state, never a value.
      expect(await Effect.runPromise(client.SettingsMachineProviders({ machine: "studio" }))).toMatchObject({
        ok: true, value: { machine: "studio", credentials: { openai: { apiKey: true } } },
      });
      expect(await Effect.runPromise(client.SettingsMachineCacheWindowsWrite({ machine: "studio", patch: { cacheWindowMinutes: 30 } })))
        .toMatchObject({ ok: true, value: { machine: "studio" } });
      expect(patches).toEqual([{ appearance: {} }, { offboard: { cacheWindowMinutes: 30 } }]);
    } finally {
      await close();
    }
  });

  it("answers with the core's reason when the settings cannot be read, the window's and a machine-scoped page's alike", async () => {
    const { client, close } = await served(Layer.mock(SettingsService, {
      get: Effect.fail(new SettingsError({ code: "io", message: "the database is closed" })),
      subscribe: () => () => undefined,
    }));
    try {
      expect(await Effect.runPromise(client.SettingsGet())).toEqual({ ok: false, code: "io", message: "the database is closed" });
      expect(await Effect.runPromise(client.SettingsMachineRecord({ machine: "studio" }))).toEqual({
        ok: false,
        error: { _tag: "MachineSettingsUnavailableError", machine: "studio", reason: "failed", message: "the database is closed" },
      });
    } finally {
      await close();
    }
  });

  it("publishes the settings as they stand on each watch, then each change once however often it is asked, never with a secret, until the server closes", async () => {
    const listeners: Array<(settings: Settings) => void> = [];
    let unsubscribed = 0;
    const { client, pushed, close } = await served(Layer.mock(SettingsService, {
      get: Effect.succeed(stored),
      subscribe: (listener) => {
        listeners.push(listener);
        return () => {
          unsubscribed += 1;
        };
      },
    }));
    await Effect.runPromise(client.SettingsWatch());
    await Effect.runPromise(client.SettingsWatch());
    expect(listeners).toHaveLength(1);
    const next: Settings = { ...stored, providers: { openai: { apiKey: "sk-next" } } };
    listeners[0]?.(next);
    expect(pushed).toEqual([
      [SETTINGS_CHANGED, redactProvidersForIpc(stored)],
      [SETTINGS_CHANGED, redactProvidersForIpc(stored)],
      [SETTINGS_CHANGED, redactProvidersForIpc(next)],
    ]);
    expect(JSON.stringify(pushed)).not.toContain("sk-");
    await close();
    expect(unsubscribed).toBe(1);
  });
});

describe("main's edge for the settings group", () => {
  it("refuses what the window sent that this build does not read, as the answer the window reads, and passes the rest decoded", () => {
    expect(Result.isFailure(settingsPatchFromWindow([1]))).toBe(true);
    expect(settingsPatchFromWindow([1])).toMatchObject({ failure: { ok: false, code: "validation" } });
    expect(Result.isFailure(settingsPatchFromWindow({ appearance: {}, nope: 1 }))).toBe(true);
    expect(settingsPatchFromWindow({ appearance: {} })).toMatchObject({ success: { appearance: {} } });

    expect(settingsResetSectionFromWindow("no-such-section")).toMatchObject({ failure: { ok: false, code: "validation" } });
    expect(settingsResetSectionFromWindow(undefined)).toMatchObject({ success: undefined });
    expect(settingsResetSectionFromWindow("appearance")).toMatchObject({ success: "appearance" });

    expect(machineFromWindow(7)).toMatchObject({
      failure: { ok: false, error: { _tag: "MachineSettingsUnavailableError", reason: "unreachable" } },
    });
    expect(machineCacheWindowsWriteFromWindow({ machine: "studio", patch: { nope: 1 } })).toMatchObject({
      failure: { ok: false, error: { machine: "studio", reason: "failed" } },
    });
    expect(machineProvidersWriteFromWindow({ patch: { enabledSources: [] } })).toMatchObject({
      failure: { ok: false, error: { machine: "", reason: "unreachable" } },
    });
  });
});
