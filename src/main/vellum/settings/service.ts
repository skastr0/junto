import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
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
  migrateSettingsDocument,
} from "./migrate";
import { probeSupervisedRuntime, type SupervisedProbe } from "./supervised-probe";

// SettingsService: single durable prefs aggregate. Path defaults to
// ~/.vellum/settings.json (agent-readable home). Tests override via
// VELLUM_SETTINGS_PATH (exact file) — never accept a path from the renderer.

export class SettingsService extends Context.Tag("@vellum/SettingsService")<
  SettingsService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly get: Effect.Effect<Settings, SettingsError>;
    readonly patch: (input: unknown) => Effect.Effect<Settings, SettingsError>;
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
  await mkdir(dirname(path), { recursive: true });
  const body = `${JSON.stringify(settings, null, 2)}\n`;
  if (Buffer.byteLength(body, "utf8") > SETTINGS_MAX_FILE_BYTES) {
    throw new SettingsError({
      message: `settings document exceeds ${SETTINGS_MAX_FILE_BYTES} byte ceiling`,
      code: "validation",
    });
  }
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, body, "utf8");
  await rename(tmp, path);
};

const loadFromDisk = async (path: string): Promise<Settings> => {
  let raw: string;
  try {
    const info = await stat(path);
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
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof SettingsError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const fresh = defaultSettings();
      await atomicWrite(path, fresh);
      return fresh;
    }
    throw error;
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
  return migrated.right;
};

export interface SettingsServiceApi {
  readonly doctor: Effect.Effect<ServiceCheck>;
  readonly get: Effect.Effect<Settings, SettingsError>;
  readonly patch: (input: unknown) => Effect.Effect<Settings, SettingsError>;
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
  // Serialize patch/reset RMW so concurrent IPC cannot last-writer-clobber.
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
    reset: (section?: SettingsSectionKey) =>
      Effect.tryPromise({
        try: () =>
          withWriteLock(async () => {
            const current = await ensureLoaded();
            const next: Settings = section
              ? { ...current, [section]: defaultSection(section) }
              : defaultSettings();
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
