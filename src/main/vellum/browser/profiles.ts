import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rmdir,
  unlink,
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

// Browser profile registry under ~/.vellum/browser. The registry contains no
// cookies or credentials, but it controls which persistent Electron partitions
// are usable and therefore receives the same owner-only filesystem treatment.

const CONFIG_VERSION = 1 as const;
const CONFIG_MAX_BYTES = 64 * 1024;
const MAX_PROFILES = 64;
const MAX_CANVAS_DEFAULTS = 256;
const MAX_LABEL_BYTES = 128;
const MAX_PATH_BYTES = 4_096;
const MAX_ROOT_ENTRIES = 256;
const MAX_ORPHAN_TEMPS = 64;
const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;
const MODE_MASK = 0o777;
const CANVAS_NAME = /^[a-z0-9-]{1,63}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEMP_FILE = /^\.config\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;

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

/** Public ready-state view retained for existing callers. */
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

export type BrowserProfileWipeStage = "live_clear_pending" | "restart_delete_pending";

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

export interface BrowserProfileServiceOptions {
  readonly wipeLifecycle?: BrowserProfileWipeLifecycle;
  readonly now?: () => Date;
}

export interface BrowserProfileServiceApi {
  readonly doctor: Effect.Effect<ServiceCheck>;
  readonly initialize: Effect.Effect<BrowserConfigFile, BrowserProfileError>;
  readonly ensureDefaults: Effect.Effect<BrowserConfigFile, BrowserProfileError>;
  /** Cold-start only: call once before any browser partition is admitted. */
  readonly recoverPendingWipe: Effect.Effect<void, BrowserProfileError>;
  readonly readConfig: Effect.Effect<BrowserConfigFile, BrowserProfileError>;
  readonly listProfiles: Effect.Effect<ReadonlyArray<BrowserProfileRecord>, BrowserProfileError>;
  readonly createProfile: (
    id: string,
    label?: string,
  ) => Effect.Effect<BrowserProfileRecord, BrowserProfileError>;
  readonly wipeProfile: (
    id: string,
  ) => Effect.Effect<BrowserProfileWipeReceipt, BrowserProfileError>;
  readonly touchProfile: (id: string) => Effect.Effect<void, BrowserProfileError>;
  readonly resolveDefaultProfile: (canvasName?: string) => Effect.Effect<string, BrowserProfileError>;
  readonly partitionName: (profileId: string) => Effect.Effect<string, BrowserProfileError>;
  readonly rootDir: () => string;
}

export class BrowserProfileService extends Context.Tag("@vellum/BrowserProfileService")<
  BrowserProfileService,
  BrowserProfileServiceApi
>() {}

interface BrowserConfigDiskBase extends BrowserConfigFile {
  readonly version: typeof CONFIG_VERSION;
}

interface BrowserConfigDiskReady extends BrowserConfigDiskBase {
  readonly phase: "ready";
}

interface BrowserConfigDiskPending extends BrowserConfigDiskBase {
  readonly phase: "wipe_pending";
  readonly pendingWipe: BrowserProfilePendingWipe;
}

type BrowserConfigDisk = BrowserConfigDiskReady | BrowserConfigDiskPending;

interface DecodedConfig {
  readonly config: BrowserConfigDisk;
  readonly migrated: boolean;
}

export const browserRootDir = (): string =>
  process.env.VELLUM_BROWSER_DIR || join(homedir(), ".vellum", "browser");

const configPath = (root: string) => join(root, "config.json");
const profilesDir = (root: string) => join(root, "profiles");
const profileDir = (root: string, id: string) => join(profilesDir(root), id);

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

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errnoCode = (error: unknown): string | undefined =>
  isPlainRecord(error) && typeof error.code === "string" ? error.code : undefined;

const hasExactKeys = (record: Record<string, unknown>, expected: ReadonlyArray<string>): boolean => {
  const actual = Object.keys(record).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length && actual.every((key, index) => key === canonical[index]);
};

const isCanonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
};

const isCanonicalLabel = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.trim() === value &&
  utf8Bytes(value) <= MAX_LABEL_BYTES &&
  !CONTROL_CHARACTER.test(value);

