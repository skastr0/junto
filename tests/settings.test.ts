import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Result, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  SETTINGS_VERSION,
  MachineSettings,
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
  decodeMachinePreferencesPatch,
} from "../src/main/junto/settings/patch";
import {
  decodeStoredSettings,
} from "../src/main/junto/settings/state-schema";
import {
  makeSettingsService,
  type SettingsServiceApi,
} from "../src/main/junto/settings/service";
import {
  CredentialBindingRepository,
} from "../src/main/junto/credentials/bindings";
import { MachineConfigurationRepository } from "../src/main/junto/machines/configuration";
import { defaultMachineName } from "../src/shared/machine-name";
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
    expect(settings.advanced.logsExplorer).toBe(false);
  });

  it("applySettingsPatch merges ordinary sections", () => {
    const next = applySettingsPatch(defaultSettings(), {
      appearance: { reduceMotion: true },
      browser: { maxVisibleSurfaces: 4 },
    });
    expect(next.appearance.reduceMotion).toBe(true);
    expect(next.appearance.theme).toBe("system");
    expect(next.browser.maxVisibleSurfaces).toBe(4);
    expect(next.browser.maxWarmSessions).toBe(3);
  });

  it("rejects the retired topologyIntegrity field at every decode boundary", () => {
    const retiredStation = {
      ...defaultSettings().machine,
      topologyIntegrity: "ok",
    };
    expect("topologyIntegrity" in defaultSettings().machine).toBe(false);
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(MachineSettings, {
          onExcessProperty: "error",
        })(retiredStation),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decodePatchInput({
          machine: { topologyIntegrity: "ok" },
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decodeMachinePreferencesPatch({ topologyIntegrity: "ok" }),
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
        decodePatchInput({ fleet: { remoteManagedInstalls: true } }),
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
    const { version: _version, machine, ...preferences } = defaultSettings();
    const decoded = decodeStoredSettings(
      SETTINGS_VERSION,
      {
        ...preferences,
        appearance: { ...preferences.appearance, theme: "deep-field" },
      },
      machine,
    );
    expect(decoded.appearance.theme).toBe("dark");
  });

  it("ignores unknown stored keys (a removed feature's setting just goes away) but rejects unknown patch fields", () => {
    const defaults = defaultSettings();
    const {
      version: _version,
      machine,
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
      machine,
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
        decodeMachinePreferencesPatch({ legacyManagedRollback: true }),
      ),
    ).toBe(true);
  });
});

type Harness = {
  readonly service: SettingsServiceApi;
  readonly sql: SqlClient.SqlClient;
  readonly close: () => Promise<void>;
};

