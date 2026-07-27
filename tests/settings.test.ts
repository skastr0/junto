import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Either, ManagedRuntime, Schema } from "effect";
import {
  SETTINGS_VERSION,
  StationSettings,
  applySettingsPatch,
  defaultSettings,
} from "../src/shared/settings";
import {
  applyAndValidatePatch,
  decodePatchInput,
  decodeStationTopologyPatch,
} from "../src/main/vellum/settings/patch";
import {
  makeSettingsService,
  type SettingsServiceApi,
} from "../src/main/vellum/settings/service";
import {
  StateEngine,
  type StateOutputValue,
} from "../src/main/vellum/state/service";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect);
const runEither = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.either(effect));

describe("settings contract", () => {
  it("defaultSettings is a valid v1 document", () => {
    const settings = defaultSettings();
    expect(settings.version).toBe(SETTINGS_VERSION);
    expect(settings.appearance.theme).toBe("deep-field");
    expect(settings.browser.maxVisibleSurfaces).toBe(2);
    expect(settings.browser.maxWarmSessions).toBe(3);
  });

  it("applySettingsPatch merges ordinary and fleet sections", () => {
    const next = applySettingsPatch(defaultSettings(), {
      appearance: { reduceMotion: true },
      browser: { maxVisibleSurfaces: 4 },
      fleet: { remoteManagedInstalls: true },
    });
    expect(next.appearance.reduceMotion).toBe(true);
    expect(next.appearance.theme).toBe("deep-field");
    expect(next.browser.maxVisibleSurfaces).toBe(4);
    expect(next.browser.maxWarmSessions).toBe(3);
    expect(next.fleet.remoteManagedInstalls).toBe(true);
  });

  it("rejects the retired topologyIntegrity field at every decode boundary", () => {
    const retiredStation = {
      ...defaultSettings().station,
      topologyIntegrity: "ok",
    };
    expect("topologyIntegrity" in defaultSettings().station).toBe(false);
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(StationSettings)(retiredStation),
      ),
    ).toBe(true);
    expect(
      Either.isLeft(
        decodePatchInput({
          station: { topologyIntegrity: "ok" },
        }),
      ),
    ).toBe(true);
    expect(
      Either.isLeft(
        decodeStationTopologyPatch({ topologyIntegrity: "ok" }),
      ),
    ).toBe(true);
  });

  it("patch decoding and aggregate validation reject invalid limits", () => {
    expect(
      Either.isLeft(
        decodePatchInput({ browser: { maxVisibleSurfaces: 999 } }),
      ),
    ).toBe(true);
    expect(
      Either.isRight(
        applyAndValidatePatch(defaultSettings(), {
          kernel: { pulseLogRetention: 40 },
        }),
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
    root = await mkdtemp(join(tmpdir(), "vellum-settings-sqlite-"));
    databasePath = join(root, "state", "vellum.db");
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

  it("initializes defaults in SQLite", async () => {
    const { service, state } = await openService();
    const settings = await run(service.get);
    expect(settings).toEqual(defaultSettings());
    expect(service.databasePath()).toBe(databasePath);

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
      stationConfiguration: 0,
      initialization: 1,
    });
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
        fleet: { remoteManagedInstalls: true },
      }),
    );

    const second = await openService();
    const reloaded = await run(second.service.get);
    expect(reloaded.station.role).toBe("command-center");
    expect(reloaded.appearance.reduceMotion).toBe(true);
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
    expect(Either.isLeft(failed)).toBe(true);
    expect(observed).toHaveLength(1);
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
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("validation");
      expect(result.left.message).toContain("settingsSetStationTopology");
    }
    expect((await run(service.get)).station.role).toBe("");
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
      expect(Either.isLeft(result)).toBe(true);
    }

    const next = await run(
      service.setStationTopology({ supervisedPreferred: false }),
    );
    expect(next.station).toMatchObject({
      role: "command-center",
      hostId: "local",
      commandCenterRef: "",
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
        commandCenterRef: "command.tailnet",
        supervisedPreferred: true,
      }),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.message).toContain("Station API");
    }
    expect((await run(service.get)).station).toEqual(defaultSettings().station);
    expect(
      await run(
        state.read("test.settings.no-remote", (reader) =>
          reader.get(
            "SELECT role FROM station_configuration WHERE singleton = 1",
          )
        ),
      ),
    ).toBeUndefined();
  });

  it("rejects the retired topologyIntegrity field instead of ignoring it", async () => {
    const { service } = await openService();
    const result = await runEither(
      service.setStationTopology({
        role: "command-center",
        topologyIntegrity: "ok",
      }),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.message).toContain("topologyIntegrity is retired");
    }
    expect((await run(service.get)).station.role).toBe("");
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
    expect(Either.isLeft(await runEither(service.reset("station")))).toBe(
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
    expect(check.detail).toContain("vellum.db");
    expect(check.detail).toContain("v1");
    expect(check.detail).not.toContain(root);
    expect(check.metadata).toMatchObject({
      version: "1",
      role: "unset",
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
          `INSERT INTO station_configuration(
             singleton,
             role,
             host_id,
             agent_host_id,
             command_center_installation_id,
             command_center_ref,
             supervised_preferred,
             configured_at
           ) VALUES (1, 'remote', ?, 'studio', 'command-id', 'command.tailnet', 1, ?)`,
          [
            "-invalid-host",
            "2026-07-27T12:00:00.000Z",
          ],
        );
      }),
    );
    const result = await runEither(service.get);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("corrupt");
      expect(result.left.message).toContain(
        "canonical station configuration is invalid",
      );
    }
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
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) expect(result.left.code).toBe("corrupt");
    } finally {
      await runtime.dispose();
    }
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
    expect(Either.isLeft(result)).toBe(true);
  });
});
