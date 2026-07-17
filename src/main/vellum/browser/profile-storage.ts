import { constants as fsConstants, type Dirent, type Stats } from "node:fs";
import {
  lstat,
  open,
  opendir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isValidProfileId, partitionNameForProfile } from "@shared/browser";
import type { BrowserCapabilityProfileRevocationReason } from "./capabilities";
import type { BrowserProfileBlock, BrowserProfileGate } from "./profile-gate";
import type {
  BrowserProfilePendingWipe,
  BrowserProfileWipeLifecycle,
  BrowserProfileWipeOutcome,
  BrowserProfileWipePaths,
} from "./profiles";
import type {
  BrowserProfileQuiescence,
  BrowserResult,
} from "./sessions";

const MAX_PATH_BYTES = 4_096;
const MAX_DELETE_DEPTH = 128;
const MAX_DELETE_ENTRIES = 1_000_000;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUARANTINE_PREFIX = ".vellum-wipe-";

export type BrowserProfileStorageStage =
  | "prepare"
  | "quiesce"
  | "revalidate"
  | "flush"
  | "connections"
  | "browser_data"
  | "auth_cache"
  | "http_cache"
  | "cold_validate"
  | "quarantine"
  | "delete"
  | "commit";

export type BrowserProfileStorageErrorCode =
  | "invalid_input"
  | "session_unavailable"
  | "session_not_persistent"
  | "unsafe_path"
  | "root_changed"
  | "path_changed"
  | "gate_blocked"
  | "capability_revoke_failed"
  | "quiescence_failed"
  | "quiescence_timeout"
  | "storage_clear_failed"
  | "collision"
  | "filesystem_failed"
  | "delete_limit"
  | "gate_commit_failed"
  | "failpoint";

const ERROR_MESSAGES: Readonly<Record<BrowserProfileStorageErrorCode, string>> = Object.freeze({
  invalid_input: "browser profile wipe input rejected",
  session_unavailable: "browser profile session unavailable",
  session_not_persistent: "browser profile session is not persistent",
  unsafe_path: "browser profile storage path rejected",
  root_changed: "browser profile storage roots changed",
  path_changed: "browser profile storage identity changed",
  gate_blocked: "browser profile admission gate unavailable",
  capability_revoke_failed: "browser profile capability revocation failed",
  quiescence_failed: "browser profile quiescence failed",
  quiescence_timeout: "browser profile quiescence timed out",
  storage_clear_failed: "browser profile storage clear failed",
  collision: "browser profile wipe quarantine collision",
  filesystem_failed: "browser profile storage filesystem operation failed",
  delete_limit: "browser profile storage delete limit exceeded",
  gate_commit_failed: "browser profile deletion gate commit failed",
  failpoint: "browser profile wipe interrupted",
});

/** Fixed-message failure. Paths and underlying exception text never cross this boundary. */
export class BrowserProfileStorageError extends Error {
  readonly name = "BrowserProfileStorageError";

  constructor(
    readonly stage: BrowserProfileStorageStage,
    readonly code: BrowserProfileStorageErrorCode,
    readonly retryable: boolean,
  ) {
    super(ERROR_MESSAGES[code]);
  }
}

export interface BrowserProfileStorageRootPaths {
  readonly userDataPath: string;
  readonly sessionDataPath: string;
}

export interface BrowserProfileStorageSession {
  readonly getStoragePath: () => string | null;
  readonly isPersistent: () => boolean;
  readonly flushStorageData: () => void;
  readonly closeAllConnections: () => Promise<void>;
  readonly clearData: () => Promise<void>;
  readonly clearAuthCache: () => Promise<void>;
  readonly clearCache: () => Promise<void>;
}

/** Electron-only calls live behind this port. Cold recovery uses currentRoots only. */
export interface BrowserProfileStoragePlatform {
  readonly currentRoots: () => BrowserProfileStorageRootPaths;
  readonly sessionForPartition: (partition: string) => BrowserProfileStorageSession;
}

export interface BrowserProfileStorageDirectory extends AsyncIterable<Dirent> {
  readonly close: () => Promise<void>;
}