describe("SQLite settings service", () => {
  let root = "";
  let databasePath = "";
  let active: Harness | undefined;
  const makeRuntime = () => ManagedRuntime.make(
    Layer.mergeAll(CredentialBindingRepository.layer, MachineConfigurationRepository.layer).pipe(
      Layer.provideMerge(makeStateEngineLive(databasePath)),
    ),
  );

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
    const runtime = makeRuntime();
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    const service = await runtime.runPromise(
      makeSettingsService(databasePath, {
        probeSupervised: options.probeSupervised,
      }),
    );
    const harness = {
      service,
      sql,
      close: () => runtime.dispose(),
    };
    active = harness;
    return harness;
  };

  it("initializes preferences and this machine's canonical name in SQLite", async () => {
    const { service, sql } = await openService();
    const settings = await run(service.get);
    expect(settings).toEqual({
      ...defaultSettings(),
      machine: {
        name: defaultMachineName(),
        supervisedPreferred: false,
      },
    });

    const counts = await run(
      Effect.gen(function* () {
        const preferences = yield* sql<{ count: number }>`SELECT count(*) AS count FROM settings_preferences`;
        const machine = yield* sql<{ count: number }>`SELECT count(*) AS count FROM machine_configuration`;
        const initialization = yield* sql<{ count: number }>`SELECT count(*) AS count FROM settings_initialization`;
        return {
          preferences: Number(preferences[0]?.count ?? -1),
          machineConfiguration: Number(machine[0]?.count ?? -1),
          initialization: Number(initialization[0]?.count ?? -1),
        };
      }),
    );
    expect(counts).toEqual({
      preferences: 1,
      machineConfiguration: 1,
      initialization: 1,
    });
  });

  it("persists preferences and canonical machine configuration across restart", async () => {
    const first = await openService();
    await run(
      first.service.setMachinePreferences({
        supervisedPreferred: true,
      }),
    );
    await run(
      first.service.patch({
        appearance: { reduceMotion: true },
      }),
    );

    const second = await openService();
    const reloaded = await run(second.service.get);
    expect(reloaded.machine.name).toBe(defaultMachineName());
    expect(reloaded.appearance.reduceMotion).toBe(true);
  });

  it("commits generic preference patches without rewriting machine configuration", async () => {
    const { service, sql } = await openService();
    await run(
      service.setMachinePreferences({
        supervisedPreferred: true,
      }),
    );
    const before = await run(
      sql`SELECT machine_name, configured_at FROM machine_configuration WHERE singleton = 1`.pipe(Effect.map((rows) => rows[0])),
    );

    await run(service.patch({ browser: { maxVisibleSurfaces: 4 } }));
    const after = await run(
      sql`SELECT machine_name, configured_at FROM machine_configuration WHERE singleton = 1`.pipe(Effect.map((rows) => rows[0])),
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
        ],
        { concurrency: "unbounded" },
      ),
    );
    const settings = await run(service.get);
    expect(settings.appearance.reduceMotion).toBe(true);
    expect(settings.browser.maxVisibleSurfaces).toBe(4);
  });

  it("publishes subscribers only after a successful commit", async () => {
    const { service, sql } = await openService();
    const observed: Array<{
      readonly notified: number;
      readonly persisted: number;
    }> = [];
    service.subscribe((settings) => {
      const persisted = Effect.runSync(
        Effect.gen(function* () {
          const rows = yield* sql<{ body: string }>`SELECT body FROM settings_preferences WHERE singleton = 1`;
          return (
            JSON.parse(String(rows[0]?.body)) as {
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
    const { service, sql } = await openService();
    const observed: unknown[] = [];
    service.subscribe((settings) => observed.push(settings));
    const before = await run(
      sql<{ body: string }>`SELECT body FROM settings_preferences WHERE singleton = 1`.pipe(Effect.map((rows) => rows[0]?.body)),
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
      sql<{ body: string }>`SELECT body FROM settings_preferences WHERE singleton = 1`.pipe(Effect.map((rows) => rows[0]?.body)),
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

  it("protects name and supervision from generic patches", async () => {
    const { service } = await openService();
    for (const input of [{ machine: { name: "studio" } }, { machine: { supervisedPreferred: true } }]) {
      const result = await runEither(service.patch(input));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.message).toContain("settingsSetMachinePreferences");
    }
    expect((await run(service.get)).machine).toEqual({ name: defaultMachineName(), supervisedPreferred: false });
  });

  it("changes supervision without changing identity and rejects other fields", async () => {
    const { service } = await openService();
    const next = await run(service.setMachinePreferences({ supervisedPreferred: true }));
    expect(next.machine).toEqual({ name: defaultMachineName(), supervisedPreferred: true });
    expect(Result.isFailure(await runEither(service.setMachinePreferences({ name: "studio" })))).toBe(true);
    expect((await run(service.get)).machine).toEqual(next.machine);
  });

  it("reset keeps this machine's name and supervision preference", async () => {
    const { service } = await openService();
    const changed = await run(service.setMachinePreferences({ supervisedPreferred: true }));
    await run(service.patch({ browser: { maxVisibleSurfaces: 4 } }));
    const reset = await run(service.reset());
    expect(reset.machine).toEqual(changed.machine);
    expect(reset.browser).toEqual(defaultSettings().browser);
    expect(Result.isFailure(await runEither(service.reset("machine")))).toBe(true);
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
      machineName: defaultMachineName(),
      supervisedPreferred: "false",
      supervisedInstalled: "absent",
      supervisedAligned: "true",
    });
  });

  it("ignores an unknown stored preference key without rewriting the row", async () => {
    const { service, sql } = await openService();
    const before = await run(
      sql<{ body: string }>`SELECT body FROM settings_preferences WHERE singleton = 1`.pipe(Effect.map((rows) => rows[0]?.body)),
    );
    const encoded = JSON.stringify({
      ...JSON.parse(String(before)) as Record<string, unknown>,
      retiredCompatibility: true,
    });
    await run(
      sql.withTransaction(sql`UPDATE settings_preferences SET body = ${encoded} WHERE singleton = 1`),
    );

    const result = await runEither(service.get);
    const after = await run(
      sql<{ body: string }>`SELECT body FROM settings_preferences WHERE singleton = 1`.pipe(Effect.map((rows) => rows[0]?.body)),
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
    const { sql } = await openService();
    await run(
      sql.withTransaction(sql`DELETE FROM settings_preferences WHERE singleton = 1`),
    );
    await closeActive();

    const runtime = makeRuntime();
    try {
      const result = await runtime.runPromise(Effect.result(makeSettingsService(databasePath)));
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
    const { sql } = await openService();
    const result = await runEither(
      sql.withTransaction(sql`UPDATE settings_preferences SET body = ${"{broken"} WHERE singleton = 1`),
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
      machine,
      terminal: _terminal,
      ...preferencesWithoutTerminal
    } = defaultSettings();
    expect("terminal" in preferencesWithoutTerminal).toBe(false);

    const decoded = decodeStoredSettings(
      SETTINGS_VERSION,
      preferencesWithoutTerminal,
      machine,
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
