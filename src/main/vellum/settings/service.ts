import { constants } from "node:fs";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { Context, Effect, Either, Layer } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import {
  SETTINGS_MAX_FILE_BYTES,
  SettingsError,
  defaultSection,
  defaultSettings,
  type Settings,
  type SettingsSectionKey,
} from "@shared/settings";
import { assessSupervisedRuntime } from "@shared/station";
import {
  applyAndValidatePatch,
  decodePatchInput,
  decodeStationTopologyPatch,
  migrateSettingsDocument,
} from "./migrate";
import { probeSupervisedRuntime, type SupervisedProbe } from "./supervised-probe";
import {
  admitStationTopology,
  topologyFromStation,
  writeTopologySeal,
} from "./topology-seal";

// SettingsService: durable prefs + topology gate.
//
// Path defaults to ~/.vellum/settings.json (agent-readable home). Tests override
// via VELLUM_SETTINGS_PATH (exact file) — never accept a path from the renderer.
//
// Split mental model:
// - **prefs** (appearance/canvas/kernel/browser/audio/advanced) — ambient
//   settings.json, generic settingsPatch.
// - **topology** (station.*) — app-owned seal (topology.key + topology.seal).
//   Load admits only sealed topology; generic patch rejects station keys;
//   setStationTopology is the sole app write path that mutates + reseals.

export class SettingsService extends Context.Tag("@vellum/SettingsService")<
  SettingsService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly get: Effect.Effect<Settings, SettingsError>;
    readonly patch: (input: unknown) => Effect.Effect<Settings, SettingsError>;
    /**
     * Dedicated topology transition. Merges station fields, persists, and
     * writes the app-owned topology seal. Not available via settingsPatch.
     */
    readonly setStationTopology: (
      input: unknown,
    ) => Effect.Effect<Settings, SettingsError>;
    readonly reset: (
      section?: SettingsSectionKey,
    ) => Effect.Effect<Settings, SettingsError>;
    readonly path: () => string;
    readonly subscribe: (listener: (settings: Settings) => void) => () => void;
  }
>() {}

export const settingsFilePath = (): string =>
  process.env.VELLUM_SETTINGS_PATH || join(homedir(), ".vellum", "settings.json");

const toIoError = (error: unknown): SettingsError =>
  error instanceof SettingsError
    ? error
    : new SettingsError({
        message: error instanceof Error ? error.message : String(error),
        code: "io",
      });

