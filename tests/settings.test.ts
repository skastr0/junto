import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Result, ManagedRuntime, Schema } from "effect";
import {
  SETTINGS_VERSION,
  StationSettings,
  TERMINAL_BOUNDS,
  TerminalSettings,
  applySettingsPatch,
  defaultSettings,
  defaultTerminal,
  terminalSettings,
} from "../src/shared/settings";
import { MONO_CELL } from "../src/renderer/lib/focus-measure";
import {
  JUNTO_XTERM_FONT_FAMILY,
  JUNTO_XTERM_FONT_SIZE,
} from "../src/renderer/lib/terminal-theme";
import {
  applyAndValidatePatch,
  decodePatchInput,
  decodeStationTopologyPatch,
} from "../src/main/junto/settings/patch";
import {
  decodeStoredSettings,
} from "../src/main/junto/settings/state-schema";
import {
  makeSettingsService,
  shouldEnsureDefaultCommandCenter,
  type SettingsServiceApi,
} from "../src/main/junto/settings/service";
import {
  StateEngine,
  type StateOutputValue,
} from "../src/main/junto/state/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect);
const runEither = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.result(effect));

describe("settings contract", () => {
  it("defaultSettings is a valid v1 document", () => {
    const settings = defaultSettings();
    expect(settings.version).toBe(SETTINGS_VERSION);
    expect(settings.appearance.theme).toBe("system");
    expect(settings.browser.maxVisibleSurfaces).toBe(2);
    expect(settings.browser.maxWarmSessions).toBe(3);
    expect(settings.fleet.ditherLevel).toBe("fine");
    expect(settings.fleet.remoteManagedInstalls).toBe(false);
    expect(settings.advanced.logsExplorer).toBe(false);
  });

  it("applySettingsPatch merges ordinary and fleet sections", () => {
    const next = applySettingsPatch(defaultSettings(), {
      appearance: { reduceMotion: true },
      browser: { maxVisibleSurfaces: 4 },
      fleet: {
        ditherLevel: "balanced",
        remoteManagedInstalls: true,
      },
    });
    expect(next.appearance.reduceMotion).toBe(true);
    expect(next.appearance.theme).toBe("system");
    expect(next.browser.maxVisibleSurfaces).toBe(4);
    expect(next.browser.maxWarmSessions).toBe(3);
    expect(next.fleet.ditherLevel).toBe("balanced");
    expect(next.fleet.remoteManagedInstalls).toBe(true);
  });

  it("rejects the retired topologyIntegrity field at every decode boundary", () => {
    const retiredStation = {
      ...defaultSettings().station,
      topologyIntegrity: "ok",
    };
    expect("topologyIntegrity" in defaultSettings().station).toBe(false);
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(StationSettings, {
          onExcessProperty: "error",
        })(retiredStation),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decodePatchInput({
          station: { topologyIntegrity: "ok" },
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decodeStationTopologyPatch({ topologyIntegrity: "ok" }),
      ),
    ).toBe(true);
  });

  it("patch decoding and aggregate validation reject invalid limits", () => {
    expect(
      Result.isFailure(
        decodePatchInput({ browser: { maxVisibleSurfaces: 999 } }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decodePatchInput({ fleet: { ditherLevel: "ultra" } }),
      ),
    ).toBe(true);
    expect(
      Result.isSuccess(
        applyAndValidatePatch(defaultSettings(), {
          kernel: { debugVerbose: true },
        }),
      ),
    ).toBe(true);
  });

  it("maps the pre-rename theme value to dark on decode", () => {
    const { version: _version, station, ...preferences } = defaultSettings();
    const decoded = decodeStoredSettings(
      SETTINGS_VERSION,
      {
        ...preferences,
        appearance: { ...preferences.appearance, theme: "deep-field" },
      },
      station,
    );
    expect(decoded.appearance.theme).toBe("dark");
  });

  it("ignores unknown stored keys (a removed feature's setting just goes away) but rejects unknown patch fields", () => {
    const defaults = defaultSettings();
    const {
      version: _version,
      station,
      ...preferences
    } = defaults;

    // Stored data: an old key from a removed feature must never brick the
    // store — decode succeeds and the key is dropped from the result.
    const decoded = decodeStoredSettings(
      SETTINGS_VERSION,
      {
        ...preferences,
        retiredCompatibility: true,
      },
      station,
    );
    expect("retiredCompatibility" in decoded).toBe(false);
    // Live patch input is a caller's intent, not old data: typos still fail.
    expect(
      Result.isFailure(
        decodePatchInput({ retiredCompatibility: true }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decodePatchInput({
          fleet: { legacyManagedRollback: true },
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decodeStationTopologyPatch({ legacyManagedRollback: true }),
      ),
    ).toBe(true);
  });
});

type StateService = typeof StateEngine.Service;
type Harness = {
  readonly service: SettingsServiceApi;
  readonly state: StateService;
  readonly close: () => Promise<void>;
};

describe("SQLite settings service", () => {
  let root = "";
  let databasePath = "";
  let active: Harness | undefined;

  const closeActive = async (): Promise<void> => {
    const current = active;
    active = undefined;
    await current?.close();
  };

  afterEach(async () => {
    await closeActive();
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  const preparePaths = async (): Promise<void> => {
    if (root) return;
    root = await mkdtemp(join(tmpdir(), "junto-settings-sqlite-"));
    databasePath = join(root, "state", "junto.db");
  };

  const openService = async (
    options: {
      readonly probeSupervised?: () => Promise<"absent" | "installed">;
    } = {},
  ): Promise<Harness> => {
    await preparePaths();
    await closeActive();
    const runtime = ManagedRuntime.make(makeStateEngineLive(databasePath));
    const state = await runtime.runPromise(StateEngine);
    const service = await run(
      makeSettingsService(state, {
        probeSupervised: options.probeSupervised,
      }),
    );
    const harness = {
      service,
      state,
      close: () => runtime.dispose(),
    };
    active = harness;
    return harness;
  };

  it("does not infer Command Center for headless enrollment argv", () => {
    expect(shouldEnsureDefaultCommandCenter(["node", "app"])).toBe(true);
    expect(
      shouldEnsureDefaultCommandCenter(["node", "app", "--junto-headless"]),
    ).toBe(false);
  });

  it("initializes defaults in SQLite and auto-establishes Command Center", async () => {
    const { service, state } = await openService();
    const settings = await run(service.get);
    expect(settings).toEqual({
      ...defaultSettings(),
      station: {
        role: "command-center",
        hostId: "local",
        supervisedPreferred: false,
      },
    });

    const counts = await run(
      state.read("test.settings.count", (reader) => ({
        preferences: Number(
          reader.get<Record<string, StateOutputValue> & { count: number }>(
            "SELECT count(*) AS count FROM settings_preferences",
          )?.count ?? -1,
        ),
        stationConfiguration: Number(
          reader.get<Record<string, StateOutputValue> & { count: number }>(
            "SELECT count(*) AS count FROM station_configuration",
          )?.count ?? -1,
        ),
        initialization: Number(
          reader.get<Record<string, StateOutputValue> & { count: number }>(
            "SELECT count(*) AS count FROM settings_initialization",
          )?.count ?? -1,
        ),
      })),
    );
    expect(counts).toEqual({
      preferences: 1,
      stationConfiguration: 1,
      initialization: 1,
    });
  });

  it("turns an old default-on remoteManagedInstalls row off until explicit opt-in", async () => {
    const first = await openService();
    const defaults = await run(first.service.get);
    expect(defaults.fleet.remoteManagedInstalls).toBe(false);
    const body = await run(
      first.state.read(
        "test.settings.read-old-fleet",
        (reader) =>
          reader.get<
            Record<string, StateOutputValue> & { body: string }
          >(
            "SELECT body FROM settings_preferences WHERE singleton = 1",
          )?.body,
      ),
    );
    const encoded = JSON.stringify({
      ...JSON.parse(String(body)) as Record<string, unknown>,
      fleet: { ditherLevel: "fine", remoteManagedInstalls: true },
    });
    await run(
      first.state.transaction("test.settings.write-old-fleet", (writer) => {
        writer.run(
          "UPDATE settings_preferences SET body = ? WHERE singleton = 1",
          [encoded],
        );
      }),
    );
    const second = await openService();
    const repaired = await run(second.service.get);
    expect(repaired.fleet.remoteManagedInstalls).toBe(false);
    expect(repaired.fleet.remoteManagedInstallsConsented).toBeUndefined();
    const optedIn = await run(
      second.service.patch({ fleet: { remoteManagedInstalls: true } }),
    );
    expect(optedIn.fleet.remoteManagedInstalls).toBe(true);
    expect(optedIn.fleet.remoteManagedInstallsConsented).toBe(true);
  });

  it("persists preferences and canonical station configuration across restart", async () => {
    const first = await openService();
    await run(
      first.service.setStationTopology({
        role: "command-center",
        hostId: "local",
      }),
    );
    await run(
      first.service.patch({
        appearance: { reduceMotion: true },
        fleet: {
          ditherLevel: "coarse",
          remoteManagedInstalls: true,
        },
      }),
    );

    const second = await openService();
    const reloaded = await run(second.service.get);
    expect(reloaded.station.role).toBe("command-center");
    expect(reloaded.appearance.reduceMotion).toBe(true);
    expect(reloaded.fleet.ditherLevel).toBe("coarse");
    expect(reloaded.fleet.remoteManagedInstalls).toBe(true);
  });

  it("commits generic preference patches without rewriting station configuration", async () => {
    const { service, state } = await openService();
    await run(
      service.setStationTopology({
        role: "command-center",
        hostId: "local",
      }),
    );
    const before = await run(
      state.read(
        "test.settings.topology.before",
        (reader) =>
          reader.get<
            Record<string, StateOutputValue> & {
              role: string;
              host_id: string;
              configured_at: string;
            }
          >(
            "SELECT role, host_id, configured_at FROM station_configuration WHERE singleton = 1",
          ),
      ),
    );

    await run(service.patch({ browser: { maxVisibleSurfaces: 4 } }));
    const after = await run(
      state.read(
        "test.settings.topology.after",
        (reader) =>
          reader.get<
            Record<string, StateOutputValue> & {
              role: string;
              host_id: string;
              configured_at: string;
            }
          >(
            "SELECT role, host_id, configured_at FROM station_configuration WHERE singleton = 1",
          ),
      ),
    );
    expect(after).toEqual(before);
  });

  it("serializes concurrent read-modify-write patches without lost updates", async () => {
    const { service } = await openService();
    await run(
      Effect.all(
        [
          service.patch({ appearance: { reduceMotion: true } }),
          service.patch({ browser: { maxVisibleSurfaces: 4 } }),
          service.patch({ fleet: { remoteManagedInstalls: true } }),
        ],
        { concurrency: "unbounded" },
      ),
    );
    const settings = await run(service.get);
    expect(settings.appearance.reduceMotion).toBe(true);
    expect(settings.browser.maxVisibleSurfaces).toBe(4);
    expect(settings.fleet.remoteManagedInstalls).toBe(true);
  });

  it("publishes subscribers only after a successful commit", async () => {
    const { service, state } = await openService();
    const observed: Array<{
      readonly notified: number;
      readonly persisted: number;
    }> = [];
    service.subscribe((settings) => {
      const persisted = Effect.runSync(
        state.read("test.settings.listener", (reader) => {
          const row = reader.get<
            Record<string, StateOutputValue> & { body: string }
          >(
            "SELECT body FROM settings_preferences WHERE singleton = 1",
          );
          return (
            JSON.parse(String(row?.body)) as {
              browser: { maxVisibleSurfaces: number };
            }
          ).browser.maxVisibleSurfaces;
        }),
      );
      observed.push({
        notified: settings.browser.maxVisibleSurfaces,
        persisted,
      });
    });

    await run(service.patch({ browser: { maxVisibleSurfaces: 3 } }));
    expect(observed).toEqual([{ notified: 3, persisted: 3 }]);
    const failed = await runEither(
      service.patch({ browser: { maxWarmSessions: 0 } }),
    );
    expect(Result.isFailure(failed)).toBe(true);
    expect(observed).toHaveLength(1);
  });

  it("rejects retired patch fields before persistence or publication", async () => {
    const { service, state } = await openService();
    const observed: unknown[] = [];
    service.subscribe((settings) => observed.push(settings));
    const before = await run(
      state.read(
        "test.settings.strict-before",
        (reader) =>
          reader.get<
            Record<string, StateOutputValue> & { body: string }
          >(
            "SELECT body FROM settings_preferences WHERE singleton = 1",
          )?.body,
      ),
    );

    const topLevel = await runEither(
      service.patch({ retiredCompatibility: true }),
    );
    const nested = await runEither(
      service.patch({
        fleet: { legacyManagedRollback: true },
      }),
    );
    const after = await run(
      state.read(
        "test.settings.strict-after",
        (reader) =>
          reader.get<
            Record<string, StateOutputValue> & { body: string }
          >(
            "SELECT body FROM settings_preferences WHERE singleton = 1",
          )?.body,
      ),
    );

    expect(Result.isFailure(topLevel)).toBe(true);
    expect(Result.isFailure(nested)).toBe(true);
    expect(after).toBe(before);
    expect(observed).toEqual([]);
  });

  it("isolates subscriber defects from an already committed write", async () => {
    const { service } = await openService();
    service.subscribe(() => {
      throw new Error("listener defect");
    });
    const next = await run(
      service.patch({ appearance: { reduceMotion: true } }),
    );
    expect(next.appearance.reduceMotion).toBe(true);
    expect((await run(service.get)).appearance.reduceMotion).toBe(true);
  });

  it("rejects station topology through the generic patch surface", async () => {
    const { service } = await openService();
    const result = await runEither(
      service.patch({ station: { role: "command-center" } }),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.code).toBe("validation");
      expect(result.failure.message).toContain("settingsSetStationTopology");
    }
    expect((await run(service.get)).station.role).toBe("command-center");
  });

  it("freezes established Command Center identity but permits supervisor preference", async () => {
    const { service } = await openService();
    await run(
      service.setStationTopology({
        role: "command-center",
        hostId: "local",
        supervisedPreferred: true,
      }),
    );

    for (const mutation of [
      { hostId: "other-box" },
      { role: "remote" as const },
      { role: "" as const },
    ]) {
      const result = await runEither(service.setStationTopology(mutation));
      expect(Result.isFailure(result)).toBe(true);
    }

    const next = await run(
      service.setStationTopology({ supervisedPreferred: false }),
    );
    expect(next.station).toMatchObject({
      role: "command-center",
      hostId: "local",
      supervisedPreferred: false,
    });
  });

  it("refuses to invent a Remote identity through local Settings", async () => {
    const { service, state } = await openService();
    const result = await runEither(
      service.setStationTopology({
        role: "remote",
        hostId: "studio",
        agentHostId: "studio",
        supervisedPreferred: true,
      }),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain("Station API");
    }
    // v1 auto-establishes Command Center; remote invent still fails and leaves CC.
    expect((await run(service.get)).station).toEqual({
      role: "command-center",
      hostId: "local",
      supervisedPreferred: false,
    });
    expect(
      await run(
        state.read("test.settings.no-remote", (reader) =>
          reader.get(
            "SELECT role FROM station_configuration WHERE singleton = 1",
          )
        ),
      ),
    ).toEqual({ role: "command-center" });
  });

  it("rejects the retired topologyIntegrity field instead of ignoring it", async () => {
    const { service } = await openService();
    const result = await runEither(
      service.setStationTopology({
        role: "command-center",
        topologyIntegrity: "ok",
      }),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toMatch(
        /topologyIntegrity|Unexpected key/i,
      );
    }
    expect((await run(service.get)).station.role).toBe("command-center");
  });

  it("reset preserves protected topology and refuses station reset", async () => {
    const { service } = await openService();
    await run(
      service.setStationTopology({
        role: "command-center",
        hostId: "local",
      }),
    );
    await run(service.patch({ browser: { maxVisibleSurfaces: 4 } }));
    const reset = await run(service.reset());
    expect(reset.station.role).toBe("command-center");
    expect(reset.browser.maxVisibleSurfaces).toBe(
      defaultSettings().browser.maxVisibleSurfaces,
    );
    expect(Result.isFailure(await runEither(service.reset("station")))).toBe(
      true,
    );
  });

  it("reports database-backed settings health without leaking paths", async () => {
    const { service } = await openService({
      probeSupervised: async () => "absent",
    });
    const check = await run(service.doctor);
    expect(check.id).toBe("settings");
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("junto.db");
    expect(check.detail).toContain("v1");
    expect(check.detail).not.toContain(root);
    expect(check.metadata).toMatchObject({
      version: "1",
      role: "command-center",
      hostId: "local",
      supervisedPreferred: "false",
      supervisedInstalled: "absent",
      supervisedAligned: "true",
    });
  });

  it("fails closed on malformed canonical Remote configuration", async () => {
    const { service, state } = await openService();
    await run(
      state.transaction("test.settings.invalidRemote", (writer) => {
        writer.run(
          `INSERT INTO station_known_installations(
             installation_id,
             registered_at
           ) VALUES ('command-id', ?)`,
          ["2026-07-27T12:00:00.000Z"],
        );
        // Replace auto-established CC with a malformed Remote row.
        writer.run(
          `INSERT INTO station_configuration(
             singleton,
             role,
             host_id,
             agent_host_id,
             command_center_installation_id,
             supervised_preferred,
             configured_at
           ) VALUES (1, 'remote', ?, 'studio', 'command-id', 1, ?)
           ON CONFLICT(singleton) DO UPDATE SET
             role = excluded.role,
             host_id = excluded.host_id,
             agent_host_id = excluded.agent_host_id,
             command_center_installation_id =
               excluded.command_center_installation_id,
             supervised_preferred = excluded.supervised_preferred,
             configured_at = excluded.configured_at`,
          [
            "-invalid-host",
            "2026-07-27T12:00:00.000Z",
          ],
        );
      }),
    );
    const result = await runEither(service.get);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.code).toBe("corrupt");
      expect(result.failure.message).toContain(
        "canonical station configuration is invalid",
      );
    }
  });

  it("ignores an unknown stored preference key without rewriting the row", async () => {
    const { service, state } = await openService();
    const before = await run(
      state.read(
        "test.settings.read-canonical",
        (reader) =>
          reader.get<
            Record<string, StateOutputValue> & { body: string }
          >(
            "SELECT body FROM settings_preferences WHERE singleton = 1",
          )?.body,
      ),
    );
    const encoded = JSON.stringify({
      ...JSON.parse(String(before)) as Record<string, unknown>,
      retiredCompatibility: true,
    });
    await run(
      state.transaction("test.settings.excessDurable", (writer) => {
        writer.run(
          "UPDATE settings_preferences SET body = ? WHERE singleton = 1",
          [encoded],
        );
      }),
    );

    const result = await runEither(service.get);
    const after = await run(
      state.read(
        "test.settings.read-rejected",
        (reader) =>
          reader.get<
            Record<string, StateOutputValue> & { body: string }
          >(
            "SELECT body FROM settings_preferences WHERE singleton = 1",
          )?.body,
      ),
    );

    // A removed feature's stored key simply goes away: get() succeeds, the
    // unknown key is absent from the result, and the row is NOT rewritten
    // on read (writes happen only through the patch path).
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect("retiredCompatibility" in result.success).toBe(false);
    }
    expect(after).toBe(encoded);
  });

  it("does not reinterpret row loss as a fresh database", async () => {
    const { state } = await openService();
    await run(
      state.transaction("test.settings.removeAggregate", (writer) => {
        writer.run("DELETE FROM settings_preferences WHERE singleton = 1");
      }),
    );
    await closeActive();

    const runtime = ManagedRuntime.make(makeStateEngineLive(databasePath));
    try {
      const reopenedState = await runtime.runPromise(StateEngine);
      const result = await runEither(makeSettingsService(reopenedState));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.code).toBe("corrupt");
    } finally {
      await runtime.dispose();
    }
  });

  it("round-trips a partial terminal patch through the real service", async () => {
    const first = await openService();
    // Absent fragment resolves to today's terminal before anything is written.
    expect(await run(first.service.get).then((s) => s.terminal)).toEqual(
      defaultTerminal(),
    );

    const patched = await run(
      first.service.patch({
        terminal: { scrollSensitivity: 8, cursorBlink: false, bell: "visual" },
      }),
    );
    // Partial patch: the three named fields move, the other eight do not.
    expect(patched.terminal).toEqual({
      ...defaultTerminal(),
      scrollSensitivity: 8,
      cursorBlink: false,
      bell: "visual",
    });

    const second = await openService();
    const reloaded = await run(second.service.get);
    expect(reloaded.terminal).toEqual({
      ...defaultTerminal(),
      scrollSensitivity: 8,
      cursorBlink: false,
      bell: "visual",
    });

    // A second partial patch composes onto the persisted row, not onto defaults.
    const again = await run(
      second.service.patch({ terminal: { fontSize: 16 } }),
    );
    expect(again.terminal).toEqual({
      ...defaultTerminal(),
      scrollSensitivity: 8,
      cursorBlink: false,
      bell: "visual",
      fontSize: 16,
    });
  });

  it("refuses an out-of-range terminal value at the service boundary", async () => {
    const { service } = await openService();
    const result = await runEither(
      service.patch({ terminal: { scrollback: 0 } }),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.code).toBe("validation");
    // The refusal left the persisted row alone.
    expect((await run(service.get)).terminal?.scrollback).toBe(
      defaultTerminal().scrollback,
    );
  });

  it("resets only the terminal section", async () => {
    const { service } = await openService();
    await run(
      service.patch({
        terminal: { fontSize: 20 },
        appearance: { reduceMotion: true },
      }),
    );
    const reset = await run(service.reset("terminal"));
    expect(reset.terminal).toEqual(defaultTerminal());
    expect(reset.appearance.reduceMotion).toBe(true);
  });

  it("enforces JSON validity in the SQLite schema", async () => {
    const { state } = await openService();
    const result = await runEither(
      state.transaction("test.settings.corruptJson", (writer) => {
        writer.run(
          "UPDATE settings_preferences SET body = ? WHERE singleton = 1",
          ["{broken"],
        );
      }),
    );
    expect(Result.isFailure(result)).toBe(true);
  });
});

describe("terminal settings fragment", () => {
  const decodeTerminal = Schema.decodeUnknownResult(TerminalSettings, {
    onExcessProperty: "error",
  });
  const accepts = (field: keyof TerminalSettings, value: number): boolean =>
    Result.isSuccess(decodeTerminal({ ...defaultTerminal(), [field]: value }));

  it("defaults reproduce the terminal the surface already builds", () => {
    // The literals in shared/settings.ts are a second copy of renderer
    // constants; pin them so the copies cannot drift apart unnoticed.
    expect(defaultTerminal().fontSize).toBe(MONO_CELL.fontSizePx);
    expect(defaultTerminal().fontSize).toBe(JUNTO_XTERM_FONT_SIZE);
    expect(defaultTerminal().fontFamily).toBe(JUNTO_XTERM_FONT_FAMILY);
    // The values the surface hardcoded inline.
    expect(defaultTerminal().lineHeight).toBe(1.2);
    expect(defaultTerminal().scrollback).toBe(10_000);
    expect(defaultTerminal().scrollSensitivity).toBe(3);
    // xterm's own effective defaults, which the surface never overrode.
    expect(defaultTerminal().cursorStyle).toBe("block");
    expect(defaultTerminal().minimumContrastRatio).toBe(4.5);
    expect(defaultTerminal().letterSpacing).toBe(0);
    expect(defaultTerminal().screenReaderMode).toBe(false);
    // Blink is on because the surface blinks whenever the terminal is visible;
    // the preference gates that behaviour rather than replacing it.
    expect(defaultTerminal().cursorBlink).toBe(true);
    // Nothing subscribes to xterm's onBell today.
    expect(defaultTerminal().bell).toBe("off");
    expect(defaultSettings().terminal).toEqual(defaultTerminal());
  });

  it("rejects every numeric field at both ends of its bound", () => {
    const integers = ["scrollSensitivity", "fontSize", "scrollback"] as const;
    for (const field of integers) {
      const { min, max } = TERMINAL_BOUNDS[field];
      expect([field, "min", accepts(field, min)]).toEqual([field, "min", true]);
      expect([field, "max", accepts(field, max)]).toEqual([field, "max", true]);
      expect([field, "under", accepts(field, min - 1)]).toEqual([field, "under", false]);
      expect([field, "over", accepts(field, max + 1)]).toEqual([field, "over", false]);
      // Whole lines / whole pixels only.
      expect([field, "fraction", accepts(field, min + 0.5)]).toEqual([field, "fraction", false]);
    }

    const fractionals = ["minimumContrastRatio", "lineHeight", "letterSpacing"] as const;
    for (const field of fractionals) {
      const { min, max } = TERMINAL_BOUNDS[field];
      expect([field, "min", accepts(field, min)]).toEqual([field, "min", true]);
      expect([field, "max", accepts(field, max)]).toEqual([field, "max", true]);
      expect([field, "under", accepts(field, min - 0.1)]).toEqual([field, "under", false]);
      expect([field, "over", accepts(field, max + 0.1)]).toEqual([field, "over", false]);
      // A midpoint is a legitimate value for these, unlike the integer fields.
      expect([field, "mid", accepts(field, (min + max) / 2)]).toEqual([field, "mid", true]);
    }

    // The two footguns the operator named, stated directly.
    expect(accepts("scrollback", 0)).toBe(false);
    expect(accepts("fontSize", 2000)).toBe(false);
    // Neither NaN nor Infinity slips past isBetween.
    expect(accepts("lineHeight", Number.NaN)).toBe(false);
    expect(accepts("scrollback", Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("rejects an empty or oversized font stack and unknown enum values", () => {
    expect(
      Result.isSuccess(decodeTerminal({ ...defaultTerminal(), fontFamily: "" })),
    ).toBe(false);
    expect(
      Result.isSuccess(
        decodeTerminal({
          ...defaultTerminal(),
          fontFamily: "x".repeat(TERMINAL_BOUNDS.fontFamily.maxLength + 1),
        }),
      ),
    ).toBe(false);
    expect(
      Result.isSuccess(
        decodeTerminal({
          ...defaultTerminal(),
          fontFamily: "x".repeat(TERMINAL_BOUNDS.fontFamily.maxLength),
        }),
      ),
    ).toBe(true);
    expect(
      Result.isSuccess(decodeTerminal({ ...defaultTerminal(), cursorStyle: "beam" })),
    ).toBe(false);
    expect(
      Result.isSuccess(decodeTerminal({ ...defaultTerminal(), bell: "loud" })),
    ).toBe(false);
  });

  it("holds the same bounds on the patch surface as on the fragment", () => {
    expect(Result.isFailure(decodePatchInput({ terminal: { scrollback: 0 } }))).toBe(true);
    expect(Result.isFailure(decodePatchInput({ terminal: { fontSize: 2000 } }))).toBe(true);
    expect(Result.isFailure(decodePatchInput({ terminal: { lineHeight: 0.5 } }))).toBe(true);
    expect(Result.isFailure(decodePatchInput({ terminal: { letterSpacing: -1 } }))).toBe(true);
    expect(Result.isSuccess(decodePatchInput({ terminal: { scrollSensitivity: 8 } }))).toBe(true);
    // Excess keys are rejected here exactly as they are on every other section.
    expect(Result.isFailure(decodePatchInput({ terminal: { cursorWidth: 2 } }))).toBe(true);
  });

  it("decodes a stored row written without the terminal fragment", () => {
    const {
      version: _version,
      station,
      terminal: _terminal,
      ...preferencesWithoutTerminal
    } = defaultSettings();
    expect("terminal" in preferencesWithoutTerminal).toBe(false);

    const decoded = decodeStoredSettings(
      SETTINGS_VERSION,
      preferencesWithoutTerminal,
      station,
    );
    expect(decoded.terminal).toEqual(defaultTerminal());
    // And the rest of the aggregate is untouched by the fill-in.
    expect(decoded.appearance).toEqual(defaultSettings().appearance);
  });

  it("resolves an absent fragment to defaults on read", () => {
    expect(
      terminalSettings({ ...defaultSettings(), terminal: undefined }),
    ).toEqual(defaultTerminal());
    expect(terminalSettings(undefined)).toEqual(defaultTerminal());
    expect(terminalSettings(defaultSettings())).toEqual(defaultTerminal());
  });

  it("merges a partial terminal patch field by field", () => {
    const next = applySettingsPatch(defaultSettings(), {
      terminal: { scrollSensitivity: 6, cursorStyle: "bar" },
    });
    expect(next.terminal).toEqual({
      ...defaultTerminal(),
      scrollSensitivity: 6,
      cursorStyle: "bar",
    });
    // Merging onto an aggregate whose fragment is absent starts from defaults.
    const fromAbsent = applySettingsPatch(
      { ...defaultSettings(), terminal: undefined },
      { terminal: { fontSize: 15 } },
    );
    expect(fromAbsent.terminal).toEqual({ ...defaultTerminal(), fontSize: 15 });
  });

  it("survives a patch that names no terminal keys at all", () => {
    const next = applySettingsPatch(defaultSettings(), { appearance: { reduceMotion: true } });
    expect(next.terminal).toEqual(defaultTerminal());
  });
});
