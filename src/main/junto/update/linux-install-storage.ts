/**
 * Owner-local Linux desktop install storage: provenance, leases, classification,
 * sealed retirement, disk admission, and read-only Doctor observations.
 *
 * Activation still does not retire generations. Collection is post-readiness
 * and never accepts a caller path, glob, or retention count.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, statfs } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { ServiceCheck } from "@shared/contracts";
import {
  LINUX_DESKTOP_MAX_ARCHIVE_BYTES,
  LINUX_DESKTOP_MAX_EXPANDED_BYTES,
  LINUX_DESKTOP_INSTALL_RESERVE_BYTES,
} from "../../../shared/linux-desktop-release";

export const LINUX_DESKTOP_GENERATION_NAME =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-[a-f0-9]{64}$/u;
export const LINUX_INSTALL_STORAGE_DIR = ".install-storage";
const ALLOCATION_SCHEMA = "junto/linux-install-allocation/v1";
const ATTEMPT_PREFIX = ".stage-";
const QUARANTINE_PREFIX = ".quarantine-";
const MAX_RECORD_BYTES = 1_048_576;
const MAX_WALK_ENTRIES = 100_000;

const ROOT: unique symbol = Symbol("OwnedLinuxInstallRoot");
const TREE: unique symbol = Symbol("RetirableLinuxInstallTree");
const READY: unique symbol = Symbol("LinuxDesktopInstallReadiness");
const MUTATION: unique symbol = Symbol("LinuxInstallMutationLease");

export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface OwnedLinuxInstallRoot {
  readonly [ROOT]: true;
  readonly home: string;
  readonly rootPath: string;
  readonly identity: FileIdentity;
}

export interface RetirableLinuxInstallTree {
  readonly [TREE]: true;
  readonly path: string;
  readonly basename: string;
}

export interface LinuxDesktopInstallReadiness {
  readonly [READY]: true;
  readonly executablePath: string;
  readonly generationBasename: string;
}

export interface LinuxInstallMutationLease {
  readonly [MUTATION]: true;
}

export type LinuxInstallScanState = "complete" | "busy" | "partial" | "unavailable";

export interface LinuxInstallStorageObservation {
  readonly policy: "active-plus-live-candidate";
  readonly scanState: LinuxInstallScanState;
  readonly managedGenerationCount: number;
  readonly managedAllocatedBytes: number;
  readonly protectedAllocatedBytes: number;
  readonly eligibleAllocatedBytes: number;
  readonly quarantineAllocatedBytes: number;
  readonly legacyGenerationCount: number;
  readonly unprovenStageCount: number;
  readonly deferredInUseCount: number;
  readonly unrecognizedCount: number;
  readonly availableBytes: number | undefined;
  readonly requiredStageBytes: number;
  readonly reserveBytes: number;
  readonly lastCollectionAt: string | undefined;
  readonly lastCollectionOutcome: string | undefined;
}

export interface LinuxInstallCollectionResult {
  readonly retiredBasenames: readonly string[];
  readonly deferredBasenames: readonly string[];
  readonly reportedLegacyBasenames: readonly string[];
  readonly outcome: "collected" | "deferred" | "report-only" | "unavailable";
}

interface AllocationRecord {
  readonly schema: typeof ALLOCATION_SCHEMA;
  readonly kind: "generation" | "attempt" | "quarantine";
  readonly basename: string;
  readonly operationId: string;
  readonly root: FileIdentity;
  readonly tree: FileIdentity;
  readonly uid: number;
  readonly phase: "allocated" | "admitted" | "retiring";
  readonly version?: string;
  readonly archiveSha256?: string;
}

interface RootAuthority {
  readonly home: string;
  readonly rootPath: string;
  readonly identity: FileIdentity;
}
interface TreeAuthority {
  readonly root: FileIdentity;
  readonly path: string;
  readonly basename: string;
  readonly identity: FileIdentity;
  readonly kind: AllocationRecord["kind"];
}
interface ReadyAuthority {
  readonly executablePath: string;
  readonly generationBasename: string;
  readonly generationIdentity: FileIdentity;
}
interface MutationAuthority {
  readonly root: FileIdentity;
  readonly release: () => Promise<void>;
  released: boolean;
}

const roots = new WeakMap<OwnedLinuxInstallRoot, RootAuthority>();
const trees = new WeakMap<RetirableLinuxInstallTree, TreeAuthority>();
const readiness = new WeakMap<LinuxDesktopInstallReadiness, ReadyAuthority>();
const mutations = new WeakMap<LinuxInstallMutationLease, MutationAuthority>();
const protectedBasenames = new Map<string, Set<string>>();
const liveCandidates = new Map<string, string>();
let heldReadiness: LinuxDesktopInstallReadiness | undefined;
let lastCollectionAt: string | undefined;
let lastCollectionOutcome: string | undefined;

const identity = (stat: Pick<Stats, "dev" | "ino">): FileIdentity => ({ dev: stat.dev, ino: stat.ino });
const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;
const owned = (stat: Stats): boolean => process.getuid === undefined || stat.uid === process.getuid();
const requireOrdinaryUser = (): void => {
  if (process.getuid?.() === 0 || process.geteuid?.() === 0) {
    throw new Error("Linux desktop installation must run as an ordinary user without elevation");
  }
};

export const requireOwnedDirectory = async (path: string): Promise<Stats> => {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) || (stat.mode & 0o022) !== 0) {
    throw new Error("Linux desktop install directory is not owner-controlled");
  }
  return stat;
};

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
};

const requireRoot = (handle: OwnedLinuxInstallRoot): RootAuthority => {
  const authority = roots.get(handle);
  if (authority === undefined) throw new Error("Linux install root was not admitted");
  return authority;
};

const requireMutation = (lease: LinuxInstallMutationLease, root: RootAuthority): MutationAuthority => {
  const authority = mutations.get(lease);
  if (authority === undefined || authority.released) throw new Error("Linux install mutation lease is not held");
  if (!sameIdentity(authority.root, root.identity)) throw new Error("Linux install mutation lease does not match this root");
  return authority;
};

const listenUnix = (server: Server, path: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen({ path, readableAll: false, writableAll: false }, () => {
      server.off("error", onError);
      resolve();
    });
  });

const closeUnix = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    if (!server.listening) { resolve(); return; }
    server.close(() => resolve());
  });

const protectionKey = (root: FileIdentity): string => `${root.dev}:${root.ino}`;
const protectedSet = (root: FileIdentity): Set<string> => {
  const key = protectionKey(root);
  const current = protectedBasenames.get(key);
  if (current !== undefined) return current;
  const created = new Set<string>();
  protectedBasenames.set(key, created);
  return created;
};

export const protectLinuxInstallBasename = (root: OwnedLinuxInstallRoot, name: string): void => {
  protectedSet(requireRoot(root).identity).add(name);
};

export const unprotectLinuxInstallBasename = (root: OwnedLinuxInstallRoot, name: string): void => {
  protectedSet(requireRoot(root).identity).delete(name);
};

export const setLiveLinuxInstallCandidate = (
  root: OwnedLinuxInstallRoot,
  name: string | undefined,
): void => {
  const identity = requireRoot(root).identity;
  const key = protectionKey(identity);
  const previous = liveCandidates.get(key);
  if (previous !== undefined) protectedSet(identity).delete(previous);
  if (name === undefined) liveCandidates.delete(key);
  else liveCandidates.set(key, name);
};

const liveCandidateOf = (root: FileIdentity): string | undefined => liveCandidates.get(protectionKey(root));

export const heldLinuxDesktopInstallReadiness = (): LinuxDesktopInstallReadiness | undefined => heldReadiness;

export const holdLinuxDesktopInstallReadiness = (handle: LinuxDesktopInstallReadiness | undefined): void => {
  if (handle !== undefined && readiness.get(handle) === undefined) {
    throw new Error("Linux desktop install readiness was not admitted");
  }
  heldReadiness = handle;
};

export const mintLinuxDesktopInstallReadiness = (input: {
  readonly executablePath: string;
  readonly generationBasename: string;
  readonly generationIdentity: FileIdentity;
}): LinuxDesktopInstallReadiness => {
  if (!LINUX_DESKTOP_GENERATION_NAME.test(input.generationBasename)) {
    throw new Error("Linux desktop generation identity is invalid");
  }
  const handle = Object.freeze({
    [READY]: true as const,
    executablePath: input.executablePath,
    generationBasename: input.generationBasename,
  });
  readiness.set(handle, {
    executablePath: input.executablePath,
    generationBasename: input.generationBasename,
    generationIdentity: input.generationIdentity,
  });
  return handle;
};

export const admitOwnedLinuxInstallRoot = async (input: {
  readonly home: string;
  readonly rootPath: string;
}): Promise<OwnedLinuxInstallRoot> => {
  requireOrdinaryUser();
  if (!isAbsolute(input.home) || !isAbsolute(input.rootPath) || /[\u0000-\u001f\u007f]/u.test(input.home)) {
    throw new Error("Linux desktop install home must be an absolute safe path");
  }
  const home = await realpath(input.home);
  await requireOwnedDirectory(home);
  const rootStat = await requireOwnedDirectory(input.rootPath);
  const rootPath = await realpath(input.rootPath);
  await requireOwnedDirectory(rootPath);
  if (dirname(rootPath) === rootPath || !rootPath.startsWith(`${home}/`)) {
    throw new Error("Linux desktop install root is outside the admitted home");
  }
  const handle = Object.freeze({
    [ROOT]: true as const,
    home,
    rootPath,
    identity: identity(rootStat),
  });
  roots.set(handle, { home, rootPath, identity: identity(await requireOwnedDirectory(rootPath)) });
  return handle;
};

export const acquireLinuxInstallMutation = async (
  root: OwnedLinuxInstallRoot,
): Promise<LinuxInstallMutationLease> => {
  const authority = requireRoot(root);
  await requireOwnedDirectory(authority.rootPath);
  const current = identity(await requireOwnedDirectory(authority.rootPath));
  if (!sameIdentity(current, authority.identity)) throw new Error("Linux desktop install root changed filesystem identity");
  if (process.platform !== "linux") throw new Error("Linux install mutation leases are Linux-only");
  const server = createServer((socket) => socket.destroy());
  const abstractPath = `\0junto-linux-install-${createHash("sha256").update(`${current.dev}:${current.ino}`).digest("hex")}`;
  try {
    await listenUnix(server, abstractPath);
  } catch (cause) {
    throw new Error("Linux install mutation lease unavailable", { cause });
  }
  server.unref();
  server.on("error", () => undefined);
  const lease = Object.freeze({ [MUTATION]: true as const });
  let releaseFlight: Promise<void> | undefined;
  mutations.set(lease, {
    root: current,
    released: false,
    release: () => {
      releaseFlight ??= closeUnix(server);
      return releaseFlight;
    },
  });
  return lease;
};

export const releaseLinuxInstallMutation = async (lease: LinuxInstallMutationLease): Promise<void> => {
  const authority = mutations.get(lease);
  if (authority === undefined) throw new Error("invalid Linux install mutation lease");
  if (authority.released) return;
  await authority.release();
  authority.released = true;
};

const storageDir = (rootPath: string): string => join(rootPath, LINUX_INSTALL_STORAGE_DIR);
const allocationPath = (rootPath: string, name: string): string =>
  join(storageDir(rootPath), "allocations", `${name}.json`);

const ensureStorageDir = async (root: RootAuthority): Promise<void> => {
  const directory = storageDir(root.rootPath);
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await requireOwnedDirectory(directory);
  const allocations = join(directory, "allocations");
  await mkdir(allocations, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await requireOwnedDirectory(allocations);
};

const writeAllocation = async (root: RootAuthority, record: AllocationRecord): Promise<void> => {
  await ensureStorageDir(root);
  const path = allocationPath(root.rootPath, record.basename);
  const body = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(body) > MAX_RECORD_BYTES) throw new Error("Linux install allocation record exceeds its byte limit");
  const temporary = `${path}.${record.operationId}.tmp`;
  const file = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(body, "utf8");
    await file.chmod(0o600);
    await file.sync();
  } finally { await file.close(); }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
};

const readAllocation = async (root: RootAuthority, name: string): Promise<AllocationRecord | undefined> => {
  const path = allocationPath(root.rootPath, name);
  const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (file === undefined) return undefined;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !owned(stat) || (stat.mode & 0o022) !== 0 || stat.size > MAX_RECORD_BYTES) {
      throw new Error("Linux install allocation record is not an owned regular file");
    }
    const raw: unknown = JSON.parse(await file.readFile("utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const record = raw as AllocationRecord;
    if (
      record.schema !== ALLOCATION_SCHEMA ||
      (record.kind !== "generation" && record.kind !== "attempt" && record.kind !== "quarantine") ||
      record.basename !== name ||
      typeof record.operationId !== "string" ||
      typeof record.tree?.dev !== "number" ||
      typeof record.tree?.ino !== "number" ||
      (record.phase !== "allocated" && record.phase !== "admitted" && record.phase !== "retiring")
    ) return undefined;
    if (!sameIdentity(record.root, root.identity)) return undefined;
    return record;
  } finally { await file.close(); }
};

const removeAllocation = async (root: RootAuthority, name: string): Promise<void> => {
  await rm(allocationPath(root.rootPath, name), { force: true });
};

export const persistLinuxInstallAllocation = async (input: {
  readonly root: OwnedLinuxInstallRoot;
  readonly lease: LinuxInstallMutationLease;
  readonly path: string;
  readonly kind: AllocationRecord["kind"];
  readonly phase: AllocationRecord["phase"];
  readonly version?: string;
  readonly archiveSha256?: string;
}): Promise<RetirableLinuxInstallTree> => {
  const root = requireRoot(input.root);
  requireMutation(input.lease, root);
  const name = basename(input.path);
  if (dirname(input.path) !== root.rootPath) throw new Error("Linux install allocation must be a direct child of the install root");
  if (input.kind === "generation" && !LINUX_DESKTOP_GENERATION_NAME.test(name)) {
    throw new Error("Linux desktop generation identity is invalid");
  }
  if (input.kind === "attempt" && !name.startsWith(ATTEMPT_PREFIX)) {
    throw new Error("Linux desktop install attempt identity is invalid");
  }
  const stat = await requireOwnedDirectory(input.path);
  if (stat.dev !== (await requireOwnedDirectory(root.rootPath)).dev) {
    throw new Error("Linux install allocation crossed a filesystem boundary");
  }
  const record: AllocationRecord = {
    schema: ALLOCATION_SCHEMA,
    kind: input.kind,
    basename: name,
    operationId: randomUUID(),
    root: root.identity,
    tree: identity(stat),
    uid: stat.uid,
    phase: input.phase,
    ...(input.version === undefined ? {} : { version: input.version }),
    ...(input.archiveSha256 === undefined ? {} : { archiveSha256: input.archiveSha256 }),
  };
  await writeAllocation(root, record);
  await syncDirectory(root.rootPath);
  const handle = Object.freeze({ [TREE]: true as const, path: input.path, basename: name });
  trees.set(handle, { root: root.identity, path: input.path, basename: name, identity: record.tree, kind: input.kind });
  return handle;
};

const walkAllocatedBytes = async (path: string, expectedDev: number): Promise<number> => {
  let total = 0;
  let seen = 0;
  const visit = async (current: string): Promise<void> => {
    const stat = await lstat(current);
    if (stat.dev !== expectedDev) throw new Error("Linux install tree crossed a filesystem boundary");
    if (stat.isSymbolicLink()) throw new Error("Linux desktop generation contains a link or special file");
    seen += 1;
    if (seen > MAX_WALK_ENTRIES) throw new Error("Linux install tree exceeds member limits");
    if (stat.isDirectory()) {
      for (const name of await readdir(current)) await visit(join(current, name));
      return;
    }
    if (!stat.isFile() || !owned(stat) || stat.nlink !== 1) throw new Error("Linux desktop generation contains an unsafe file");
    total += stat.size;
  };
  await visit(path);
  return total;
};

const generationInUse = async (generationPath: string): Promise<"free" | "used" | "unknown"> => {
  try {
    await readdir("/proc");
  } catch {
    return "unknown";
  }
  let unknown = false;
  const prefix = `${generationPath}/`;
  try {
    const names = await readdir("/proc");
    for (const name of names) {
      if (!/^[0-9]+$/u.test(name)) continue;
      try {
        const exe = await realpath(`/proc/${name}/exe`);
        if (exe === join(generationPath, "junto") || exe.startsWith(prefix)) return "used";
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EACCES" || code === "EPERM") continue;
        unknown = true;
      }
    }
  } catch {
    return "unknown";
  }
  return unknown ? "unknown" : "free";
};

export const retireLinuxInstallTree = async (input: {
  readonly root: OwnedLinuxInstallRoot;
  readonly lease: LinuxInstallMutationLease;
  readonly tree: RetirableLinuxInstallTree;
}): Promise<void> => {
  const root = requireRoot(input.root);
  requireMutation(input.lease, root);
  const tree = trees.get(input.tree);
  if (tree === undefined) throw new Error("Linux install tree was not minted for retirement");
  if (!sameIdentity(tree.root, root.identity)) throw new Error("Linux install tree does not belong to this root");
  const stat = await requireOwnedDirectory(tree.path);
  if (!sameIdentity(identity(stat), tree.identity)) throw new Error("Linux desktop install attempt changed filesystem identity");
  if (dirname(tree.path) !== root.rootPath) throw new Error("Linux install retirement target left the install root");
  await walkAllocatedBytes(tree.path, stat.dev);
  const operationId = randomUUID();
  const quarantine = join(root.rootPath, `${QUARANTINE_PREFIX}${operationId}`);
  await mkdir(quarantine, { mode: 0o700 });
  const quarantineIdentity = identity(await requireOwnedDirectory(quarantine));
  await writeAllocation(root, {
    schema: ALLOCATION_SCHEMA,
    kind: "quarantine",
    basename: basename(quarantine),
    operationId,
    root: root.identity,
    tree: quarantineIdentity,
    uid: (await requireOwnedDirectory(quarantine)).uid,
    phase: "retiring",
  });
  const payload = join(quarantine, "payload");
  await rename(tree.path, payload);
  await syncDirectory(root.rootPath);
  await syncDirectory(quarantine);
  const moved = await requireOwnedDirectory(payload);
  if (!sameIdentity(identity(moved), tree.identity)) throw new Error("Linux install quarantine changed filesystem identity");
  await rm(payload, { recursive: true, force: false });
  await rm(quarantine, { recursive: true, force: false });
  await removeAllocation(root, tree.basename);
  await removeAllocation(root, basename(quarantine));
  await syncDirectory(root.rootPath);
};

export const requiredLinuxInstallStageBytes = (archiveBytes: number): number => {
  if (!Number.isSafeInteger(archiveBytes) || archiveBytes < 0 || archiveBytes > LINUX_DESKTOP_MAX_ARCHIVE_BYTES) {
    throw new Error("Linux desktop archive size is outside the supported bound");
  }
  return LINUX_DESKTOP_MAX_EXPANDED_BYTES + archiveBytes + LINUX_DESKTOP_INSTALL_RESERVE_BYTES;
};

export type LinuxInstallSpaceObservation = {
  readonly bavail: bigint;
  readonly bsize: bigint;
};

export const observeAvailableBytes = async (
  path: string,
  observe: (path: string, options: { readonly bigint: true }) => Promise<LinuxInstallSpaceObservation> = statfs,
): Promise<number | undefined> => {
  try {
    const info = await observe(path, { bigint: true });
    const available = info.bavail * info.bsize;
    if (available < 0n || available > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    return Number(available);
  } catch {
    return undefined;
  }
};

export const assertLinuxInstallDiskAdmission = async (input: {
  readonly path: string;
  readonly archiveBytes: number;
  readonly observe?: (path: string, options: { readonly bigint: true }) => Promise<LinuxInstallSpaceObservation>;
}): Promise<void> => {
  const required = requiredLinuxInstallStageBytes(input.archiveBytes);
  const available = await observeAvailableBytes(input.path, input.observe ?? statfs);
  if (available === undefined) throw new Error("Linux desktop install disk space could not be observed");
  if (available < required) {
    throw new Error("Linux desktop install requires additional free disk space before expansion");
  }
};

export const collectLinuxInstallStorage = async (input: {
  readonly root: OwnedLinuxInstallRoot;
  readonly lease: LinuxInstallMutationLease;
  readonly activeBasename: string | undefined;
  readonly currentExecutablePath: string | undefined;
  readonly readiness?: LinuxDesktopInstallReadiness;
}): Promise<LinuxInstallCollectionResult> => {
  const root = requireRoot(input.root);
  requireMutation(input.lease, root);
  const currentRoot = identity(await requireOwnedDirectory(root.rootPath));
  if (!sameIdentity(currentRoot, root.identity)) throw new Error("Linux desktop install root changed filesystem identity");
  const ready = input.readiness ?? heldReadiness;
  const readyAuthority = ready === undefined ? undefined : readiness.get(ready);
  if (ready !== undefined && readyAuthority === undefined) throw new Error("Linux desktop install readiness was not admitted");
  const protectedNames = protectedSet(root.identity);
  const liveCandidate = liveCandidateOf(root.identity);
  const retired: string[] = [];
  const deferred: string[] = [];
  const legacy: string[] = [];
  const names = await readdir(root.rootPath);
  for (const name of names.sort()) {
    if (name === LINUX_INSTALL_STORAGE_DIR) continue;
    const path = join(root.rootPath, name);
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stat === undefined) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    const record = await readAllocation(root, name);
    const isGeneration = LINUX_DESKTOP_GENERATION_NAME.test(name);
    const isAttempt = name.startsWith(ATTEMPT_PREFIX);
    const isQuarantine = name.startsWith(QUARANTINE_PREFIX);
    if (name === input.activeBasename || name === liveCandidate || protectedNames.has(name)) continue;
    if (input.currentExecutablePath !== undefined && path === dirname(input.currentExecutablePath)) continue;
    if (readyAuthority !== undefined && name === readyAuthority.generationBasename) continue;
    if (record === undefined) {
      if (isGeneration || isAttempt) legacy.push(name);
      continue;
    }
    if (!sameIdentity(record.tree, identity(stat))) {
      legacy.push(name);
      continue;
    }
    if (isQuarantine && record.kind === "quarantine") {
      const payload = join(path, "payload");
      const payloadStat = await lstat(payload).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (payloadStat !== undefined) {
        await requireOwnedDirectory(payload);
        await rm(payload, { recursive: true, force: false });
      }
      await requireOwnedDirectory(path);
      await rm(path, { recursive: true, force: false });
      await removeAllocation(root, name);
      retired.push(name);
      continue;
    }
    const historical = isGeneration && record.kind === "generation" && record.phase === "admitted";
    const abandoned = (isAttempt && record.kind === "attempt") || (isGeneration && record.phase === "allocated");
    if (historical && readyAuthority === undefined) continue;
    if (!historical && !abandoned) {
      legacy.push(name);
      continue;
    }
    if (historical) {
      const use = await generationInUse(path);
      if (use !== "free") {
        deferred.push(name);
        continue;
      }
    }
    const handle = Object.freeze({ [TREE]: true as const, path, basename: name });
    trees.set(handle, { root: root.identity, path, basename: name, identity: record.tree, kind: record.kind });
    await retireLinuxInstallTree({ root: input.root, lease: input.lease, tree: handle });
    retired.push(name);
  }
  lastCollectionAt = new Date().toISOString();
  lastCollectionOutcome = retired.length > 0 ? "collected" : deferred.length > 0 ? "deferred" : "report-only";
  return {
    retiredBasenames: retired,
    deferredBasenames: deferred,
    reportedLegacyBasenames: legacy,
    outcome: retired.length > 0 ? "collected" : deferred.length > 0 ? "deferred" : "report-only",
  };
};

export const observeLinuxInstallStorage = async (input: {
  readonly root: OwnedLinuxInstallRoot;
  readonly activeBasename: string | undefined;
  readonly currentExecutablePath: string | undefined;
  readonly archiveBytes?: number;
}): Promise<LinuxInstallStorageObservation> => {
  const root = requireRoot(input.root);
  let managedGenerationCount = 0;
  let managedAllocatedBytes = 0;
  let protectedAllocatedBytes = 0;
  let eligibleAllocatedBytes = 0;
  let quarantineAllocatedBytes = 0;
  let legacyGenerationCount = 0;
  let unprovenStageCount = 0;
  let deferredInUseCount = 0;
  let unrecognizedCount = 0;
  const protectedNames = protectedSet(root.identity);
  const liveCandidate = liveCandidateOf(root.identity);
  const readyAuthority = heldReadiness === undefined ? undefined : readiness.get(heldReadiness);
  let scanState: LinuxInstallScanState = "complete";
  try {
    const names = await readdir(root.rootPath);
    for (const name of names) {
      if (name === LINUX_INSTALL_STORAGE_DIR) continue;
      const path = join(root.rootPath, name);
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        unrecognizedCount += 1;
        continue;
      }
      const record = await readAllocation(root, name);
      const bytes = await walkAllocatedBytes(path, stat.dev).catch(() => undefined);
      if (bytes === undefined) {
        scanState = "partial";
        unrecognizedCount += 1;
        continue;
      }
      if (LINUX_DESKTOP_GENERATION_NAME.test(name)) {
        managedGenerationCount += 1;
        managedAllocatedBytes += bytes;
        const protectedTree =
          name === input.activeBasename ||
          name === liveCandidate ||
          protectedNames.has(name) ||
          (input.currentExecutablePath !== undefined && path === dirname(input.currentExecutablePath)) ||
          (readyAuthority !== undefined && name === readyAuthority.generationBasename);
        if (protectedTree) protectedAllocatedBytes += bytes;
        else if (record === undefined || !sameIdentity(record.tree, identity(stat))) legacyGenerationCount += 1;
        else if (record.phase === "admitted") {
          const use = await generationInUse(path);
          if (use === "free" && readyAuthority !== undefined) eligibleAllocatedBytes += bytes;
          else {
            deferredInUseCount += 1;
            if (use === "unknown") scanState = "partial";
          }
        }
      } else if (name.startsWith(ATTEMPT_PREFIX)) {
        if (record === undefined) unprovenStageCount += 1;
        else eligibleAllocatedBytes += bytes;
      } else if (name.startsWith(QUARANTINE_PREFIX)) {
        quarantineAllocatedBytes += bytes;
      } else unrecognizedCount += 1;
    }
  } catch {
    scanState = "unavailable";
  }
  const availableBytes = await observeAvailableBytes(root.rootPath);
  return {
    policy: "active-plus-live-candidate",
    scanState,
    managedGenerationCount,
    managedAllocatedBytes,
    protectedAllocatedBytes,
    eligibleAllocatedBytes,
    quarantineAllocatedBytes,
    legacyGenerationCount,
    unprovenStageCount,
    deferredInUseCount,
    unrecognizedCount,
    availableBytes,
    requiredStageBytes: requiredLinuxInstallStageBytes(input.archiveBytes ?? LINUX_DESKTOP_MAX_ARCHIVE_BYTES),
    reserveBytes: LINUX_DESKTOP_INSTALL_RESERVE_BYTES,
    lastCollectionAt,
    lastCollectionOutcome,
  };
};

export const linuxInstallStorageDoctorCheck = (
  observation: LinuxInstallStorageObservation | undefined,
  error?: string,
): ServiceCheck => {
  if (observation === undefined) {
    return {
      id: "linux-install-storage",
      label: "Linux install storage",
      status: "unknown",
      detail: error ?? "Linux managed install storage could not be observed.",
    };
  }
  const backlog =
    observation.legacyGenerationCount +
    observation.unprovenStageCount +
    observation.deferredInUseCount +
    observation.eligibleAllocatedBytes;
  const spaceWarning =
    observation.availableBytes !== undefined &&
    observation.availableBytes < observation.requiredStageBytes;
  const status =
    observation.scanState === "unavailable" ? "unknown" as const
    : observation.unrecognizedCount > 0 && observation.scanState === "partial" && backlog === 0 ? "warning" as const
    : spaceWarning || backlog > 0 || observation.legacyGenerationCount > 0 || observation.unprovenStageCount > 0 ? "warning" as const
    : "ok" as const;
  const detail =
    status === "ok"
      ? "Managed Linux generations are bounded to the active generation and live staged candidate."
      : spaceWarning
        ? "Home disk space is below the next Linux desktop expansion reserve."
        : "Linux managed generations include deferred, legacy, or unproven entries.";
  return {
    id: "linux-install-storage",
    label: "Linux install storage",
    status,
    detail,
    metadata: {
      policy: observation.policy,
      scanState: observation.scanState,
      managedGenerationCount: String(observation.managedGenerationCount),
      managedAllocatedBytes: String(observation.managedAllocatedBytes),
      protectedAllocatedBytes: String(observation.protectedAllocatedBytes),
      eligibleAllocatedBytes: String(observation.eligibleAllocatedBytes),
      quarantineAllocatedBytes: String(observation.quarantineAllocatedBytes),
      legacyGenerationCount: String(observation.legacyGenerationCount),
      unprovenStageCount: String(observation.unprovenStageCount),
      deferredInUseCount: String(observation.deferredInUseCount),
      unrecognizedCount: String(observation.unrecognizedCount),
      availableBytes: observation.availableBytes === undefined ? "unknown" : String(observation.availableBytes),
      requiredStageBytes: String(observation.requiredStageBytes),
      reserveBytes: String(observation.reserveBytes),
      lastCollectionAt: observation.lastCollectionAt ?? "never",
      lastCollectionOutcome: observation.lastCollectionOutcome ?? "none",
    },
  };
};