export interface BrowserProfileStorageFileSystem {
  readonly lstat: (path: string) => Promise<Stats>;
  readonly opendir: (path: string) => Promise<BrowserProfileStorageDirectory>;
  readonly realpath: (path: string) => Promise<string>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly rmdir: (path: string) => Promise<void>;
  readonly syncDirectory: (
    path: string,
    expected: { readonly dev: number; readonly ino: number; readonly uid: number },
  ) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
}

export interface BrowserProfileStorageFailpoints {
  readonly afterQuarantineRename?: (input: {
    readonly wipeId: string;
    readonly profileId: string;
  }) => void | Promise<void>;
}

/** Exact session-control authority required by the storage lifecycle. */
export interface BrowserProfileStorageSessionControl {
  readonly beginProfileQuiescence: (
    profile: string,
    reason?: string,
  ) => BrowserResult<BrowserProfileQuiescence>;
}

/** Exact capability-control authority required by the storage lifecycle. */
export interface BrowserProfileStorageCapabilityControl {
  readonly revokeByProfile: (
    profile: string,
    reason: BrowserCapabilityProfileRevocationReason,
  ) => number;
}

export interface BrowserProfileStorageDependencies {
  readonly platform: BrowserProfileStoragePlatform;
  readonly sessions: BrowserProfileStorageSessionControl;
  readonly capabilities: BrowserProfileStorageCapabilityControl;
  readonly profileGate: BrowserProfileGate;
  readonly fileSystem?: Partial<BrowserProfileStorageFileSystem>;
  readonly failpoints?: BrowserProfileStorageFailpoints;
}

interface DirectoryIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
}

interface RootIdentities {
  readonly userData: DirectoryIdentity;
  readonly sessionData: DirectoryIdentity;
}

interface PreparedWipe {
  readonly wipeId: string;
  readonly profileId: string;
  readonly partition: string;
  readonly paths: BrowserProfileWipePaths;
  readonly session: BrowserProfileStorageSession;
  readonly roots: RootIdentities;
  readonly storage?: DirectoryIdentity;
}

interface RetainedBlock {
  readonly wipeId: string;
  readonly profileId: string;
  readonly block: BrowserProfileBlock;
}

interface ColdRecoveryStorage {
  readonly parent: DirectoryIdentity | undefined;
  readonly quarantinePath: string;
  readonly target: DirectoryIdentity | undefined;
  readonly quarantine: DirectoryIdentity | undefined;
}

interface DeleteBudget {
  entries: number;
}