const isBoundedInteger = (value: unknown, maximum: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= maximum;

const decodeProfile = (value: unknown): BrowserProfileRecord => {
  if (!isPlainRecord(value)) throw corruptError();
  const withLabel = Object.prototype.hasOwnProperty.call(value, "label");
  const withLastUsedAt = Object.prototype.hasOwnProperty.call(value, "lastUsedAt");
  const expected = [
    "id",
    "createdAt",
    ...(withLabel ? ["label"] : []),
    ...(withLastUsedAt ? ["lastUsedAt"] : []),
  ];
  if (!hasExactKeys(value, expected)) throw corruptError();
  if (typeof value.id !== "string" || !isValidProfileId(value.id)) throw corruptError();
  if (!isCanonicalTimestamp(value.createdAt)) throw corruptError();
  let label: string | undefined;
  if (withLabel) {
    if (!isCanonicalLabel(value.label)) throw corruptError();
    label = value.label;
  }
  let lastUsedAt: string | undefined;
  if (withLastUsedAt) {
    if (!isCanonicalTimestamp(value.lastUsedAt)) throw corruptError();
    lastUsedAt = value.lastUsedAt;
  }
  return {
    id: value.id,
    createdAt: value.createdAt,
    ...(label === undefined ? {} : { label }),
    ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
  };
};

const decodeProfiles = (value: unknown): ReadonlyArray<BrowserProfileRecord> => {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PROFILES) {
    throw corruptError();
  }
  const profiles = value.map(decodeProfile);
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
    throw corruptError();
  }
  return profiles;
};

const decodeCanvasDefaults = (
  value: unknown,
  profileIds: ReadonlySet<string>,
): Readonly<Record<string, string>> => {
  if (!isPlainRecord(value)) throw corruptError();
  const entries = Object.entries(value);
  if (entries.length > MAX_CANVAS_DEFAULTS) throw corruptError();
  const decoded: Record<string, string> = {};
  for (const [canvas, profile] of entries) {
    if (!CANVAS_NAME.test(canvas) || typeof profile !== "string" || !profileIds.has(profile)) {
      throw corruptError();
    }
    decoded[canvas] = profile;
  }
  return decoded;
};

const isCanonicalAbsolutePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  utf8Bytes(value) <= MAX_PATH_BYTES &&
  !CONTROL_CHARACTER.test(value) &&
  isAbsolute(value) &&
  resolve(value) === value;

const isStrictDescendant = (parent: string, child: string): boolean => {
  const childRelative = relative(parent, child);
  return childRelative.length > 0 && !childRelative.startsWith("..") && !isAbsolute(childRelative);
};

const isDescendantOrEqual = (parent: string, child: string): boolean =>
  parent === child || isStrictDescendant(parent, child);

const areWipePathsValid = (paths: BrowserProfileWipePaths): boolean =>
  isCanonicalAbsolutePath(paths.storagePath) &&
  isCanonicalAbsolutePath(paths.userDataPath) &&
  isCanonicalAbsolutePath(paths.sessionDataPath) &&
  isDescendantOrEqual(paths.userDataPath, paths.sessionDataPath) &&
  isStrictDescendant(paths.userDataPath, paths.storagePath) &&
  isStrictDescendant(paths.sessionDataPath, paths.storagePath);

const decodePendingWipe = (
  value: unknown,
  profileIds: ReadonlySet<string>,
  profileCount: number,
): BrowserProfilePendingWipe => {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "wipeId",
      "profileId",
      "partition",
      "requestedAt",
      "stage",
      "storagePath",
      "userDataPath",
      "sessionDataPath",
    ]) ||
    typeof value.wipeId !== "string" ||
    !UUID_V4.test(value.wipeId) ||
    typeof value.profileId !== "string" ||
    !profileIds.has(value.profileId) ||
    typeof value.partition !== "string" ||
    value.partition !== partitionNameForProfile(value.profileId) ||
    profileCount <= 1 ||
    !isCanonicalTimestamp(value.requestedAt) ||
    (value.stage !== "live_clear_pending" && value.stage !== "restart_delete_pending") ||
    typeof value.storagePath !== "string" ||
    typeof value.userDataPath !== "string" ||
    typeof value.sessionDataPath !== "string" ||
    !areWipePathsValid({
      storagePath: value.storagePath,
      userDataPath: value.userDataPath,
      sessionDataPath: value.sessionDataPath,
    })
  ) {
    throw corruptError();
  }
  return Object.freeze({
    wipeId: value.wipeId,
    profileId: value.profileId,
    partition: value.partition,
    requestedAt: value.requestedAt,
    stage: value.stage,
    storagePath: value.storagePath,
    userDataPath: value.userDataPath,
    sessionDataPath: value.sessionDataPath,
  });
};

