import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rmdir,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
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
import {
  StateEngine,
  type StateReader,
  type StateWriter,
} from "../state/service";
import type {
  BrowserProfileGateResult,
  BrowserProfileSnapshot,
} from "./profile-gate";

// Profile metadata lives only in StateEngine. This directory is deliberately
// not a second registry: it contains bounded, owner-only physical bookkeeping
// for Chromium profile storage and wipe containment.

const CONFIG_VERSION = 1 as const;
const MAX_PROFILES = 64;
const MAX_CANVAS_DEFAULTS = 256;
const MAX_LABEL_BYTES = 128;
const MAX_PATH_BYTES = 4_096;
const MAX_ROOT_ENTRIES = 256;
const OWNER_DIRECTORY_MODE = 0o700;
const MODE_MASK = 0o777;
const CANVAS_NAME = /^[a-z0-9-]{1,63}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE_ADMISSION_FAILURE_MESSAGE =
  "browser profile admission unavailable";

type StateService = Context.Tag.Service<typeof StateEngine>;

const closeQuietly = async (close: () => Promise<void>): Promise<void> => {
  try {
    await close();
  } catch {
    // Cleanup is best-effort.
  }
};

export type BrowserProfileErrorCode =
  | "invalid"
  | "not_found"
  | "io"
  | "forbidden"
  | "corrupt"
  | "pending_wipe";