const DEFAULT_FILE_SYSTEM: BrowserProfileStorageFileSystem = Object.freeze({
  lstat,
  opendir,
  realpath,
  rename,
  rmdir,
  syncDirectory: async (
    path: string,
    expected: { readonly dev: number; readonly ino: number; readonly uid: number },
  ) => {
    const handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (
        !info.isDirectory() ||
        info.dev !== expected.dev ||
        info.ino !== expected.ino ||
        info.uid !== expected.uid
      ) {
        throw new Error("directory identity changed");
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  unlink,
});

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errnoCode = (error: unknown): string | undefined =>
  isPlainRecord(error) && typeof error.code === "string" ? error.code : undefined;

const isCanonicalAbsolutePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value, "utf8") <= MAX_PATH_BYTES &&
  !CONTROL_CHARACTER.test(value) &&
  isAbsolute(value) &&
  resolve(value) === value;

const isStrictDescendant = (parent: string, child: string): boolean => {
  const fromParent = relative(parent, child);
  return fromParent.length > 0 && !fromParent.startsWith("..") && !isAbsolute(fromParent);
};

const isDescendantOrEqual = (parent: string, child: string): boolean =>
  parent === child || isStrictDescendant(parent, child);

const currentUid = (): number | undefined =>
  typeof process.getuid === "function" ? process.getuid() : undefined;

const sameIdentity = (left: DirectoryIdentity, right: DirectoryIdentity): boolean =>
  left.path === right.path &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.uid === right.uid;

const identityFromStats = (path: string, info: Stats): DirectoryIdentity => ({
  path,
  dev: info.dev,
  ino: info.ino,
  uid: info.uid,
});

const storageError = (
  stage: BrowserProfileStorageStage,
  code: BrowserProfileStorageErrorCode,
  retryable: boolean,
): BrowserProfileStorageError => new BrowserProfileStorageError(stage, code, retryable);

const quarantinePathFor = (storagePath: string, wipeId: string): string =>
  join(dirname(storagePath), `${QUARANTINE_PREFIX}${wipeId}`);

export const browserProfileQuarantinePath = (
  storagePath: string,
  wipeId: string,
): string | undefined => {
  if (!isCanonicalAbsolutePath(storagePath) || !UUID_V4.test(wipeId)) return undefined;
  const quarantine = quarantinePathFor(storagePath, wipeId);
  return isCanonicalAbsolutePath(quarantine) ? quarantine : undefined;
};

class BrowserProfileStorageLifecycle implements BrowserProfileWipeLifecycle {
  readonly #platform: BrowserProfileStoragePlatform;
  readonly #sessions: BrowserProfileStorageSessionControl;
  readonly #capabilities: BrowserProfileStorageCapabilityControl;
  readonly #profileGate: BrowserProfileGate;
  readonly #fileSystem: BrowserProfileStorageFileSystem;
  readonly #failpoints: BrowserProfileStorageFailpoints;
  #prepared: PreparedWipe | undefined;
  #retainedBlock: RetainedBlock | undefined;

  constructor(dependencies: BrowserProfileStorageDependencies) {
    this.#platform = dependencies.platform;
    this.#sessions = dependencies.sessions;
    this.#capabilities = dependencies.capabilities;
    this.#profileGate = dependencies.profileGate;
    this.#fileSystem = Object.freeze({
      ...DEFAULT_FILE_SYSTEM,
      ...dependencies.fileSystem,
    });
    this.#failpoints = dependencies.failpoints ?? {};
  }

  async prepare(input: {
    readonly wipeId: string;
    readonly profileId: string;
    readonly partition: string;
  }): Promise<BrowserProfileWipePaths> {
    this.#validateIdentity(input.wipeId, input.profileId, input.partition, "prepare");
    this.#prepared = undefined;
    if (this.#retainedBlock !== undefined) {
      throw storageError("prepare", "invalid_input", false);
    }

    const roots = await this.#readAndValidateCurrentRoots("prepare");
    const session = this.#sessionForPartition(input.partition, "prepare");
    if (!this.#sessionIsPersistent(session, "prepare")) {
      throw storageError("prepare", "session_not_persistent", false);
    }
    const storagePath = this.#sessionStoragePath(session, "prepare");
    this.#validatePathRelationships(roots.userData.path, roots.sessionData.path, storagePath, "prepare");
    const storage = await this.#validateExistingAncestorPrefix(
      roots.sessionData.path,
      storagePath,
      "prepare",
    );
    const paths = Object.freeze({
      storagePath,
      userDataPath: roots.userData.path,
      sessionDataPath: roots.sessionData.path,
    });
    this.#prepared = Object.freeze({
      ...input,
      paths,
      session,
      roots,
      ...(storage === undefined ? {} : { storage }),
    });
    return paths;
  }

  async executeLive(pending: BrowserProfilePendingWipe): Promise<BrowserProfileWipeOutcome> {
    this.#validatePending(pending, "quiesce");
    if (pending.stage !== "live_clear_pending") {
      throw storageError("quiesce", "invalid_input", false);
    }
    const prepared = this.#prepared;
    if (prepared === undefined || !this.#pendingMatchesPrepared(pending, prepared)) {
      throw storageError("quiesce", "path_changed", false);
    }

    try {
      const quiescence = this.#sessions.beginProfileQuiescence(
        pending.profileId,
        "browser profile wipe",
      );
      if (!quiescence.ok) {
        throw storageError(
          "quiesce",
          quiescence.code === "timeout" ? "quiescence_timeout" : "quiescence_failed",
          true,
        );
      }
      this.#retainedBlock = Object.freeze({
        wipeId: pending.wipeId,
        profileId: pending.profileId,
        block: quiescence.data.block,
      });
      if (this.#profileGate.disposition(pending.profileId) !== "quiescing") {
        throw storageError("quiesce", "gate_blocked", false);
      }

      try {
        const revoked = this.#capabilities.revokeByProfile(pending.profileId, "profile_wipe");
        if (!Number.isSafeInteger(revoked) || revoked < 0) {
          throw storageError("quiesce", "capability_revoke_failed", true);
        }
      } catch (error) {
        if (error instanceof BrowserProfileStorageError) throw error;
        throw storageError("quiesce", "capability_revoke_failed", true);
      }

      await this.#awaitPhysicalDestruction(quiescence.data);
      await this.#revalidateLiveSession(pending, prepared);
      await this.#clearLiveSession(prepared.session);
      return Object.freeze({ status: "restart_delete_pending" });
    } finally {
      this.#prepared = undefined;
    }
  }

  async recoverCold(pending: BrowserProfilePendingWipe): Promise<void> {
    this.#validatePending(pending, "cold_validate");
    const block = this.#beginOrRetainBlock(pending);
    const storage = await this.#validateColdRecoveryStorage(pending);
    const quarantine = await this.#quarantineColdRecoveryStorage(pending, storage);
    await this.#deleteColdRecoveryStorage(pending.storagePath, storage, quarantine);
    this.#commitColdRecovery(pending.profileId, block);
  }

  async #validateColdRecoveryStorage(
    pending: BrowserProfilePendingWipe,
  ): Promise<ColdRecoveryStorage> {
    const roots = await this.#readAndValidateCurrentRoots("cold_validate", {
      userDataPath: pending.userDataPath,
      sessionDataPath: pending.sessionDataPath,
    });
    this.#validatePathRelationships(
      roots.userData.path,
      roots.sessionData.path,
      pending.storagePath,
      "cold_validate",
    );
    const parent = await this.#validateExistingAncestorPrefix(
      roots.sessionData.path,
      dirname(pending.storagePath),
      "cold_validate",
    );

    const quarantinePath = browserProfileQuarantinePath(pending.storagePath, pending.wipeId);
    if (
      quarantinePath === undefined ||
      !isStrictDescendant(roots.sessionData.path, quarantinePath)
    ) {
      throw storageError("cold_validate", "unsafe_path", false);
    }

    const target = await this.#optionalDirectory(pending.storagePath, "cold_validate");
    const quarantine = await this.#optionalDirectory(quarantinePath, "cold_validate");
    if (parent === undefined && (target !== undefined || quarantine !== undefined)) {
      throw storageError("cold_validate", "path_changed", false);
    }
    if (target !== undefined && quarantine !== undefined) {
      throw storageError("quarantine", "collision", false);
    }
    if (
      parent !== undefined &&
      ((target !== undefined && target.dev !== parent.dev) ||
        (quarantine !== undefined && quarantine.dev !== parent.dev))
    ) {
      throw storageError("cold_validate", "unsafe_path", false);
    }
    return Object.freeze({ parent, quarantinePath, target, quarantine });
  }

  async #quarantineColdRecoveryStorage(
    pending: BrowserProfilePendingWipe,
    storage: ColdRecoveryStorage,
  ): Promise<DirectoryIdentity | undefined> {
    if (storage.target === undefined) return storage.quarantine;
    try {
      await this.#fileSystem.rename(pending.storagePath, storage.quarantinePath);
    } catch {
      throw storageError("quarantine", "filesystem_failed", true);
    }
    const targetAfter = await this.#optionalLstat(pending.storagePath, "quarantine");
    const renamed = await this.#optionalDirectory(storage.quarantinePath, "quarantine");
    if (
      targetAfter !== undefined ||
      renamed === undefined ||
      storage.target.dev !== renamed.dev ||
      storage.target.ino !== renamed.ino ||
      storage.target.uid !== renamed.uid
    ) {
      throw storageError("quarantine", "path_changed", false);
    }
    if (storage.parent === undefined) {
      throw storageError("quarantine", "path_changed", false);
    }
    await this.#syncDirectory(storage.parent, "quarantine");
    await this.#runAfterRenameFailpoint(pending);
    return renamed;
  }

  async #deleteColdRecoveryStorage(
    storagePath: string,
    storage: ColdRecoveryStorage,
    quarantine: DirectoryIdentity | undefined,
  ): Promise<void> {
    if (quarantine !== undefined) {
      await this.#removeTreeNoFollow(storage.quarantinePath, 0, { entries: 0 }, quarantine);
    }
    if (
      (await this.#optionalLstat(storagePath, "delete")) !== undefined ||
      (await this.#optionalLstat(storage.quarantinePath, "delete")) !== undefined
    ) {
      throw storageError("delete", "path_changed", true);
    }
    if (storage.parent !== undefined) {
      await this.#syncDirectory(storage.parent, "delete");
    }
  }

  #commitColdRecovery(
    profileId: string,
    block: BrowserProfileBlock | undefined,
  ): void {
    if (block !== undefined) {
      if (!this.#profileGate.commitDeleted(block)) {
        throw storageError("commit", "gate_commit_failed", false);
      }
      this.#retainedBlock = undefined;
    } else if (this.#profileGate.disposition(profileId) !== "deleted") {
      throw storageError("commit", "gate_commit_failed", false);
    }
  }

  #validateIdentity(
    wipeId: unknown,
    profileId: unknown,
    partition: unknown,
    stage: BrowserProfileStorageStage,
  ): void {
    if (
      typeof wipeId !== "string" ||
      !UUID_V4.test(wipeId) ||
      typeof profileId !== "string" ||
      !isValidProfileId(profileId) ||
      typeof partition !== "string" ||
      partition !== partitionNameForProfile(profileId)
    ) {
      throw storageError(stage, "invalid_input", false);
    }
  }

  #validatePending(
    pending: BrowserProfilePendingWipe,
    stage: BrowserProfileStorageStage,
  ): void {
    if (!isPlainRecord(pending)) throw storageError(stage, "invalid_input", false);
    this.#validateIdentity(pending.wipeId, pending.profileId, pending.partition, stage);
    if (
      (pending.stage !== "live_clear_pending" &&
        pending.stage !== "restart_delete_pending") ||
      !isCanonicalAbsolutePath(pending.userDataPath) ||
      !isCanonicalAbsolutePath(pending.sessionDataPath) ||
      !isCanonicalAbsolutePath(pending.storagePath)
    ) {
      throw storageError(stage, "invalid_input", false);
    }
    this.#validatePathRelationships(
      pending.userDataPath,
      pending.sessionDataPath,
      pending.storagePath,
      stage,
    );
  }

  #validatePathRelationships(
    userDataPath: string,
    sessionDataPath: string,
    storagePath: string,
    stage: BrowserProfileStorageStage,
  ): void {
    if (
      !isDescendantOrEqual(userDataPath, sessionDataPath) ||
      !isStrictDescendant(userDataPath, storagePath) ||
      !isStrictDescendant(sessionDataPath, storagePath)
    ) {
      throw storageError(stage, "unsafe_path", false);
    }
  }

  #sessionForPartition(
    partition: string,
    stage: BrowserProfileStorageStage,
  ): BrowserProfileStorageSession {
    try {
      const session = this.#platform.sessionForPartition(partition);
      if (typeof session !== "object" || session === null) {
        throw storageError(stage, "session_unavailable", true);
      }
      return session;
    } catch (error) {
      if (error instanceof BrowserProfileStorageError) throw error;
      throw storageError(stage, "session_unavailable", true);
    }
  }

  #sessionIsPersistent(
    session: BrowserProfileStorageSession,
    stage: BrowserProfileStorageStage,
  ): boolean {
    try {
      return session.isPersistent() === true;
    } catch {
      throw storageError(stage, "session_unavailable", true);
    }
  }

  #sessionStoragePath(
    session: BrowserProfileStorageSession,
    stage: BrowserProfileStorageStage,
  ): string {
    let path: string | null;
    try {
      path = session.getStoragePath();
    } catch {
      throw storageError(stage, "session_unavailable", true);
    }
    if (!isCanonicalAbsolutePath(path)) {
      throw storageError(stage, "unsafe_path", false);
    }
    return path;
  }

  async #readAndValidateCurrentRoots(
    stage: BrowserProfileStorageStage,
    expected?: BrowserProfileStorageRootPaths,
  ): Promise<RootIdentities> {
    let current: BrowserProfileStorageRootPaths;
    try {
      current = this.#platform.currentRoots();
    } catch {
      throw storageError(stage, "root_changed", false);
    }
    if (
      !isPlainRecord(current) ||
      !isCanonicalAbsolutePath(current.userDataPath) ||
      !isCanonicalAbsolutePath(current.sessionDataPath) ||
      (expected !== undefined &&
        (current.userDataPath !== expected.userDataPath ||
          current.sessionDataPath !== expected.sessionDataPath))
    ) {
      throw storageError(stage, "root_changed", false);
    }
    if (!isDescendantOrEqual(current.userDataPath, current.sessionDataPath)) {
      throw storageError(stage, "unsafe_path", false);
    }
    const userData = await this.#validateDirectory(current.userDataPath, stage);
    const sessionData =
      current.sessionDataPath === current.userDataPath
        ? userData
        : await this.#validateDirectory(current.sessionDataPath, stage);
    return Object.freeze({ userData, sessionData });
  }

  async #validateDirectory(
    path: string,
    stage: BrowserProfileStorageStage,
  ): Promise<DirectoryIdentity> {
    if (!isCanonicalAbsolutePath(path)) throw storageError(stage, "unsafe_path", false);
    let before: Stats;
    let canonical: string;
    try {
      before = await this.#fileSystem.lstat(path);
      canonical = await this.#fileSystem.realpath(path);
    } catch {
      throw storageError(stage, "unsafe_path", false);
    }
    const uid = currentUid();
    if (
      before.isSymbolicLink() ||
      !before.isDirectory() ||
      (uid !== undefined && before.uid !== uid) ||
      canonical !== path
    ) {
      throw storageError(stage, "unsafe_path", false);
    }
    let after: Stats;
    try {
      after = await this.#fileSystem.lstat(path);
    } catch {
      throw storageError(stage, "path_changed", false);
    }
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.uid !== after.uid
    ) {
      throw storageError(stage, "path_changed", false);
    }
    return Object.freeze(identityFromStats(path, after));
  }

  async #validateExistingAncestorPrefix(
    root: string,
    target: string,
    stage: BrowserProfileStorageStage,
  ): Promise<DirectoryIdentity | undefined> {
    if (target === root) return this.#validateDirectory(root, stage);
    if (!isStrictDescendant(root, target)) {
      throw storageError(stage, "unsafe_path", false);
    }
    const pathParts = relative(root, target).split(sep);
    let current = root;
    let identity = await this.#validateDirectory(root, stage);
    for (const part of pathParts) {
      if (part.length === 0 || part === "." || part === "..") {
        throw storageError(stage, "unsafe_path", false);
      }
      current = join(current, part);
      if ((await this.#optionalLstat(current, stage)) === undefined) return undefined;
      identity = await this.#validateDirectory(current, stage);
    }
    return identity;
  }

  #pendingMatchesPrepared(
    pending: BrowserProfilePendingWipe,
    prepared: PreparedWipe,
  ): boolean {
    return (
      pending.wipeId === prepared.wipeId &&
      pending.profileId === prepared.profileId &&
      pending.partition === prepared.partition &&
      pending.storagePath === prepared.paths.storagePath &&
      pending.userDataPath === prepared.paths.userDataPath &&
      pending.sessionDataPath === prepared.paths.sessionDataPath
    );
  }

  async #awaitPhysicalDestruction(quiescence: BrowserProfileQuiescence): Promise<void> {
    let completion: BrowserResult<unknown>;
    try {
      completion = await quiescence.completion;
    } catch {
      throw storageError("quiesce", "quiescence_failed", true);
    }
    if (!completion.ok) {
      throw storageError(
        "quiesce",
        completion.code === "timeout" ? "quiescence_timeout" : "quiescence_failed",
        true,
      );
    }
  }

  async #revalidateLiveSession(
    pending: BrowserProfilePendingWipe,
    prepared: PreparedWipe,
  ): Promise<void> {
    const session = this.#sessionForPartition(pending.partition, "revalidate");
    if (session !== prepared.session || !this.#sessionIsPersistent(session, "revalidate")) {
      throw storageError("revalidate", "path_changed", false);
    }
    if (this.#sessionStoragePath(session, "revalidate") !== pending.storagePath) {
      throw storageError("revalidate", "path_changed", false);
    }
    const roots = await this.#readAndValidateCurrentRoots("revalidate", {
      userDataPath: pending.userDataPath,
      sessionDataPath: pending.sessionDataPath,
    });
    if (
      !sameIdentity(roots.userData, prepared.roots.userData) ||
      !sameIdentity(roots.sessionData, prepared.roots.sessionData)
    ) {
      throw storageError("revalidate", "root_changed", false);
    }
    const storage = await this.#validateExistingAncestorPrefix(
      roots.sessionData.path,
      pending.storagePath,
      "revalidate",
    );
    if (
      (storage === undefined) !== (prepared.storage === undefined) ||
      (storage !== undefined &&
        prepared.storage !== undefined &&
        !sameIdentity(storage, prepared.storage))
    ) {
      throw storageError("revalidate", "path_changed", false);
    }
  }

  async #clearLiveSession(session: BrowserProfileStorageSession): Promise<void> {
    await this.#runClearBarrier("flush", () => session.flushStorageData());
    await this.#runClearBarrier("connections", () => session.closeAllConnections());
    await this.#runClearBarrier("browser_data", () => session.clearData());
    await this.#runClearBarrier("auth_cache", () => session.clearAuthCache());
    await this.#runClearBarrier("http_cache", () => session.clearCache());
  }

  async #runClearBarrier(
    stage: Extract<
      BrowserProfileStorageStage,
      "flush" | "connections" | "browser_data" | "auth_cache" | "http_cache"
    >,
    operation: () => void | Promise<void>,
  ): Promise<void> {
    try {
      await operation();
    } catch {
      throw storageError(stage, "storage_clear_failed", true);
    }
  }

  #beginOrRetainBlock(pending: BrowserProfilePendingWipe): BrowserProfileBlock | undefined {
    const retained = this.#retainedBlock;
    if (retained !== undefined) {
      if (
        retained.wipeId !== pending.wipeId ||
        retained.profileId !== pending.profileId ||
        this.#profileGate.disposition(pending.profileId) !== "quiescing"
      ) {
        throw storageError("cold_validate", "gate_blocked", false);
      }
      return retained.block;
    }
    const disposition = this.#profileGate.disposition(pending.profileId);
    if (disposition === "deleted") return undefined;
    if (disposition !== "open") {
      throw storageError("cold_validate", "gate_blocked", true);
    }
    const begun = this.#profileGate.begin(pending.profileId);
    if (!begun.ok) throw storageError("cold_validate", "gate_blocked", true);
    this.#retainedBlock = Object.freeze({
      wipeId: pending.wipeId,
      profileId: pending.profileId,
      block: begun.data,
    });
    return begun.data;
  }

  async #optionalLstat(
    path: string,
    stage: BrowserProfileStorageStage,
  ): Promise<Stats | undefined> {
    try {
      return await this.#fileSystem.lstat(path);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return undefined;
      throw storageError(stage, "filesystem_failed", true);
    }
  }

  async #optionalDirectory(
    path: string,
    stage: BrowserProfileStorageStage,
  ): Promise<DirectoryIdentity | undefined> {
    const info = await this.#optionalLstat(path, stage);
    if (info === undefined) return undefined;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw storageError(stage, "unsafe_path", false);
    }
    return this.#validateDirectory(path, stage);
  }

  async #runAfterRenameFailpoint(pending: BrowserProfilePendingWipe): Promise<void> {
    const failpoint = this.#failpoints.afterQuarantineRename;
    if (failpoint === undefined) return;
    try {
      await failpoint({ wipeId: pending.wipeId, profileId: pending.profileId });
    } catch {
      throw storageError("quarantine", "failpoint", true);
    }
  }

  async #syncDirectory(
    identity: DirectoryIdentity,
    stage: BrowserProfileStorageStage,
  ): Promise<void> {
    const before = await this.#validateDirectory(identity.path, stage);
    if (!sameIdentity(identity, before)) {
      throw storageError(stage, "path_changed", false);
    }
    try {
      await this.#fileSystem.syncDirectory(identity.path, identity);
    } catch {
      throw storageError(stage, "filesystem_failed", true);
    }
    const after = await this.#validateDirectory(identity.path, stage);
    if (!sameIdentity(identity, after)) {
      throw storageError(stage, "path_changed", false);
    }
  }

  async #removeTreeNoFollow(
    path: string,
    depth: number,
    budget: DeleteBudget,
    expectedIdentity?: DirectoryIdentity,
  ): Promise<void> {
    if (depth > MAX_DELETE_DEPTH) {
      throw storageError("delete", "delete_limit", false);
    }
    const before = await this.#optionalLstat(path, "delete");
    if (before === undefined) return;
    const uid = currentUid();
    if (uid !== undefined && before.uid !== uid) {
      throw storageError("delete", "unsafe_path", false);
    }
    if (!before.isDirectory() || before.isSymbolicLink()) {
      try {
        await this.#fileSystem.unlink(path);
        return;
      } catch {
        throw storageError("delete", "filesystem_failed", true);
      }
    }

    const identity = identityFromStats(path, before);
    if (expectedIdentity !== undefined && !sameIdentity(expectedIdentity, identity)) {
      throw storageError("delete", "path_changed", false);
    }

    let directory: BrowserProfileStorageDirectory;
    try {
      directory = await this.#fileSystem.opendir(path);
    } catch {
      throw storageError("delete", "filesystem_failed", true);
    }
    try {
      let afterOpen: Stats;
      try {
        afterOpen = await this.#fileSystem.lstat(path);
      } catch {
        throw storageError("delete", "filesystem_failed", true);
      }
      if (
        afterOpen.isSymbolicLink() ||
        !afterOpen.isDirectory() ||
        !sameIdentity(identity, identityFromStats(path, afterOpen))
      ) {
        throw storageError("delete", "path_changed", false);
      }
      for await (const entry of directory) {
        budget.entries += 1;
        if (budget.entries > MAX_DELETE_ENTRIES) {
          throw storageError("delete", "delete_limit", false);
        }
        if (entry.name === "." || entry.name === ".." || entry.name.includes(sep)) {
          throw storageError("delete", "unsafe_path", false);
        }
        const child = join(path, entry.name);
        if (dirname(child) !== path) throw storageError("delete", "unsafe_path", false);
        await this.#removeTreeNoFollow(child, depth + 1, budget);
      }
    } catch (error) {
      if (error instanceof BrowserProfileStorageError) throw error;
      throw storageError("delete", "filesystem_failed", true);
    } finally {
      await directory.close().catch(() => undefined);
    }

    const beforeRemove = await this.#optionalLstat(path, "delete");
    if (
      beforeRemove === undefined ||
      beforeRemove.isSymbolicLink() ||
      !beforeRemove.isDirectory() ||
      !sameIdentity(identity, identityFromStats(path, beforeRemove))
    ) {
      throw storageError("delete", "path_changed", false);
    }
    try {
      await this.#fileSystem.rmdir(path);
    } catch {
      throw storageError("delete", "filesystem_failed", true);
    }
  }
}

export const makeBrowserProfileStorageLifecycle = (
  dependencies: BrowserProfileStorageDependencies,
): BrowserProfileWipeLifecycle => new BrowserProfileStorageLifecycle(dependencies);