const atomicWrite = async (path: string, settings: Settings): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify(settings, null, 2)}\n`;
  if (Buffer.byteLength(body, "utf8") > SETTINGS_MAX_FILE_BYTES) {
    throw new SettingsError({
      message: `settings document exceeds ${SETTINGS_MAX_FILE_BYTES} byte ceiling`,
      code: "validation",
    });
  }
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(tmp, path);
};

const loadFromDisk = async (path: string): Promise<Settings> => {
  let raw: string;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile()) {
      throw new SettingsError({
        message: "settings path is not a regular file",
        code: "corrupt",
      });
    }
    if (info.size > SETTINGS_MAX_FILE_BYTES) {
      throw new SettingsError({
        message: `settings file exceeds ${SETTINGS_MAX_FILE_BYTES} byte ceiling`,
        code: "corrupt",
      });
    }
    // Older builds inherited the login umask and could leave settings
    // group-readable. Repair the already-open inode before reading it so a
    // path swap cannot redirect chmod to another file.
    await file.chmod(0o600);
    raw = await file.readFile("utf8");
  } catch (error) {
    if (error instanceof SettingsError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const fresh = defaultSettings();
      await atomicWrite(path, fresh);
      // First create: seal empty topology so later offline role mint fails closed.
      await writeTopologySeal(path, topologyFromStation(fresh.station));
      return fresh;
    }
    throw error;
  } finally {
    await file?.close();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new SettingsError({
      message: `settings.json unreadable — refusing to treat as empty (${
        error instanceof Error ? error.message : String(error)
      })`,
      code: "corrupt",
    });
  }

  const migrated = migrateSettingsDocument(parsed);
  if (Either.isLeft(migrated)) {
    throw migrated.left;
  }

  const admitted = await admitStationTopology(path, migrated.right);
  if (
    admitted.outcome === "integrity-failed" ||
    admitted.resealed === true ||
    (admitted.outcome === "bootstrap" &&
      JSON.stringify(admitted.settings.station) !==
        JSON.stringify(migrated.right.station))
  ) {
    // Persist integrity-failed lock, legacy seal migration, or bootstrap heal
    // so disk and live view agree — never leave a sealed lock only in memory.
    await atomicWrite(path, admitted.settings);
  }
  return admitted.settings;
};

export interface SettingsServiceApi {
  readonly doctor: Effect.Effect<ServiceCheck>;
  readonly get: Effect.Effect<Settings, SettingsError>;
  readonly patch: (input: unknown) => Effect.Effect<Settings, SettingsError>;
  readonly setStationTopology: (
    input: unknown,
  ) => Effect.Effect<Settings, SettingsError>;
  readonly reset: (
    section?: SettingsSectionKey,
  ) => Effect.Effect<Settings, SettingsError>;
  readonly path: () => string;
  readonly subscribe: (listener: (settings: Settings) => void) => () => void;
}

export type SettingsServiceOptions = {
  /** Override LaunchAgent probe (tests). Default: real launchctl print. */
  readonly probeSupervised?: SupervisedProbe;
};

export const makeSettingsService = (
  path: string = settingsFilePath(),
  options: SettingsServiceOptions = {},
): SettingsServiceApi => {
  const probeSupervised = options.probeSupervised ?? probeSupervisedRuntime;
  let cached: Settings | undefined;
  let inFlight: Promise<Settings> | null = null;
  // Serialize patch/reset/topology RMW so concurrent IPC cannot last-writer-clobber.
  let writeChain: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(settings: Settings) => void>();

  const notify = (settings: Settings) => {
    for (const listener of listeners) listener(settings);
  };

  const ensureLoaded = async (): Promise<Settings> => {
    if (cached) return cached;
    if (inFlight) return inFlight;
    const promise = loadFromDisk(path)
      .then((settings) => {
        cached = settings;
        return settings;
      })
      .finally(() => {
        if (inFlight === promise) inFlight = null;
      });
    inFlight = promise;
    return promise;
  };

  const writeState = async (settings: Settings): Promise<Settings> => {
    await atomicWrite(path, settings);
    await writeTopologySeal(path, topologyFromStation(settings.station));
    cached = settings;
    notify(settings);
    return settings;
  };

  const withWriteLock = <A>(fn: () => Promise<A>): Promise<A> => {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    path: () => path,
    doctor: Effect.tryPromise({
      try: async (): Promise<ServiceCheck> => {
        try {
          const settings = await ensureLoaded();
          const supervisedInstalled = await probeSupervised();
          const supervised = assessSupervisedRuntime({
            role: settings.station.role,
            hostId: settings.station.hostId,
            supervisedPreferred: settings.station.supervisedPreferred,
            supervisedInstalled,
          });
          const status =
            supervised.status === "warning" ? ("warning" as const) : ("ok" as const);
          return {
            id: "settings",
            label: "User Settings",
            status,
            detail: `settings.json · v${settings.version} · ${supervised.detail}`,
            metadata: {
              version: String(settings.version),
              ...supervised.metadata,
            },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            id: "settings",
            label: "User Settings",
            status: "error" as const,
            detail: message,
          };
        }
      },
      catch: (error) => toIoError(error),
    }).pipe(
      Effect.catchAll((error) =>
        Effect.succeed({
          id: "settings",
          label: "User Settings",
          status: "error" as const,
          detail: error.message,
        }),
      ),
    ),
    get: Effect.tryPromise({
      try: () => ensureLoaded(),
      catch: (error) => toIoError(error),
    }),
    patch: (input: unknown) =>
      Effect.tryPromise({
        try: () =>
          withWriteLock(async () => {
            const patchEither = decodePatchInput(input);
            if (Either.isLeft(patchEither)) throw patchEither.left;
            // Option B: topology never mutates through generic prefs patch.
            if (patchEither.right.station !== undefined) {
              throw new SettingsError({
                message:
                  "station topology is protected — use settingsSetStationTopology for role/host/commandCenterRef/supervisedPreferred",
                code: "validation",
              });
            }
            const current = await ensureLoaded();
            const nextEither = applyAndValidatePatch(current, patchEither.right);
            if (Either.isLeft(nextEither)) throw nextEither.left;
            if (JSON.stringify(current) === JSON.stringify(nextEither.right)) {
              return current;
            }
            return writeState(nextEither.right);
          }),
        catch: (error) => toIoError(error),
      }),
    setStationTopology: (input: unknown) =>
      Effect.tryPromise({
        try: () =>
          withWriteLock(async () => {
            const patchEither = decodeStationTopologyPatch(input);
            if (Either.isLeft(patchEither)) throw patchEither.left;
            const current = await ensureLoaded();
            // Integrity-failed is not first-run: refuse ordinary role mint.
            // Recovery / transfer ceremony is a dedicated path (not Settings).
            if (current.station.topologyIntegrity === "failed") {
              throw new SettingsError({
                message:
                  "Topology integrity failed — recovery requires an explicit Command Center transfer ceremony; Settings cannot promote this station to command-center or remote",
                code: "validation",
              });
            }
            // Validate via full aggregate decode after merge. App writes always
            // land as integrity-ok (failed is only set by admit on seal breach).
            const stationPatch = {
              ...patchEither.right,
              topologyIntegrity: "ok" as const,
            };
            const validated = applyAndValidatePatch(current, {
              station: stationPatch,
            });
            if (Either.isLeft(validated)) throw validated.left;
            const prevRole = current.station.role;
            const nextRole = validated.right.station.role;
            // Doctrine: role transitions between sealed roles (or clearing a
            // sealed role) are Command Center transfer / migration ceremonies —
            // not Settings toggles. First-run "" → command-center|remote is ok
            // only when topologyIntegrity is ok (checked above).
            if (
              (prevRole === "command-center" || prevRole === "remote") &&
              nextRole !== prevRole
            ) {
              throw new SettingsError({
                message:
                  "Station role migration requires an explicit Command Center transfer ceremony — Settings cannot promote, demote, or clear a sealed role",
                code: "validation",
              });
            }
            if (JSON.stringify(current) === JSON.stringify(validated.right)) {
              // Still reseal so bootstrap after external wipe recovers.
              await writeTopologySeal(path, topologyFromStation(current.station));
              return current;
            }
            return writeState(validated.right);
          }),
        catch: (error) => toIoError(error),
      }),
    reset: (section?: SettingsSectionKey) =>
      Effect.tryPromise({
        try: () =>
          withWriteLock(async () => {
            const current = await ensureLoaded();
            // Doctrine: topology reset / role migration is catastrophic.
            // Never clear station.* through ambient settings reset.
            if (section === "station") {
              throw new SettingsError({
                message:
                  "station topology cannot be reset from Settings — role migration requires an explicit Command Center transfer ceremony",
                code: "validation",
              });
            }
            if (section === undefined) {
              // Full prefs reset preserves sealed topology.
              const next: Settings = {
                ...defaultSettings(),
                station: current.station,
              };
              return writeState(next);
            }
            const next: Settings = {
              ...current,
              [section]: defaultSection(section),
            };
            return writeState(next);
          }),
        catch: (error) => toIoError(error),
      }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

export const SettingsLive = Layer.sync(SettingsService, () =>
  SettingsService.of(makeSettingsService()),
);