const LEGACY_KEYS = [
  "defaultProfile",
  "canvasDefaults",
  "maxWarmSessions",
  "maxVisibleSurfaces",
  "profiles",
] as const;

const READY_KEYS = ["version", "phase", ...LEGACY_KEYS] as const;
const PENDING_KEYS = [...READY_KEYS, "pendingWipe"] as const;

const decodeBase = (record: Record<string, unknown>): BrowserConfigFile => {
  const profiles = decodeProfiles(record.profiles);
  const profileIds = new Set(profiles.map((profile) => profile.id));
  if (
    typeof record.defaultProfile !== "string" ||
    !profileIds.has(record.defaultProfile) ||
    !isBoundedInteger(record.maxWarmSessions, BROWSER_MAX_WARM_SESSIONS_HARD) ||
    !isBoundedInteger(record.maxVisibleSurfaces, BROWSER_MAX_VISIBLE_SURFACES_HARD)
  ) {
    throw corruptError();
  }
  return {
    defaultProfile: record.defaultProfile,
    canvasDefaults: decodeCanvasDefaults(record.canvasDefaults, profileIds),
    maxWarmSessions: record.maxWarmSessions,
    maxVisibleSurfaces: record.maxVisibleSurfaces,
    profiles,
  };
};

const parseConfig = (raw: string): DecodedConfig => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corruptError();
  }
  if (!isPlainRecord(parsed)) throw corruptError();

  if (!Object.prototype.hasOwnProperty.call(parsed, "version")) {
    if (!hasExactKeys(parsed, LEGACY_KEYS)) throw corruptError();
    return {
      config: { version: CONFIG_VERSION, phase: "ready", ...decodeBase(parsed) },
      migrated: true,
    };
  }

  if (parsed.version !== CONFIG_VERSION) throw corruptError();
  if (parsed.phase === "ready") {
    if (!hasExactKeys(parsed, READY_KEYS)) throw corruptError();
    return {
      config: { version: CONFIG_VERSION, phase: "ready", ...decodeBase(parsed) },
      migrated: false,
    };
  }
  if (parsed.phase !== "wipe_pending" || !hasExactKeys(parsed, PENDING_KEYS)) {
    throw corruptError();
  }
  const base = decodeBase(parsed);
  const profileIds = new Set(base.profiles.map((profile) => profile.id));
  return {
    config: {
      version: CONFIG_VERSION,
      phase: "wipe_pending",
      ...base,
      pendingWipe: decodePendingWipe(parsed.pendingWipe, profileIds, base.profiles.length),
    },
    migrated: false,
  };
};

const defaultConfig = (now: () => Date): BrowserConfigDiskReady => {
  const createdAt = now().toISOString();
  return {
    version: CONFIG_VERSION,
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

const currentUid = (): number | undefined =>
  typeof process.getuid === "function" ? process.getuid() : undefined;

const requireOwned = (uid: number): void => {
  const expected = currentUid();
  if (expected !== undefined && uid !== expected) throw corruptError();
};

const requireSafeRegularFile = (info: Stats): void => {
  if (!info.isFile() || info.nlink !== 1) throw corruptError();
  requireOwned(info.uid);
};

const hasSameReadIdentity = (before: Stats, after: Stats): boolean =>
  after.isFile() &&
  before.uid === after.uid &&
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.size === after.size &&
  before.mtimeMs === after.mtimeMs;

const ensureOwnedDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true, mode: OWNER_DIRECTORY_MODE });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw corruptError();
  requireOwned(info.uid);
  if ((info.mode & MODE_MASK) !== OWNER_DIRECTORY_MODE) {
    await chmod(path, OWNER_DIRECTORY_MODE);
  }
};

