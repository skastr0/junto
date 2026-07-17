import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import {
  DEFAULT_BROWSER_PROFILES,
  isValidProfileId,
  partitionNameForProfile,
} from "@shared/browser";
import {
  BROWSER_MAX_VISIBLE_SURFACES_HARD,
  BROWSER_MAX_WARM_SESSIONS_HARD,
} from "@shared/browser-limits";

// Browser profile registry under ~/.vellum/browser.
// Document nodes store only profile *names*; this service owns config + dirs.
// No Chromium / WebContents here — partition mapping only.

export class BrowserProfileError extends Schema.TaggedError<BrowserProfileError>()(
  "BrowserProfileError",
  {
    message: Schema.String,
    code: Schema.optionalWith(
      Schema.Literal("invalid", "not_found", "io", "forbidden"),
      { exact: true },
    ),
  },
) {}

export interface BrowserProfileRecord {
  readonly id: string;
  readonly label?: string;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
}

export interface BrowserConfigFile {
  readonly defaultProfile: string;
  readonly canvasDefaults: Readonly<Record<string, string>>;
  readonly maxWarmSessions: number;
  readonly maxVisibleSurfaces: number;
  readonly profiles: ReadonlyArray<BrowserProfileRecord>;
}

export interface BrowserProfileServiceApi {
  readonly doctor: Effect.Effect<ServiceCheck>;
  readonly ensureDefaults: Effect.Effect<BrowserConfigFile, BrowserProfileError>;
  readonly readConfig: Effect.Effect<BrowserConfigFile, BrowserProfileError>;
  readonly listProfiles: Effect.Effect<ReadonlyArray<BrowserProfileRecord>, BrowserProfileError>;
  readonly createProfile: (
    id: string,
    label?: string,
  ) => Effect.Effect<BrowserProfileRecord, BrowserProfileError>;
  readonly wipeProfile: (id: string) => Effect.Effect<void, BrowserProfileError>;
  readonly touchProfile: (id: string) => Effect.Effect<void, BrowserProfileError>;
  readonly resolveDefaultProfile: (canvasName?: string) => Effect.Effect<string, BrowserProfileError>;
  readonly partitionName: (profileId: string) => Effect.Effect<string, BrowserProfileError>;
  readonly rootDir: () => string;
}

export class BrowserProfileService extends Context.Tag("@vellum/BrowserProfileService")<
  BrowserProfileService,
  BrowserProfileServiceApi
>() {}

export const browserRootDir = (): string =>
  process.env.VELLUM_BROWSER_DIR || join(homedir(), ".vellum", "browser");

const configPath = (root: string) => join(root, "config.json");
const profilesDir = (root: string) => join(root, "profiles");
const profileDir = (root: string, id: string) => join(profilesDir(root), id);

const nowIso = () => new Date().toISOString();

const defaultConfig = (): BrowserConfigFile => {
  const createdAt = nowIso();
  return {
    defaultProfile: "personal",
    canvasDefaults: {},
    maxWarmSessions: 3,
    maxVisibleSurfaces: 2,
    profiles: DEFAULT_BROWSER_PROFILES.map((id) => ({
      id,
      label: id === "personal" ? "Personal" : "Work",
      createdAt,
    })),
  };
};

const toError = (error: unknown, code: BrowserProfileError["code"] = "io"): BrowserProfileError =>
  error instanceof BrowserProfileError
    ? error
    : new BrowserProfileError({
        message: error instanceof Error ? error.message : String(error),
        code,
      });

const boundedPositiveInteger = (value: unknown, fallback: number, hardMaximum: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.min(Math.floor(value), hardMaximum))
    : fallback;

const parseConfig = (raw: string): BrowserConfigFile => {
  const parsed = JSON.parse(raw) as Partial<BrowserConfigFile>;
  const base = defaultConfig();
  const profiles =
    Array.isArray(parsed.profiles) && parsed.profiles.length > 0
      ? parsed.profiles.filter(
          (p): p is BrowserProfileRecord =>
            typeof p === "object" &&
            p !== null &&
            typeof (p as BrowserProfileRecord).id === "string" &&
            isValidProfileId((p as BrowserProfileRecord).id),
        )
      : base.profiles;
  return {
    defaultProfile:
      typeof parsed.defaultProfile === "string" && isValidProfileId(parsed.defaultProfile)
        ? parsed.defaultProfile
        : base.defaultProfile,
    canvasDefaults:
      parsed.canvasDefaults && typeof parsed.canvasDefaults === "object"
        ? Object.fromEntries(
            Object.entries(parsed.canvasDefaults).filter(
              ([k, v]) => typeof k === "string" && typeof v === "string" && isValidProfileId(v),
            ),
          )
        : {},
    maxWarmSessions: boundedPositiveInteger(
      parsed.maxWarmSessions,
      base.maxWarmSessions,
      BROWSER_MAX_WARM_SESSIONS_HARD,
    ),
    maxVisibleSurfaces: boundedPositiveInteger(
      parsed.maxVisibleSurfaces,
      base.maxVisibleSurfaces,
      BROWSER_MAX_VISIBLE_SURFACES_HARD,
    ),
    profiles,
  };
};

const writeConfig = async (root: string, config: BrowserConfigFile): Promise<void> => {
  await mkdir(root, { recursive: true });
  await mkdir(profilesDir(root), { recursive: true });
  for (const profile of config.profiles) {
    await mkdir(profileDir(root, profile.id), { recursive: true });
  }
  await writeFile(configPath(root), `${JSON.stringify(config, null, 2)}\n`, "utf8");
};