export class BrowserProfileError extends Schema.TaggedError<BrowserProfileError>()(
  "BrowserProfileError",
  {
    message: Schema.String,
    code: Schema.optionalWith(
      Schema.Literal(
        "invalid",
        "not_found",
        "io",
        "forbidden",
        "corrupt",
        "pending_wipe",
      ),
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

/** Public ready-state view retained for existing browser consumers. */
export interface BrowserConfigFile {
  readonly defaultProfile: string;
  readonly canvasDefaults: Readonly<Record<string, string>>;
  readonly maxWarmSessions: number;
  readonly maxVisibleSurfaces: number;
  readonly profiles: ReadonlyArray<BrowserProfileRecord>;
}

export interface BrowserProfileWipePaths {
  readonly storagePath: string;
  readonly userDataPath: string;
  readonly sessionDataPath: string;
}

export type BrowserProfileWipeStage =
  | "live_clear_pending"
  | "restart_delete_pending";

export interface BrowserProfilePendingWipe extends BrowserProfileWipePaths {
  readonly wipeId: string;
  readonly profileId: string;
  readonly partition: string;
  readonly requestedAt: string;
  readonly stage: BrowserProfileWipeStage;
}

export type BrowserProfileWipeOutcome =
  | { readonly status: "complete" }
  | { readonly status: "restart_delete_pending" };

export type BrowserProfileWipeReceipt =
  | { readonly status: "complete" }
  | { readonly status: "restart_required" };

export interface BrowserProfileWipeLifecycle {
  /** Resolve and validate Electron paths without mutating browser state. */
  readonly prepare: (input: {
    readonly wipeId: string;
    readonly profileId: string;
    readonly partition: string;
  }) => Promise<BrowserProfileWipePaths>;
  /** Live-only quiescence and deletion after the durable marker exists. */
  readonly executeLive: (
    pending: BrowserProfilePendingWipe,
  ) => Promise<BrowserProfileWipeOutcome>;
  /** Cold-start idempotent deletion. This must not construct an Electron Session. */
  readonly recoverCold: (pending: BrowserProfilePendingWipe) => Promise<void>;
}

/** Exact creation authority; storage/wipe transitions stay outside this port. */
export interface BrowserProfileCreationGate {
  markCreated(
    profile: string,
  ): BrowserProfileGateResult<BrowserProfileSnapshot>;
}

export interface BrowserProfileServiceOptions {
  readonly wipeLifecycle?: BrowserProfileWipeLifecycle;
  readonly profileGate?: BrowserProfileCreationGate;
  readonly now?: () => Date;
}

export interface BrowserProfileServiceApi {
  readonly doctor: Effect.Effect<ServiceCheck>;
  readonly initialize: Effect.Effect<BrowserConfigFile, BrowserProfileError>;
  readonly ensureDefaults: Effect.Effect<
    BrowserConfigFile,
    BrowserProfileError
  >;
  /** Cold-start only: call once before any browser partition is admitted. */
  readonly recoverPendingWipe: Effect.Effect<void, BrowserProfileError>;
  readonly readConfig: Effect.Effect<BrowserConfigFile, BrowserProfileError>;
  readonly listProfiles: Effect.Effect<
    ReadonlyArray<BrowserProfileRecord>,
    BrowserProfileError
  >;
  readonly createProfile: (
    id: string,
    label?: string,
  ) => Effect.Effect<BrowserProfileRecord, BrowserProfileError>;
  readonly wipeProfile: (
    id: string,
  ) => Effect.Effect<BrowserProfileWipeReceipt, BrowserProfileError>;
  readonly touchProfile: (
    id: string,
  ) => Effect.Effect<void, BrowserProfileError>;
  readonly resolveDefaultProfile: (
    canvasName?: string,
  ) => Effect.Effect<string, BrowserProfileError>;
  readonly partitionName: (
    profileId: string,
  ) => Effect.Effect<string, BrowserProfileError>;
  readonly rootDir: () => string;
}

export class BrowserProfileService extends Context.Tag(
  "@vellum/BrowserProfileService",
)<BrowserProfileService, BrowserProfileServiceApi>() {}

interface BrowserProfileStateReady extends BrowserConfigFile {
  readonly phase: "ready";
}

interface BrowserProfileStatePending extends BrowserConfigFile {
  readonly phase: "wipe_pending";
  readonly pendingWipe: BrowserProfilePendingWipe;
}

type BrowserProfileState =
  | BrowserProfileStateReady
  | BrowserProfileStatePending;

type SettingsRow = {
  readonly version: number;
  readonly default_profile: string;
  readonly max_warm_sessions: number;
  readonly max_visible_surfaces: number;
};

type ProfileRow = {
  readonly id: string;
  readonly label: string | null;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly sort_order: number;
};

type CanvasDefaultRow = {
  readonly canvas_name: string;
  readonly profile_id: string;
};

type PendingWipeRow = {
  readonly wipe_id: string;
  readonly profile_id: string;
  readonly partition: string;
  readonly requested_at: string;
  readonly stage: string;
  readonly storage_path: string;
  readonly user_data_path: string;
  readonly session_data_path: string;
};

export const browserRootDir = (): string =>
  process.env.VELLUM_BROWSER_DIR ||
  join(homedir(), ".vellum", "browser");

const profilesDir = (root: string) => join(root, "profiles");
const profileDir = (root: string, id: string) =>
  join(profilesDir(root), id);

const publicIoError = () =>
  new BrowserProfileError({
    message: "browser profile registry unavailable",
    code: "io",
  });

const corruptError = (message = "browser profile registry corrupt") =>
  new BrowserProfileError({ message, code: "corrupt" });

const pendingError = () =>
  new BrowserProfileError({
    message: "browser profile wipe incomplete; recovery required",
    code: "pending_wipe",
  });

const toPublicError = (error: unknown): BrowserProfileError =>
  error instanceof BrowserProfileError ? error : publicIoError();

const stateError = (error: {
  readonly cause: unknown;
}): BrowserProfileError =>
  error.cause instanceof BrowserProfileError
    ? error.cause
    : publicIoError();

const utf8Bytes = (value: string): number =>
  Buffer.byteLength(value, "utf8");

const isCanonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) &&
    new Date(millis).toISOString() === value;
};

const isCanonicalLabel = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.trim() === value &&
  utf8Bytes(value) <= MAX_LABEL_BYTES &&
  !CONTROL_CHARACTER.test(value);

const isBoundedInteger = (
  value: unknown,
  maximum: number,
): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= maximum;

const isCanonicalAbsolutePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  utf8Bytes(value) <= MAX_PATH_BYTES &&
  !CONTROL_CHARACTER.test(value) &&
  isAbsolute(value) &&
  resolve(value) === value;

const isStrictDescendant = (parent: string, child: string): boolean => {
  const childRelative = relative(parent, child);
  return childRelative.length > 0 &&
    !childRelative.startsWith("..") &&
    !isAbsolute(childRelative);
};

const isDescendantOrEqual = (parent: string, child: string): boolean =>
  parent === child || isStrictDescendant(parent, child);

const areWipePathsValid = (
  paths: BrowserProfileWipePaths,
): boolean =>
  isCanonicalAbsolutePath(paths.storagePath) &&
  isCanonicalAbsolutePath(paths.userDataPath) &&
  isCanonicalAbsolutePath(paths.sessionDataPath) &&
  isDescendantOrEqual(paths.userDataPath, paths.sessionDataPath) &&
  isStrictDescendant(paths.userDataPath, paths.storagePath) &&
  isStrictDescendant(paths.sessionDataPath, paths.storagePath);

const validateState = (
  value: BrowserProfileState,
): BrowserProfileState => {
  if (
    value.profiles.length < 1 ||
    value.profiles.length > MAX_PROFILES ||
    new Set(value.profiles.map((profile) => profile.id)).size !==
      value.profiles.length
  ) {
    throw corruptError();
  }
  const profileIds = new Set<string>();
  for (const profile of value.profiles) {
    if (
      !isValidProfileId(profile.id) ||
      !isCanonicalTimestamp(profile.createdAt) ||
      (profile.label !== undefined &&
        !isCanonicalLabel(profile.label)) ||
      (profile.lastUsedAt !== undefined &&
        !isCanonicalTimestamp(profile.lastUsedAt))
    ) {
      throw corruptError();
    }
    profileIds.add(profile.id);
  }
  if (
    !profileIds.has(value.defaultProfile) ||
    !isBoundedInteger(
      value.maxWarmSessions,
      BROWSER_MAX_WARM_SESSIONS_HARD,
    ) ||
    !isBoundedInteger(
      value.maxVisibleSurfaces,
      BROWSER_MAX_VISIBLE_SURFACES_HARD,
    )
  ) {
    throw corruptError();
  }
  const defaults = Object.entries(value.canvasDefaults);
  if (defaults.length > MAX_CANVAS_DEFAULTS) throw corruptError();
  for (const [canvas, profile] of defaults) {
    if (!CANVAS_NAME.test(canvas) || !profileIds.has(profile)) {
      throw corruptError();
    }
  }
  if (value.phase === "wipe_pending") {
    const pending = value.pendingWipe;
    if (
      !UUID_V4.test(pending.wipeId) ||
      !profileIds.has(pending.profileId) ||
      pending.partition !== partitionNameForProfile(pending.profileId) ||
      value.profiles.length <= 1 ||
      !isCanonicalTimestamp(pending.requestedAt) ||
      (pending.stage !== "live_clear_pending" &&
        pending.stage !== "restart_delete_pending") ||
      !areWipePathsValid(pending)
    ) {
      throw corruptError();
    }
  }
  return value;
};

const stateFootprint = (reader: StateReader): number => {
  const row = reader.get<{
    readonly count: number;
  }>(`
    SELECT
      (SELECT count(*) FROM browser_profiles)
      + (SELECT count(*) FROM browser_profile_canvas_defaults)
      + (SELECT count(*) FROM browser_profile_pending_wipe)
      AS count
  `);
  return Number(row?.count ?? 0);
};

const readStoredState = (
  reader: StateReader,
): BrowserProfileState | undefined => {
  const settings = reader.get<SettingsRow>(`
    SELECT
      version,
      default_profile,
      max_warm_sessions,
      max_visible_surfaces
    FROM browser_profile_settings
    WHERE singleton = 1
  `);
  if (settings === undefined) {
    if (stateFootprint(reader) !== 0) throw corruptError();
    return undefined;
  }
  if (settings.version !== CONFIG_VERSION) throw corruptError();

  const profiles = reader
    .all<ProfileRow>(`
      SELECT id, label, created_at, last_used_at, sort_order
      FROM browser_profiles
      ORDER BY sort_order
    `)
    .map(
      (row): BrowserProfileRecord => ({
        id: row.id,
        ...(row.label === null ? {} : { label: row.label }),
        createdAt: row.created_at,
        ...(row.last_used_at === null
          ? {}
          : { lastUsedAt: row.last_used_at }),
      }),
    );
  const canvasDefaults = Object.fromEntries(
    reader
      .all<CanvasDefaultRow>(`
        SELECT canvas_name, profile_id
        FROM browser_profile_canvas_defaults
        ORDER BY canvas_name
      `)
      .map((row) => [row.canvas_name, row.profile_id]),
  );
  const pending = reader.get<PendingWipeRow>(`
    SELECT
      wipe_id,
      profile_id,
      partition,
      requested_at,
      stage,
      storage_path,
      user_data_path,
      session_data_path
    FROM browser_profile_pending_wipe
    WHERE singleton = 1
  `);
  const base: BrowserConfigFile = {
    defaultProfile: settings.default_profile,
    canvasDefaults,
    maxWarmSessions: settings.max_warm_sessions,
    maxVisibleSurfaces: settings.max_visible_surfaces,
    profiles,
  };
  if (pending === undefined) {
    return validateState({ phase: "ready", ...base });
  }
  return validateState({
    phase: "wipe_pending",
    ...base,
    pendingWipe: Object.freeze({
      wipeId: pending.wipe_id,
      profileId: pending.profile_id,
      partition: pending.partition,
      requestedAt: pending.requested_at,
      stage: pending.stage as BrowserProfileWipeStage,
      storagePath: pending.storage_path,
      userDataPath: pending.user_data_path,
      sessionDataPath: pending.session_data_path,
    }),
  });
};

const defaultState = (now: () => Date): BrowserProfileStateReady => {
  const createdAt = now().toISOString();
  return {
    phase: "ready",
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

const insertProfile = (
  writer: StateWriter,
  profile: BrowserProfileRecord,
  sortOrder: number,
): void => {
  writer.run(
    `
      INSERT INTO browser_profiles(
        id,
        label,
        created_at,
        last_used_at,
        sort_order
      )
      VALUES (?, ?, ?, ?, ?)
    `,
    [
      profile.id,
      profile.label ?? null,
      profile.createdAt,
      profile.lastUsedAt ?? null,
      sortOrder,
    ],
  );
};

const requireStoredState = (reader: StateReader): BrowserProfileState => {
  const config = readStoredState(reader);
  if (config === undefined) throw corruptError();
  return config;
};

const requireReady = (
  config: BrowserProfileState,
): BrowserProfileStateReady => {
  if (config.phase !== "ready") throw pendingError();
  return config;
};

const asOperationalConfig = (
  config: BrowserProfileState,
): BrowserConfigFile => {
  if (config.phase === "ready") return config;
  const pendingId = config.pendingWipe.profileId;
  const profiles = config.profiles.filter(
    (profile) => profile.id !== pendingId,
  );
  return {
    defaultProfile:
      config.defaultProfile === pendingId
        ? profiles[0]!.id
        : config.defaultProfile,
    canvasDefaults: Object.fromEntries(
      Object.entries(config.canvasDefaults).filter(
        ([, profile]) => profile !== pendingId,
      ),
    ),
    maxWarmSessions: config.maxWarmSessions,
    maxVisibleSurfaces: config.maxVisibleSurfaces,
    profiles,
  };
};

const currentUid = (): number | undefined =>
  typeof process.getuid === "function"
    ? process.getuid()
    : undefined;

const requireOwned = (uid: number): void => {
  const expected = currentUid();
  if (expected !== undefined && uid !== expected) throw corruptError();
};

const ensureOwnedDirectory = async (path: string): Promise<void> => {
  await mkdir(path, {
    recursive: true,
    mode: OWNER_DIRECTORY_MODE,
  });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw corruptError();
  }
  requireOwned(info.uid);
  if ((info.mode & MODE_MASK) !== OWNER_DIRECTORY_MODE) {
    await chmod(path, OWNER_DIRECTORY_MODE);
  }
};

const ensureContained = (root: string, path: string): void => {
  const fromRoot = relative(root, path);
  if (
    fromRoot.length === 0 ||
    fromRoot.startsWith("..") ||
    isAbsolute(fromRoot)
  ) {
    throw corruptError();
  }
};

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(
    path,
    fsConstants.O_RDONLY |
      fsConstants.O_DIRECTORY |
      fsConstants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const prepareRegistryRoot = async (
  requestedRoot: string,
): Promise<string> => {
  if (
    !isAbsolute(requestedRoot) ||
    resolve(requestedRoot) !== requestedRoot
  ) {
    throw corruptError();
  }
  await ensureOwnedDirectory(requestedRoot);
  const canonicalRoot = await realpath(requestedRoot);
  await ensureOwnedDirectory(profilesDir(canonicalRoot));
  return canonicalRoot;
};

const prepareProfileDirectories = async (
  root: string,
  profiles: ReadonlyArray<BrowserProfileRecord>,
): Promise<void> => {
  const directory = profilesDir(root);
  ensureContained(root, directory);
  await ensureOwnedDirectory(directory);
  for (const profile of profiles) {
    const path = profileDir(root, profile.id);
    ensureContained(root, path);
    await ensureOwnedDirectory(path);
  }
};

const removeEmptyProfileDirectory = async (
  root: string,
  id: string,
): Promise<void> => {
  const path = profileDir(root, id);
  ensureContained(root, path);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw corruptError();
  }
  requireOwned(info.uid);
  const directory = await opendir(path);
  try {
    const first = await directory.read();
    if (first !== null) throw corruptError();
  } finally {
    await closeQuietly(() => directory.close());
  }
  await rmdir(path);
  await syncDirectory(profilesDir(root));
};

export const makeBrowserProfileService = (
  state: StateService,
  root: string = browserRootDir(),
  options: BrowserProfileServiceOptions = {},
): BrowserProfileServiceApi => {
  const requestedRoot = root;
  const now = options.now ?? (() => new Date());
  const mutationLock = Effect.unsafeMakeSemaphore(1);

  const databaseTransaction = <A>(
    operation: string,
    body: (writer: StateWriter) => A,
  ): Effect.Effect<A, BrowserProfileError> =>
    state.transaction(operation, body).pipe(
      Effect.mapError(stateError),
    );

  const fileEffect = <A>(
    operation: () => Promise<A>,
  ): Effect.Effect<A, BrowserProfileError> =>
    Effect.tryPromise({
      try: operation,
      catch: toPublicError,
    });

  const ensureInitialized = databaseTransaction(
    "browser-profiles.initialize",
    (writer) => {
      const current = readStoredState(writer);
      if (current !== undefined) return current;
      const initial = defaultState(now);
      initial.profiles.forEach((profile, index) => {
        insertProfile(writer, profile, index);
      });
      writer.run(
        `
          INSERT INTO browser_profile_settings(
            singleton,
            version,
            default_profile,
            max_warm_sessions,
            max_visible_surfaces
          )
          VALUES (1, ?, ?, ?, ?)
        `,
        [
          CONFIG_VERSION,
          initial.defaultProfile,
          initial.maxWarmSessions,
          initial.maxVisibleSurfaces,
        ],
      );
      return requireStoredState(writer);
    },
  );

  const load = Effect.gen(function* () {
    const config = yield* ensureInitialized;
    const canonicalRoot = yield* fileEffect(() =>
      prepareRegistryRoot(requestedRoot)
    );
    yield* fileEffect(() =>
      prepareProfileDirectories(canonicalRoot, config.profiles)
    );
    return {
      root: canonicalRoot,
      config,
    };
  });

  const finalizePending = (
    rootPath: string,
    expected: BrowserProfilePendingWipe,
  ): Effect.Effect<BrowserProfileStateReady, BrowserProfileError> =>
    Effect.gen(function* () {
      yield* fileEffect(() =>
        removeEmptyProfileDirectory(rootPath, expected.profileId)
      );
      return yield* databaseTransaction(
        "browser-profiles.wipe.finalize",
        (writer) => {
          const current = requireStoredState(writer);
          if (current.phase !== "wipe_pending") {
            if (
              !current.profiles.some(
                (profile) => profile.id === expected.profileId,
              )
            ) {
              return current;
            }
            throw corruptError();
          }
          if (
            current.pendingWipe.wipeId !== expected.wipeId ||
            current.pendingWipe.profileId !== expected.profileId
          ) {
            throw corruptError();
          }
          const nextDefault =
            current.defaultProfile === expected.profileId
              ? current.profiles.find(
                  (profile) => profile.id !== expected.profileId,
                )?.id
              : current.defaultProfile;
          if (nextDefault === undefined) {
            throw new BrowserProfileError({
              message: "cannot wipe the last browser profile",
              code: "forbidden",
            });
          }
          writer.run(
            `
              UPDATE browser_profile_settings
              SET default_profile = ?
              WHERE singleton = 1
            `,
            [nextDefault],
          );
          writer.run(
            `
              DELETE FROM browser_profile_canvas_defaults
              WHERE profile_id = ?
            `,
            [expected.profileId],
          );
          writer.run(
            `
              DELETE FROM browser_profile_pending_wipe
              WHERE singleton = 1
            `,
          );
          writer.run(
            "DELETE FROM browser_profiles WHERE id = ?",
            [expected.profileId],
          );
          return requireReady(requireStoredState(writer));
        },
      );
    });

  const recoverPendingCold = (
    rootPath: string,
    config: BrowserProfileStatePending,
  ): Effect.Effect<BrowserProfileStateReady, BrowserProfileError> => {
    const lifecycle = options.wipeLifecycle;
    if (lifecycle === undefined) return Effect.fail(pendingError());
    return Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => lifecycle.recoverCold(config.pendingWipe),
        catch: () => pendingError(),
      });
      return yield* finalizePending(rootPath, config.pendingWipe);
    });
  };

  const executePendingLive = (
    rootPath: string,
    config: BrowserProfileStatePending,
  ): Effect.Effect<BrowserProfileWipeReceipt, BrowserProfileError> => {
    const lifecycle = options.wipeLifecycle;
    if (lifecycle === undefined) return Effect.fail(pendingError());
    return Effect.gen(function* () {
      const outcome = yield* Effect.tryPromise({
        try: () => lifecycle.executeLive(config.pendingWipe),
        catch: () => pendingError(),
      });
      if (outcome.status === "restart_delete_pending") {
        yield* databaseTransaction(
          "browser-profiles.wipe.restart-pending",
          (writer) => {
            const current = requireStoredState(writer);
            if (
              current.phase !== "wipe_pending" ||
              current.pendingWipe.wipeId !==
                config.pendingWipe.wipeId
            ) {
              throw corruptError();
            }
            writer.run(
              `
                UPDATE browser_profile_pending_wipe
                SET stage = 'restart_delete_pending'
                WHERE singleton = 1
              `,
            );
          },
        );
        return Object.freeze({
          status: "restart_required",
        });
      }
      if (outcome.status !== "complete") {
        return yield* Effect.fail(pendingError());
      }
      yield* finalizePending(rootPath, config.pendingWipe);
      return Object.freeze({ status: "complete" });
    });
  };

  const initialize = load.pipe(
    Effect.map(({ config }) => asOperationalConfig(config)),
  );

  const doctor = load.pipe(
    Effect.match({
      onFailure: (error): ServiceCheck => ({
        id: "browser-profiles",
        label: "Browser Profiles",
        status: "error",
        detail:
          error.code === "corrupt"
            ? "profile registry corrupt"
            : "profile registry unavailable",
      }),
      onSuccess: ({ config }): ServiceCheck =>
        config.phase === "ready"
          ? {
              id: "browser-profiles",
              label: "Browser Profiles",
              status: "ok",
              detail:
                `registry v${CONFIG_VERSION} · ${config.profiles.length} profiles`,
            }
          : {
              id: "browser-profiles",
              label: "Browser Profiles",
              status: "error",
              detail: "profile wipe recovery required",
            },
    }),
  );

  return {
    rootDir: () => requestedRoot,
    doctor,
    initialize,
    ensureDefaults: initialize,
    recoverPendingWipe: mutationLock.withPermits(1)(
      Effect.gen(function* () {
        const loaded = yield* load;
        if (loaded.config.phase === "wipe_pending") {
          yield* recoverPendingCold(
            loaded.root,
            loaded.config,
          );
        }
      }),
    ),
    readConfig: initialize,
    listProfiles: initialize.pipe(
      Effect.map((config) => config.profiles),
    ),
    createProfile: (id, label) =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          if (!isValidProfileId(id)) {
            return yield* Effect.fail(
              new BrowserProfileError({
                message: "invalid profile id",
                code: "invalid",
              }),
            );
          }
          const normalizedLabel = label?.trim();
          if (
            normalizedLabel !== undefined &&
            normalizedLabel.length > 0 &&
            !isCanonicalLabel(normalizedLabel)
          ) {
            return yield* Effect.fail(
              new BrowserProfileError({
                message: "invalid profile label",
                code: "invalid",
              }),
            );
          }
          const loaded = yield* load;
          const record: BrowserProfileRecord = {
            id,
            ...(normalizedLabel
              ? { label: normalizedLabel }
              : {}),
            createdAt: now().toISOString(),
          };
          yield* databaseTransaction(
            "browser-profiles.create",
            (writer) => {
              const current = requireReady(
                requireStoredState(writer),
              );
              if (
                current.profiles.length >= MAX_PROFILES
              ) {
                throw new BrowserProfileError({
                  message: "profile limit reached",
                  code: "forbidden",
                });
              }
              if (
                current.profiles.some(
                  (profile) => profile.id === id,
                )
              ) {
                throw new BrowserProfileError({
                  message: "profile already exists",
                  code: "invalid",
                });
              }
              const maxOrder =
                writer.get<{
                  readonly max_order: number | null;
                }>(`
                  SELECT max(sort_order) AS max_order
                  FROM browser_profiles
                `)?.max_order ?? -1;
              insertProfile(
                writer,
                record,
                maxOrder + 1,
              );
            },
          );
          // SQLite is the authority. The directory is a repairable physical
          // projection and must never appear for a rejected database write.
          yield* fileEffect(() =>
            prepareProfileDirectories(loaded.root, [record])
          );
          let admitted = false;
          try {
            admitted =
              options.profileGate?.markCreated(id).ok ??
                true;
          } catch {
            // Gate-controlled failure is intentionally collapsed below.
          }
          if (!admitted) {
            return yield* Effect.fail(
              new BrowserProfileError({
                message: PROFILE_ADMISSION_FAILURE_MESSAGE,
                code: "pending_wipe",
              }),
            );
          }
          return record;
        }).pipe(Effect.uninterruptible),
      ),
    wipeProfile: (id) =>
      mutationLock.withPermits(1)(Effect.gen(function* () {
        if (!isValidProfileId(id)) {
          return yield* Effect.fail(
            new BrowserProfileError({
              message: "invalid profile id",
              code: "invalid",
            }),
          );
        }
        const loaded = yield* load;
        const config = requireReady(loaded.config);
        if (
          !config.profiles.some((profile) => profile.id === id)
        ) {
          return yield* Effect.fail(
            new BrowserProfileError({
              message: "profile not found",
              code: "not_found",
            }),
          );
        }
        if (config.profiles.length <= 1) {
          return yield* Effect.fail(
            new BrowserProfileError({
              message: "cannot wipe the last browser profile",
              code: "forbidden",
            }),
          );
        }
        const lifecycle = options.wipeLifecycle;
        if (lifecycle === undefined) {
          return yield* Effect.fail(
            new BrowserProfileError({
              message: "browser profile wipe lifecycle unavailable",
              code: "forbidden",
            }),
          );
        }
        const wipeId = randomUUID();
        const partition = partitionNameForProfile(id);
        const paths = yield* Effect.tryPromise({
          try: () =>
            lifecycle.prepare({
              wipeId,
              profileId: id,
              partition,
            }),
          catch: () =>
            new BrowserProfileError({
              message: "browser profile wipe preparation failed",
              code: "forbidden",
            }),
        });
        if (!areWipePathsValid(paths)) {
          return yield* Effect.fail(
            new BrowserProfileError({
              message: "browser profile wipe paths rejected",
              code: "forbidden",
            }),
          );
        }
        const requestedAt = now().toISOString();
        const pending = yield* databaseTransaction(
          "browser-profiles.wipe.begin",
          (writer) => {
            const current = requireReady(
              requireStoredState(writer),
            );
            if (
              !current.profiles.some(
                (profile) => profile.id === id,
              )
            ) {
              throw new BrowserProfileError({
                message: "profile not found",
                code: "not_found",
              });
            }
            if (current.profiles.length <= 1) {
              throw new BrowserProfileError({
                message: "cannot wipe the last browser profile",
                code: "forbidden",
              });
            }
            writer.run(
              `
                INSERT INTO browser_profile_pending_wipe(
                  singleton,
                  wipe_id,
                  profile_id,
                  partition,
                  requested_at,
                  stage,
                  storage_path,
                  user_data_path,
                  session_data_path
                )
                VALUES (1, ?, ?, ?, ?, 'live_clear_pending', ?, ?, ?)
              `,
              [
                wipeId,
                id,
                partition,
                requestedAt,
                paths.storagePath,
                paths.userDataPath,
                paths.sessionDataPath,
              ],
            );
            const next = requireStoredState(writer);
            if (next.phase !== "wipe_pending") {
              throw corruptError();
            }
            return next;
          },
        );
        return yield* executePendingLive(
          loaded.root,
          pending,
        );
      })),
    touchProfile: (id) =>
      Effect.gen(function* () {
        if (!isValidProfileId(id)) {
          return yield* Effect.fail(
            new BrowserProfileError({
              message: "invalid profile id",
              code: "invalid",
            }),
          );
        }
        yield* load;
        const touched = now().toISOString();
        yield* databaseTransaction(
          "browser-profiles.touch",
          (writer) => {
            const config = requireStoredState(writer);
            if (
              config.phase === "wipe_pending" &&
              config.pendingWipe.profileId === id
            ) {
              throw pendingError();
            }
            if (
              !config.profiles.some(
                (profile) => profile.id === id,
              )
            ) {
              throw new BrowserProfileError({
                message: "profile not found",
                code: "not_found",
              });
            }
            writer.run(
              `
                UPDATE browser_profiles
                SET last_used_at = ?
                WHERE id = ?
              `,
              [touched, id],
            );
          },
        );
      }),
    resolveDefaultProfile: (canvasName) =>
      Effect.gen(function* () {
        if (
          canvasName !== undefined &&
          !CANVAS_NAME.test(canvasName)
        ) {
          return yield* Effect.fail(
            new BrowserProfileError({
              message: "invalid canvas name",
              code: "invalid",
            }),
          );
        }
        const config = asOperationalConfig(
          (yield* load).config,
        );
        return canvasName
          ? config.canvasDefaults[canvasName] ??
              config.defaultProfile
          : config.defaultProfile;
      }),
    partitionName: (profileId) =>
      Effect.gen(function* () {
        if (!isValidProfileId(profileId)) {
          return yield* Effect.fail(
            new BrowserProfileError({
              message: "invalid profile id",
              code: "invalid",
            }),
          );
        }
        const config = (yield* load).config;
        if (
          config.phase === "wipe_pending" &&
          config.pendingWipe.profileId === profileId
        ) {
          return yield* Effect.fail(pendingError());
        }
        if (
          !config.profiles.some(
            (profile) => profile.id === profileId,
          )
        ) {
          return yield* Effect.fail(
            new BrowserProfileError({
              message: "profile not found",
              code: "not_found",
            }),
          );
        }
        return partitionNameForProfile(profileId);
      }),
  };
};