const ensureContained = (root: string, path: string): void => {
  const fromRoot = relative(root, path);
  if (fromRoot.length === 0 || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw corruptError();
  }
};

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const cleanupOrphanTemps = async (root: string): Promise<void> => {
  const directory = await opendir(root);
  let entries = 0;
  let temps = 0;
  let removed = false;
  try {
    for await (const entry of directory) {
      entries += 1;
      if (entries > MAX_ROOT_ENTRIES) throw corruptError();
      if (!TEMP_FILE.test(entry.name)) continue;
      temps += 1;
      if (temps > MAX_ORPHAN_TEMPS) throw corruptError();
      const path = join(root, entry.name);
      ensureContained(root, path);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw corruptError();
      requireSafeRegularFile(info);
      if ((info.mode & MODE_MASK) !== OWNER_FILE_MODE) await chmod(path, OWNER_FILE_MODE);
      await unlink(path);
      removed = true;
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  if (removed) await syncDirectory(root);
};

const prepareRegistryRoot = async (requestedRoot: string): Promise<string> => {
  if (!isAbsolute(requestedRoot) || resolve(requestedRoot) !== requestedRoot) {
    throw corruptError();
  }
  await ensureOwnedDirectory(requestedRoot);
  const canonicalRoot = await realpath(requestedRoot);
  await ensureOwnedDirectory(profilesDir(canonicalRoot));
  await cleanupOrphanTemps(canonicalRoot);
  return canonicalRoot;
};

const readConfigFile = async (root: string): Promise<string | undefined> => {
  let handle;
  try {
    handle = await open(
      configPath(root),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    if (errnoCode(error) === "ELOOP") throw corruptError();
    throw error;
  }
  try {
    let before = await handle.stat();
    requireSafeRegularFile(before);
    if (before.size > CONFIG_MAX_BYTES) throw corruptError();
    if ((before.mode & MODE_MASK) !== OWNER_FILE_MODE) {
      await handle.chmod(OWNER_FILE_MODE);
      await handle.sync();
      before = await handle.stat();
      requireSafeRegularFile(before);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    requireSafeRegularFile(after);
    if (
      bytes.byteLength > CONFIG_MAX_BYTES ||
      bytes.byteLength !== before.size ||
      !hasSameReadIdentity(before, after)
    ) {
      throw corruptError();
    }
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
};

const validateDestination = async (path: string): Promise<void> => {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw corruptError();
    requireSafeRegularFile(info);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
    throw error;
  }
};

const atomicWriteConfig = async (root: string, config: BrowserConfigDisk): Promise<void> => {
  const body = `${JSON.stringify(config, null, 2)}\n`;
  if (utf8Bytes(body) > CONFIG_MAX_BYTES) throw corruptError();
  const temporary = join(root, `.config.${randomUUID()}.tmp`);
  ensureContained(root, temporary);
  let renamed = false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      OWNER_FILE_MODE,
    );
    requireSafeRegularFile(await handle.stat());
    await handle.writeFile(body, "utf8");
    await handle.chmod(OWNER_FILE_MODE);
    await handle.sync();
    const written = await handle.stat();
    requireSafeRegularFile(written);
    if (written.size !== utf8Bytes(body)) throw corruptError();
    await handle.close();
    handle = undefined;
    await validateDestination(configPath(root));
    await rename(temporary, configPath(root));
    renamed = true;
    await syncDirectory(root);
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    if (!renamed) await unlink(temporary).catch(() => undefined);
  }
};

const ensureProfileDirectories = async (
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

const removeEmptyProfileDirectory = async (root: string, id: string): Promise<void> => {
  const path = profileDir(root, id);
  ensureContained(root, path);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw corruptError();
  requireOwned(info.uid);
  const directory = await opendir(path);
  try {
    const first = await directory.read();
    if (first !== null) throw corruptError();
  } finally {
    await directory.close().catch(() => undefined);
  }
  await rmdir(path);
  await syncDirectory(profilesDir(root));
};

const asPublicConfig = (config: BrowserConfigDiskReady): BrowserConfigFile => ({
  defaultProfile: config.defaultProfile,
  canvasDefaults: config.canvasDefaults,
  maxWarmSessions: config.maxWarmSessions,
  maxVisibleSurfaces: config.maxVisibleSurfaces,
  profiles: config.profiles,
});

/**
 * Pending state remains durable exactly as written, but ordinary browser
 * consumers receive a view with only usable profiles. This keeps sibling
 * profiles live without ever handing the pending target back to an opener.
 */
const asOperationalConfig = (config: BrowserConfigDisk): BrowserConfigFile => {
  if (config.phase === "ready") return asPublicConfig(config);
  const pendingId = config.pendingWipe.profileId;
  const profiles = config.profiles.filter((profile) => profile.id !== pendingId);
  return {
    defaultProfile:
      config.defaultProfile === pendingId ? profiles[0]!.id : config.defaultProfile,
    canvasDefaults: Object.fromEntries(
      Object.entries(config.canvasDefaults).filter(([, profile]) => profile !== pendingId),
    ),
    maxWarmSessions: config.maxWarmSessions,
    maxVisibleSurfaces: config.maxVisibleSurfaces,
    profiles,
  };
};

export const makeBrowserProfileService = (
  root: string = browserRootDir(),
  options: BrowserProfileServiceOptions = {},
): BrowserProfileServiceApi => {
  const requestedRoot = root;
  const now = options.now ?? (() => new Date());
  let mutationChain: Promise<unknown> = Promise.resolve();

  const withRegistryLock = <A>(operation: () => Promise<A>): Promise<A> => {
    const run = mutationChain.then(operation, operation);
    mutationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const load = async (): Promise<{ root: string; config: BrowserConfigDisk }> => {
    const canonicalRoot = await prepareRegistryRoot(requestedRoot);
    const raw = await readConfigFile(canonicalRoot);
    if (raw === undefined) {
      const config = defaultConfig(now);
      await ensureProfileDirectories(canonicalRoot, config.profiles);
      await atomicWriteConfig(canonicalRoot, config);
      return { root: canonicalRoot, config };
    }
    const decoded = parseConfig(raw);
    await ensureProfileDirectories(canonicalRoot, decoded.config.profiles);
    if (decoded.migrated) await atomicWriteConfig(canonicalRoot, decoded.config);
    return { root: canonicalRoot, config: decoded.config };
  };

  const write = async (rootPath: string, config: BrowserConfigDisk): Promise<void> => {
    await ensureProfileDirectories(rootPath, config.profiles);
    await atomicWriteConfig(rootPath, config);
  };

  const requireReady = (config: BrowserConfigDisk): BrowserConfigDiskReady => {
    if (config.phase !== "ready") throw pendingError();
    return config;
  };

  const finalizePending = async (
    rootPath: string,
    config: BrowserConfigDiskPending,
  ): Promise<BrowserConfigDiskReady> => {
    await removeEmptyProfileDirectory(rootPath, config.pendingWipe.profileId);
    const nextProfiles = config.profiles.filter(
      (profile) => profile.id !== config.pendingWipe.profileId,
    );
    const next: BrowserConfigDiskReady = {
      version: CONFIG_VERSION,
      phase: "ready",
      defaultProfile:
        config.defaultProfile === config.pendingWipe.profileId
          ? nextProfiles[0]!.id
          : config.defaultProfile,
      canvasDefaults: Object.fromEntries(
        Object.entries(config.canvasDefaults).filter(
          ([, profile]) => profile !== config.pendingWipe.profileId,
        ),
      ),
      maxWarmSessions: config.maxWarmSessions,
      maxVisibleSurfaces: config.maxVisibleSurfaces,
      profiles: nextProfiles,
    };
    await write(rootPath, next);
    return next;
  };

  const recoverPendingCold = async (
    rootPath: string,
    config: BrowserConfigDiskPending,
  ): Promise<BrowserConfigDiskReady> => {
    const lifecycle = options.wipeLifecycle;
    if (lifecycle === undefined) throw pendingError();
    try {
      await lifecycle.recoverCold(config.pendingWipe);
    } catch {
      throw pendingError();
    }
    return finalizePending(rootPath, config);
  };

  const executePendingLive = async (
    rootPath: string,
    config: BrowserConfigDiskPending,
  ): Promise<BrowserProfileWipeReceipt> => {
    const lifecycle = options.wipeLifecycle;
    if (lifecycle === undefined) throw pendingError();
    let outcome: BrowserProfileWipeOutcome;
    try {
      outcome = await lifecycle.executeLive(config.pendingWipe);
    } catch {
      throw pendingError();
    }
    if (outcome.status === "restart_delete_pending") {
      await write(rootPath, {
        ...config,
        pendingWipe: Object.freeze({
          ...config.pendingWipe,
          stage: "restart_delete_pending",
        }),
      });
      return Object.freeze({ status: "restart_required" });
    }
    if (outcome.status !== "complete") throw pendingError();
    await finalizePending(rootPath, config);
    return Object.freeze({ status: "complete" });
  };

  const initializePromise = (): Promise<BrowserConfigFile> =>
    withRegistryLock(async () => {
      const { config } = await load();
      return asOperationalConfig(config);
    });

  const effect = <A>(operation: () => Promise<A>): Effect.Effect<A, BrowserProfileError> =>
    Effect.tryPromise({ try: operation, catch: toPublicError });

  const initialize = effect(initializePromise);

  return {
    rootDir: () => requestedRoot,
    doctor: Effect.promise(() =>
      withRegistryLock(async (): Promise<ServiceCheck> => {
        try {
          const { config } = await load();
          return config.phase === "ready"
            ? {
                id: "browser-profiles",
                label: "Browser Profiles",
                status: "ok" as const,
                detail: `registry v${CONFIG_VERSION} · ${config.profiles.length} profiles`,
              }
            : {
                id: "browser-profiles",
                label: "Browser Profiles",
                status: "error" as const,
                detail: "profile wipe recovery required",
              };
        } catch (error) {
          return {
            id: "browser-profiles",
            label: "Browser Profiles",
            status: "error" as const,
            detail:
              error instanceof BrowserProfileError && error.code === "corrupt"
                ? "profile registry corrupt"
                : "profile registry unavailable",
          };
        }
      }),
    ),
    initialize,
    ensureDefaults: initialize,
    recoverPendingWipe: effect(() =>
      withRegistryLock(async () => {
        const loaded = await load();
        if (loaded.config.phase === "wipe_pending") {
          await recoverPendingCold(loaded.root, loaded.config);
        }
      }),
    ),
    readConfig: effect(() =>
      withRegistryLock(async () => {
        const { config } = await load();
        return asOperationalConfig(config);
      }),
    ),
    listProfiles: effect(() =>
      withRegistryLock(async () => {
        const { config } = await load();
        return asOperationalConfig(config).profiles;
      }),
    ),
    createProfile: (id: string, label?: string) =>
      effect(() =>
        withRegistryLock(async () => {
          if (!isValidProfileId(id)) {
            throw new BrowserProfileError({ message: "invalid profile id", code: "invalid" });
          }
          const normalizedLabel = label?.trim();
          if (
            normalizedLabel !== undefined &&
            normalizedLabel.length > 0 &&
            !isCanonicalLabel(normalizedLabel)
          ) {
            throw new BrowserProfileError({ message: "invalid profile label", code: "invalid" });
          }
          const loaded = await load();
          const config = requireReady(loaded.config);
          if (config.profiles.length >= MAX_PROFILES) {
            throw new BrowserProfileError({ message: "profile limit reached", code: "forbidden" });
          }
          if (config.profiles.some((profile) => profile.id === id)) {
            throw new BrowserProfileError({ message: "profile already exists", code: "invalid" });
          }
          const record: BrowserProfileRecord = {
            id,
            ...(normalizedLabel ? { label: normalizedLabel } : {}),
            createdAt: now().toISOString(),
          };
          await write(loaded.root, {
            ...config,
            profiles: [...config.profiles, record],
          });
          return record;
        }),
      ),
    wipeProfile: (id: string) =>
      effect(() =>
        withRegistryLock(async () => {
          if (!isValidProfileId(id)) {
            throw new BrowserProfileError({ message: "invalid profile id", code: "invalid" });
          }
          const loaded = await load();
          if (loaded.config.phase === "wipe_pending") {
            throw pendingError();
          }
          const config = loaded.config;
          if (!config.profiles.some((profile) => profile.id === id)) {
            throw new BrowserProfileError({ message: "profile not found", code: "not_found" });
          }
          if (config.profiles.length <= 1) {
            throw new BrowserProfileError({
              message: "cannot wipe the last browser profile",
              code: "forbidden",
            });
          }
          const lifecycle = options.wipeLifecycle;
          if (lifecycle === undefined) {
            throw new BrowserProfileError({
              message: "browser profile wipe lifecycle unavailable",
              code: "forbidden",
            });
          }
          const wipeId = randomUUID();
          const partition = partitionNameForProfile(id);
          let paths: BrowserProfileWipePaths;
          try {
            paths = await lifecycle.prepare({
              wipeId,
              profileId: id,
              partition,
            });
          } catch {
            throw new BrowserProfileError({
              message: "browser profile wipe preparation failed",
              code: "forbidden",
            });
          }
          if (!areWipePathsValid(paths)) {
            throw new BrowserProfileError({
              message: "browser profile wipe paths rejected",
              code: "forbidden",
            });
          }
          const pending: BrowserConfigDiskPending = {
            ...config,
            phase: "wipe_pending",
            pendingWipe: Object.freeze({
              wipeId,
              profileId: id,
              partition,
              requestedAt: now().toISOString(),
              stage: "live_clear_pending",
              storagePath: paths.storagePath,
              userDataPath: paths.userDataPath,
              sessionDataPath: paths.sessionDataPath,
            }),
          };
          await write(loaded.root, pending);
          return executePendingLive(loaded.root, pending);
        }),
      ),
    touchProfile: (id: string) =>
      effect(() =>
        withRegistryLock(async () => {
          if (!isValidProfileId(id)) {
            throw new BrowserProfileError({ message: "invalid profile id", code: "invalid" });
          }
          const loaded = await load();
          const config = loaded.config;
          if (config.phase === "wipe_pending" && config.pendingWipe.profileId === id) {
            throw pendingError();
          }
          if (!config.profiles.some((profile) => profile.id === id)) {
            throw new BrowserProfileError({ message: "profile not found", code: "not_found" });
          }
          const touched = now().toISOString();
          await write(loaded.root, {
            ...config,
            profiles: config.profiles.map((profile) =>
              profile.id === id ? { ...profile, lastUsedAt: touched } : profile,
            ),
          });
        }),
      ),
    resolveDefaultProfile: (canvasName?: string) =>
      effect(() =>
        withRegistryLock(async () => {
          const { config } = await load();
          const operational = asOperationalConfig(config);
          if (canvasName !== undefined && !CANVAS_NAME.test(canvasName)) {
            throw new BrowserProfileError({ message: "invalid canvas name", code: "invalid" });
          }
          return (canvasName && operational.canvasDefaults[canvasName]) || operational.defaultProfile;
        }),
      ),
    partitionName: (profileId: string) =>
      effect(() =>
        withRegistryLock(async () => {
          if (!isValidProfileId(profileId)) {
            throw new BrowserProfileError({ message: "invalid profile id", code: "invalid" });
          }
          const { config } = await load();
          if (config.phase === "wipe_pending" && config.pendingWipe.profileId === profileId) {
            throw pendingError();
          }
          if (!config.profiles.some((profile) => profile.id === profileId)) {
            throw new BrowserProfileError({ message: "profile not found", code: "not_found" });
          }
          return partitionNameForProfile(profileId);
        }),
      ),
  };
};

export const BrowserProfileLive = Layer.sync(BrowserProfileService, () =>
  makeBrowserProfileService(),
);

/** Test helper: service rooted at an explicit directory (no home). */
export const BrowserProfileTestLive = (root: string) =>
  Layer.succeed(BrowserProfileService, makeBrowserProfileService(root));

// Re-export for callers that only need bounded path listing without Effect.
export const listProfileDirs = async (root: string = browserRootDir()): Promise<string[]> => {
  try {
    if (!isAbsolute(root) || resolve(root) !== root) return [];
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return [];
    requireOwned(rootInfo.uid);
    const canonicalRoot = await realpath(root);
    const directoryPath = profilesDir(canonicalRoot);
    ensureContained(canonicalRoot, directoryPath);
    const profilesInfo = await lstat(directoryPath);
    if (profilesInfo.isSymbolicLink() || !profilesInfo.isDirectory()) return [];
    requireOwned(profilesInfo.uid);
    const directory = await opendir(directoryPath);
    const entries: string[] = [];
    let scanned = 0;
    try {
      for await (const entry of directory) {
        scanned += 1;
        if (scanned > MAX_ROOT_ENTRIES) throw corruptError();
        if (entries.length >= MAX_PROFILES) break;
        if (!isValidProfileId(entry.name)) continue;
        const path = join(directoryPath, entry.name);
        ensureContained(directoryPath, path);
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isDirectory()) throw corruptError();
        requireOwned(info.uid);
        entries.push(entry.name);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    return entries;
  } catch {
    return [];
  }
};