const loadOrCreate = async (root: string): Promise<BrowserConfigFile> => {
  await mkdir(root, { recursive: true });
  await mkdir(profilesDir(root), { recursive: true });
  try {
    const raw = await readFile(configPath(root), "utf8");
    const config = parseConfig(raw);
    // Ensure profile dirs exist for every registered profile.
    for (const profile of config.profiles) {
      await mkdir(profileDir(root, profile.id), { recursive: true });
    }
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const config = defaultConfig();
      await writeConfig(root, config);
      return config;
    }
    throw error;
  }
};

export const makeBrowserProfileService = (root: string = browserRootDir()): BrowserProfileServiceApi => {
  const read: Effect.Effect<BrowserConfigFile, BrowserProfileError> = Effect.tryPromise({
    try: () => loadOrCreate(root),
    catch: (e) => toError(e),
  });

  const write = (config: BrowserConfigFile): Effect.Effect<void, BrowserProfileError> =>
    Effect.tryPromise({
      try: () => writeConfig(root, config),
      catch: (e) => toError(e),
    });

  return {
    rootDir: () => root,
    doctor: Effect.sync(() => ({
      id: "browser-profiles",
      label: "Browser Profiles",
      status: "ok" as const,
      detail: root,
    })),
    ensureDefaults: read,
    readConfig: read,
    listProfiles: Effect.gen(function* () {
      const config = yield* read;
      return config.profiles;
    }),
    createProfile: (id: string, label?: string) =>
      Effect.gen(function* () {
        if (!isValidProfileId(id)) {
          return yield* new BrowserProfileError({
            message: `invalid profile id: ${id}`,
            code: "invalid",
          });
        }
        const config = yield* read;
        if (config.profiles.some((p) => p.id === id)) {
          return yield* new BrowserProfileError({
            message: `profile already exists: ${id}`,
            code: "invalid",
          });
        }
        const record: BrowserProfileRecord = {
          id,
          ...(label?.trim() ? { label: label.trim() } : {}),
          createdAt: nowIso(),
        };
        const next: BrowserConfigFile = {
          ...config,
          profiles: [...config.profiles, record],
        };
        yield* write(next);
        return record;
      }),
    wipeProfile: (id: string) =>
      Effect.gen(function* () {
        if (!isValidProfileId(id)) {
          return yield* new BrowserProfileError({
            message: `invalid profile id: ${id}`,
            code: "invalid",
          });
        }
        const config = yield* read;
        if (!config.profiles.some((p) => p.id === id)) {
          return yield* new BrowserProfileError({
            message: `profile not found: ${id}`,
            code: "not_found",
          });
        }
        // Refuse wiping the last profile — always keep at least one.
        if (config.profiles.length <= 1) {
          return yield* new BrowserProfileError({
            message: "cannot wipe the last browser profile",
            code: "forbidden",
          });
        }
        const nextProfiles = config.profiles.filter((p) => p.id !== id);
        const nextDefault =
          config.defaultProfile === id ? nextProfiles[0]!.id : config.defaultProfile;
        const nextCanvasDefaults = Object.fromEntries(
          Object.entries(config.canvasDefaults).filter(([, v]) => v !== id),
        );
        yield* write({
          ...config,
          defaultProfile: nextDefault,
          canvasDefaults: nextCanvasDefaults,
          profiles: nextProfiles,
        });
        yield* Effect.tryPromise({
          try: () => rm(profileDir(root, id), { recursive: true, force: true }),
          catch: (e) => toError(e),
        });
      }),
    touchProfile: (id: string) =>
      Effect.gen(function* () {
        if (!isValidProfileId(id)) {
          return yield* new BrowserProfileError({
            message: `invalid profile id: ${id}`,
            code: "invalid",
          });
        }
        const config = yield* read;
        if (!config.profiles.some((p) => p.id === id)) {
          return yield* new BrowserProfileError({
            message: `profile not found: ${id}`,
            code: "not_found",
          });
        }
        const touched = nowIso();
        yield* write({
          ...config,
          profiles: config.profiles.map((p) =>
            p.id === id ? { ...p, lastUsedAt: touched } : p,
          ),
        });
      }),
    resolveDefaultProfile: (canvasName?: string) =>
      Effect.gen(function* () {
        const config = yield* read;
        if (canvasName && config.canvasDefaults[canvasName]) {
          const id = config.canvasDefaults[canvasName]!;
          if (config.profiles.some((p) => p.id === id)) return id;
        }
        if (config.profiles.some((p) => p.id === config.defaultProfile)) {
          return config.defaultProfile;
        }
        return config.profiles[0]?.id ?? "personal";
      }),
    partitionName: (profileId: string) =>
      Effect.gen(function* () {
        if (!isValidProfileId(profileId)) {
          return yield* new BrowserProfileError({
            message: `invalid profile id: ${profileId}`,
            code: "invalid",
          });
        }
        const config = yield* read;
        if (!config.profiles.some((p) => p.id === profileId)) {
          return yield* new BrowserProfileError({
            message: `profile not found: ${profileId}`,
            code: "not_found",
          });
        }
        return partitionNameForProfile(profileId);
      }),
  };
};

export const BrowserProfileLive = Layer.sync(BrowserProfileService, () =>
  makeBrowserProfileService(),
);

/** Test helper: service rooted at an explicit directory (no home). */
export const BrowserProfileTestLive = (root: string) =>
  Layer.succeed(BrowserProfileService, makeBrowserProfileService(root));

// Re-export for callers that only need path listing without Effect.
export const listProfileDirs = async (root: string = browserRootDir()): Promise<string[]> => {
  try {
    const entries = await readdir(profilesDir(root), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
};