export const BrowserProfileLive = Layer.effect(
  BrowserProfileService,
  Effect.map(StateEngine, (state) =>
    makeBrowserProfileService(state)
  ),
);

/** Test helper: explicit database service and physical profile root. */
export const BrowserProfileTestLive = (
  state: StateService,
  root: string,
  options: BrowserProfileServiceOptions = {},
): Layer.Layer<BrowserProfileService> =>
  Layer.succeed(
    BrowserProfileService,
    makeBrowserProfileService(state, root, options),
  );

// Physical profile directories remain bounded, external storage facts.
export const listProfileDirs = async (
  root: string = browserRootDir(),
): Promise<string[]> => {
  try {
    if (!isAbsolute(root) || resolve(root) !== root) return [];
    const rootInfo = await lstat(root);
    if (
      rootInfo.isSymbolicLink() ||
      !rootInfo.isDirectory()
    ) {
      return [];
    }
    requireOwned(rootInfo.uid);
    const canonicalRoot = await realpath(root);
    const directoryPath = profilesDir(canonicalRoot);
    ensureContained(canonicalRoot, directoryPath);
    const profilesInfo = await lstat(directoryPath);
    if (
      profilesInfo.isSymbolicLink() ||
      !profilesInfo.isDirectory()
    ) {
      return [];
    }
    requireOwned(profilesInfo.uid);
    const directory = await opendir(directoryPath);
    const entries: string[] = [];
    let scanned = 0;
    try {
      for await (const entry of directory) {
        scanned += 1;
        if (scanned > MAX_ROOT_ENTRIES) {
          throw corruptError();
        }
        if (entries.length >= MAX_PROFILES) break;
        if (!isValidProfileId(entry.name)) continue;
        const path = join(directoryPath, entry.name);
        ensureContained(directoryPath, path);
        const info = await lstat(path);
        if (
          info.isSymbolicLink() ||
          !info.isDirectory()
        ) {
          throw corruptError();
        }
        requireOwned(info.uid);
        entries.push(entry.name);
      }
    } finally {
      await closeQuietly(() => directory.close());
    }
    return entries;
  } catch {
    return [];
  }
};
