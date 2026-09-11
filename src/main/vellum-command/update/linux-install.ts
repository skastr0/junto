import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { assertVerifiedLinuxDesktopRelease, type VerifiedLinuxDesktopRelease } from "../../../shared/linux-desktop-release-crypto";
import { compareLinuxDesktopVersions } from "../../../shared/linux-desktop-release";
import { extractLinuxDesktopArchive } from "./linux-install-archive";
import {
  acquireLinuxInstallMutation,
  admitOwnedLinuxInstallRoot,
  assertLinuxInstallDiskAdmission,
  collectLinuxInstallStorage,
  heldLinuxDesktopInstallReadiness,
  holdLinuxDesktopInstallReadiness,
  linuxInstallStorageDoctorCheck,
  mintLinuxDesktopInstallReadiness,
  observeLinuxInstallStorage,
  persistLinuxInstallAllocation,
  protectLinuxInstallBasename,
  releaseLinuxInstallMutation,
  retireLinuxInstallTree,
  setLiveLinuxInstallCandidate,
  unprotectLinuxInstallBasename,
  LINUX_DESKTOP_GENERATION_NAME,
  type OwnedLinuxInstallRoot,
} from "./linux-install-storage";
import { admitPackagedUpdateIdentity } from "./package-update-identity";

const RELEASE_NAME = LINUX_DESKTOP_GENERATION_NAME;
const MANAGED_LAUNCHER = "# Vellum Command managed Linux desktop launcher";
const STAGED: unique symbol = Symbol("StagedLinuxDesktopRelease");

export interface StagedLinuxDesktopRelease {
  readonly [STAGED]: true;
  readonly executablePath: string;
  readonly generationPath: string;
  readonly archiveSha256: string;
}

export type LinuxDesktopActivationOptions =
  | { readonly mode: "first-install" }
  | { readonly mode: "update"; readonly expectedIncumbentExecutablePath: string };

export class LinuxDesktopActivationError extends Error {
  readonly activated: boolean;
  constructor(message: string, activated: boolean, cause?: unknown) {
    super(message, { cause });
    this.name = "LinuxDesktopActivationError";
    this.activated = activated;
  }
}

interface FileIdentity { readonly dev: number; readonly ino: number; }
interface InventoryEntry {
  readonly kind: "directory" | "file";
  readonly mode: number;
  readonly bytes: number;
  readonly sha256?: string;
}
interface LauncherSnapshot extends FileIdentity {
  readonly body: string;
  readonly executablePath: string;
}
interface StagedAuthority {
  readonly home: string;
  readonly root: string;
  readonly ownedRoot: OwnedLinuxInstallRoot;
  readonly generation: FileIdentity;
  readonly inventory: ReadonlyMap<string, InventoryEntry>;
  readonly incumbent: LauncherSnapshot | undefined;
  readonly version: string;
  activated: boolean;
}
const stagedReleases = new WeakMap<StagedLinuxDesktopRelease, StagedAuthority>();

const identity = (stat: Pick<Stats, "dev" | "ino">): FileIdentity => ({ dev: stat.dev, ino: stat.ino });
const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean => left.dev === right.dev && left.ino === right.ino;
const owned = (stat: Stats): boolean => process.getuid === undefined || stat.uid === process.getuid();
const generationBasename = (path: string): string => basename(path);
const shellLiteral = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;
const requireOrdinaryUser = (): void => {
  if (process.getuid?.() === 0 || process.geteuid?.() === 0) throw new Error("Linux desktop installation must run as an ordinary user without elevation");
};

const requireOwnedDirectory = async (path: string): Promise<Stats> => {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) || (stat.mode & 0o022) !== 0) {
    throw new Error("Linux desktop install directory is not owner-controlled");
  }
  return stat;
};

const ensureOwnedDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await requireOwnedDirectory(path);
};

const resolveInstallHome = async (home: string): Promise<string> => {
  if (!isAbsolute(home) || /[\u0000-\u001f\u007f]/u.test(home)) throw new Error("Linux desktop install home must be an absolute safe path");
  await requireOwnedDirectory(home);
  const canonical = await realpath(home);
  await requireOwnedDirectory(canonical);
  return canonical;
};

const ensureInstallLayout = async (home: string): Promise<string> => {
  for (const relative of [".local", ".local/opt", ".local/opt/vellum-command-alpha", ".local/bin", ".local/share", ".local/share/applications"]) {
    await ensureOwnedDirectory(join(home, relative));
  }
  return join(home, ".local/opt/vellum-command-alpha");
};

const requireInstallLayout = async (authority: StagedAuthority): Promise<void> => {
  for (const relative of ["", ".local", ".local/opt", ".local/opt/vellum-command-alpha", ".local/bin", ".local/share", ".local/share/applications"]) {
    await requireOwnedDirectory(join(authority.home, relative));
  }
};

const launcherBody = (root: string, generation: string): string =>
  `#!/bin/sh\n${MANAGED_LAUNCHER}\n# generation: ${generation}\nexec ${shellLiteral(join(root, generation, "vellum-command"))} "$@"\n`;

const launcherPath = (home: string): string => join(home, ".local/bin/vellum-command-desktop");
const desktopPath = (home: string): string => join(home, ".local/share/applications/vellum-command.desktop");
const desktopBody = (home: string): string => {
  const executable = launcherPath(home).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("`", "\\`").replaceAll("$", "\\$").replaceAll("%", "%%");
  return `[Desktop Entry]\nType=Application\nName=Vellum Command\nComment=Vellum Command desktop\nExec="${executable}" %U\nTerminal=false\nCategories=Development;\nStartupWMClass=vellum-command\n`;
};

const readOwnedFile = async (path: string): Promise<{ readonly body: string; readonly stat: Stats } | undefined> => {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (handle === undefined) return undefined;
  try {
    const stat = await handle.stat();
    // Atomic replacement changes this directory entry, never the incumbent
    // inode. Extra links can remain after an interrupted create-only publish.
    if (!stat.isFile() || !owned(stat) || (stat.mode & 0o022) !== 0 || stat.size > 16_384) {
      throw new Error("Linux desktop activation file is not an owned regular file");
    }
    return { body: await handle.readFile("utf8"), stat };
  } finally { await handle.close(); }
};

const readManagedLauncher = async (home: string, root: string): Promise<LauncherSnapshot | undefined> => {
  const file = await readOwnedFile(launcherPath(home));
  if (file === undefined) return undefined;
  const generation = file.body.split("\n")[2]?.replace(/^# generation: /u, "");
  if (generation === undefined || !RELEASE_NAME.test(generation) || file.body !== launcherBody(root, generation) || (file.stat.mode & 0o111) === 0) {
    throw new Error("Refusing to replace an unrelated Linux desktop launcher");
  }
  return { ...identity(file.stat), body: file.body, executablePath: join(root, generation, "vellum-command") };
};

const requireManagedDesktop = async (home: string): Promise<void> => {
  const current = await readOwnedFile(desktopPath(home));
  if (current !== undefined && current.body !== desktopBody(home)) {
    throw new Error("Refusing to replace an unrelated desktop entry");
  }
};

const exists = async (path: string): Promise<boolean> => {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
};

/** Create-only CLI precheck: inspect existing paths without making directories. */
export const assertLinuxDesktopFirstInstallAvailable = async (input: { readonly home?: string } = {}): Promise<void> => {
  requireOrdinaryUser();
  const home = await resolveInstallHome(input.home ?? homedir());
  for (const relative of [".local", ".local/opt", ".local/opt/vellum-command-alpha", ".local/bin", ".local/share", ".local/share/applications"]) {
    const path = join(home, relative);
    if (await exists(path)) await requireOwnedDirectory(path);
  }
  if (await exists(launcherPath(home))) throw new Error("First install refuses an existing desktop launcher");
  // A crash can leave the exact prepared desktop entry before the launcher
  // commit. Reuse that owned inert entry; never replace foreign content.
  await requireManagedDesktop(home);
};

/** Read-only eligibility check, safe before network access or runtime quiesce. */
export const assertLinuxDesktopManagedIncumbent = async (input: { readonly home?: string; readonly executablePath: string }): Promise<void> => {
  requireOrdinaryUser();
  const home = await resolveInstallHome(input.home ?? homedir());
  for (const relative of [".local", ".local/opt", ".local/opt/vellum-command-alpha", ".local/bin"]) await requireOwnedDirectory(join(home, relative));
  const root = join(home, ".local/opt/vellum-command-alpha");
  const incumbent = await readManagedLauncher(home, root);
  if (incumbent === undefined || incumbent.executablePath !== input.executablePath) throw new Error("Linux desktop updater requires the exact managed running generation");
  await requireOwnedDirectory(dirname(incumbent.executablePath));
  const executable = await lstat(incumbent.executablePath);
  if (!executable.isFile() || executable.isSymbolicLink() || !owned(executable) || (executable.mode & 0o7022) !== 0 || (executable.mode & 0o111) === 0) throw new Error("Linux desktop managed executable is not an owned regular executable");
};

const hashOwnedFile = async (path: string): Promise<{ readonly stat: Stats; readonly sha256: string }> => {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !owned(stat) || stat.nlink !== 1 || (stat.mode & 0o7022) !== 0) throw new Error("Linux desktop generation contains an unsafe file");
    const digest = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      digest.update(chunk);
      bytes += chunk.length;
    }
    const after = await handle.stat();
    if (bytes !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw new Error("Linux desktop generation changed while being verified");
    }
    await handle.sync();
    return { stat, sha256: digest.digest("hex") };
  } finally { await handle.close(); }
};

const inventoryTree = async (root: string): Promise<ReadonlyMap<string, InventoryEntry>> => {
  const inventory = new Map<string, InventoryEntry>();
  const walk = async (relative: string): Promise<void> => {
    const directory = join(root, relative);
    const stat = await requireOwnedDirectory(directory);
    inventory.set(relative, { kind: "directory", mode: stat.mode & 0o7777, bytes: 0 });
    for (const name of (await readdir(directory)).sort()) {
      const childRelative = relative === "" ? name : `${relative}/${name}`;
      const path = join(root, childRelative);
      const child = await lstat(path);
      if (child.isDirectory() && !child.isSymbolicLink()) await walk(childRelative);
      else {
        if (!child.isFile() || child.isSymbolicLink()) throw new Error("Linux desktop generation contains a link or special file");
        const hashed = await hashOwnedFile(path);
        inventory.set(childRelative, { kind: "file", mode: hashed.stat.mode & 0o7777, bytes: hashed.stat.size, sha256: hashed.sha256 });
      }
    }
    await syncDirectory(directory);
  };
  await walk("");
  return inventory;
};

const requireMatchingInventory = async (root: string, expected: ReadonlyMap<string, InventoryEntry>): Promise<void> => {
  const actual = await inventoryTree(root);
  if (actual.size !== expected.size) throw new Error("Linux desktop generation inventory changed after admission");
  for (const [path, entry] of expected) {
    const observed = actual.get(path);
    if (observed === undefined || observed.kind !== entry.kind || observed.mode !== entry.mode || observed.bytes !== entry.bytes || observed.sha256 !== entry.sha256) {
      throw new Error("Linux desktop generation bytes or permissions changed after admission");
    }
  }
};

const withInstallMutation = async <A>(
  ownedRoot: OwnedLinuxInstallRoot,
  use: (lease: Awaited<ReturnType<typeof acquireLinuxInstallMutation>>) => Promise<A>,
): Promise<A> => {
  const lease = await acquireLinuxInstallMutation(ownedRoot);
  try {
    return await use(lease);
  } finally {
    await releaseLinuxInstallMutation(lease);
  }
};

const retireOwnedTree = async (
  ownedRoot: OwnedLinuxInstallRoot,
  lease: Awaited<ReturnType<typeof acquireLinuxInstallMutation>>,
  path: string,
  kind: "generation" | "attempt",
): Promise<void> => {
  const tree = await persistLinuxInstallAllocation({
    root: ownedRoot,
    lease,
    path,
    kind,
    phase: "allocated",
  });
  await retireLinuxInstallTree({ root: ownedRoot, lease, tree });
};

export const stageLinuxDesktopRelease = async (input: {
  readonly archivePath: string;
  readonly descriptor: VerifiedLinuxDesktopRelease;
  readonly home?: string;
}): Promise<StagedLinuxDesktopRelease> => {
  assertVerifiedLinuxDesktopRelease(input.descriptor);
  requireOrdinaryUser();
  const descriptor = input.descriptor;
  const home = await resolveInstallHome(input.home ?? homedir());
  const root = await ensureInstallLayout(home);
  const ownedRoot = await admitOwnedLinuxInstallRoot({ home, rootPath: root });
  const generation = `${descriptor.version}-${descriptor.archive.sha256}`;
  if (!RELEASE_NAME.test(generation)) throw new Error("Linux desktop generation identity is invalid");
  const incumbent = await readManagedLauncher(home, root);
  await requireManagedDesktop(home);
  return await withInstallMutation(ownedRoot, async (lease) => {
    await collectLinuxInstallStorage({
      root: ownedRoot,
      lease,
      activeBasename: incumbent === undefined ? undefined : generationBasename(dirname(incumbent.executablePath)),
      currentExecutablePath: incumbent?.executablePath,
    }).catch(() => undefined);
    await assertLinuxInstallDiskAdmission({ path: root, archiveBytes: descriptor.archive.bytes });
    const attempt = await mkdtemp(join(root, ".stage-"));
    await chmod(attempt, 0o700);
    protectLinuxInstallBasename(ownedRoot, basename(attempt));
    try {
      await persistLinuxInstallAllocation({
        root: ownedRoot,
        lease,
        path: attempt,
        kind: "attempt",
        phase: "allocated",
      });
      const extracted = await extractLinuxDesktopArchive({ archivePath: input.archivePath, attemptRoot: attempt, expected: { version: descriptor.version, bytes: descriptor.archive.bytes, sha256: descriptor.archive.sha256 } });
      await chmod(extracted, 0o700);
      await admitPackagedUpdateIdentity({ asarPath: join(extracted, "resources/app.asar"), version: descriptor.version, sourceRevision: descriptor.sourceRevision });
      const inventory = await inventoryTree(extracted);
      const executable = inventory.get("vellum-command");
      if (executable?.kind !== "file" || (executable.mode & 0o111) === 0) throw new Error("Linux desktop executable is not admitted");
      const generationPath = join(root, generation);
      const created = await mkdir(generationPath, { mode: 0o700 }).then(() => true).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") return false;
        throw error;
      });
      if (created) {
        await persistLinuxInstallAllocation({
          root: ownedRoot,
          lease,
          path: generationPath,
          kind: "generation",
          phase: "allocated",
          version: descriptor.version,
          archiveSha256: descriptor.archive.sha256,
        });
        try {
          // An exclusively created, inactive generation may be populated without
          // overwriting an existing directory. Only the launcher selects it.
          for (const name of await readdir(extracted)) await rename(join(extracted, name), join(generationPath, name));
          await requireMatchingInventory(generationPath, inventory);
        } catch (error) {
          await retireOwnedTree(ownedRoot, lease, generationPath, "generation");
          throw error;
        }
      } else await requireMatchingInventory(generationPath, inventory);
      await persistLinuxInstallAllocation({
        root: ownedRoot,
        lease,
        path: generationPath,
        kind: "generation",
        phase: "admitted",
        version: descriptor.version,
        archiveSha256: descriptor.archive.sha256,
      });
      // Persist both the generation entry and newly created ancestor names before
      // a durable launcher can select this payload after a power loss.
      for (const relative of [".local/opt/vellum-command-alpha", ".local/opt", ".local/bin", ".local/share/applications", ".local/share", ".local", ""]) await syncDirectory(join(home, relative));
      const handle: StagedLinuxDesktopRelease = Object.freeze({ [STAGED]: true as const, executablePath: join(generationPath, "vellum-command"), generationPath, archiveSha256: descriptor.archive.sha256 });
      stagedReleases.set(handle, { home, root, ownedRoot, generation: identity(await requireOwnedDirectory(generationPath)), inventory, incumbent, version: descriptor.version, activated: false });
      setLiveLinuxInstallCandidate(ownedRoot, generation);
      return handle;
    } finally {
      unprotectLinuxInstallBasename(ownedRoot, basename(attempt));
      await retireOwnedTree(ownedRoot, lease, attempt, "attempt").catch(() => undefined);
    }
  });
};

const requireStagedAuthority = (handle: StagedLinuxDesktopRelease): StagedAuthority => {
  const authority = stagedReleases.get(handle);
  if (authority === undefined) throw new Error("Linux desktop release was not staged by this installer");
  if (authority.activated) throw new Error("Linux desktop release activation authority was already consumed");
  return authority;
};

export const revalidateLinuxDesktopRelease = async (handle: StagedLinuxDesktopRelease): Promise<void> => {
  const authority = requireStagedAuthority(handle);
  await requireInstallLayout(authority);
  const stat = await requireOwnedDirectory(handle.generationPath);
  if (!sameIdentity(stat, authority.generation)) throw new Error("Linux desktop generation changed filesystem identity");
  await requireMatchingInventory(handle.generationPath, authority.inventory);
};

const writeTemporaryFile = async (path: string, body: string, mode: number): Promise<void> => {
  const file = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, mode);
  try { await file.writeFile(body, "utf8"); await file.chmod(mode); await file.sync(); }
  finally { await file.close(); }
};

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
};

/** No process or product-state operations: the caller quiesces before update. */
export const activateLinuxDesktopRelease = async (handle: StagedLinuxDesktopRelease, options: LinuxDesktopActivationOptions): Promise<void> => {
  let activated = false;
  let temporaryDesktop: string | undefined;
  let temporaryLauncher: string | undefined;
  try {
    const authority = requireStagedAuthority(handle);
    await revalidateLinuxDesktopRelease(handle);
    const checkIncumbent = async (): Promise<void> => {
      const incumbent = await readManagedLauncher(authority.home, authority.root);
      if (options.mode === "first-install") {
        if (incumbent !== undefined || authority.incumbent !== undefined) throw new Error("First install refuses an existing managed desktop launcher");
      } else if (incumbent === undefined || authority.incumbent === undefined || !sameIdentity(incumbent, authority.incumbent) || incumbent.body !== authority.incumbent.body || incumbent.executablePath !== options.expectedIncumbentExecutablePath) {
        throw new Error("Linux desktop update incumbent is not the exact managed running generation");
      } else {
        const incumbentVersion = incumbent.executablePath.slice(authority.root.length + 1).split("-")[0]!;
        if (compareLinuxDesktopVersions(authority.version, incumbentVersion) <= 0) throw new Error("Linux desktop update must be strictly newer than the active generation");
      }
    };
    await checkIncumbent();
    await requireManagedDesktop(authority.home);
    const stableLauncher = launcherPath(authority.home);
    const stableDesktop = desktopPath(authority.home);
    const reuseDesktop = options.mode === "first-install" && await exists(stableDesktop);
    const nonce = randomUUID();
    temporaryLauncher = join(dirname(stableLauncher), `.vellum-command-desktop-${nonce}`);
    if (!reuseDesktop) {
      temporaryDesktop = join(dirname(stableDesktop), `.vellum-command-${nonce}.desktop`);
      await writeTemporaryFile(temporaryDesktop, desktopBody(authority.home), 0o644);
    }
    await writeTemporaryFile(temporaryLauncher, launcherBody(authority.root, handle.generationPath.slice(authority.root.length + 1)), 0o755);
    await requireInstallLayout(authority);
    await requireManagedDesktop(authority.home);
    if (temporaryDesktop !== undefined) {
      if (options.mode === "first-install") {
        await link(temporaryDesktop, stableDesktop);
        await rm(temporaryDesktop);
      } else await rename(temporaryDesktop, stableDesktop);
      temporaryDesktop = undefined;
    }
    await syncDirectory(dirname(stableDesktop));
    await revalidateLinuxDesktopRelease(handle);
    await checkIncumbent();
    await requireManagedDesktop(authority.home);
    if (options.mode === "first-install") await link(temporaryLauncher, stableLauncher);
    else await rename(temporaryLauncher, stableLauncher);
    activated = true;
    authority.activated = true;
    setLiveLinuxInstallCandidate(authority.ownedRoot, undefined);
    if (options.mode === "first-install") await rm(temporaryLauncher);
    temporaryLauncher = undefined;
    await syncDirectory(dirname(stableLauncher));
  } catch (error) {
    throw new LinuxDesktopActivationError(error instanceof Error ? error.message : String(error), activated, error);
  } finally {
    // Exact temporary names were created exclusively by this call. Generations
    // and the active launcher are never retired or rolled back here.
    try {
      if (temporaryDesktop !== undefined) await rm(temporaryDesktop, { force: true });
      if (temporaryLauncher !== undefined) await rm(temporaryLauncher, { force: true });
    } catch (error) {
      throw new LinuxDesktopActivationError("Linux desktop activation temporary-file cleanup failed", activated, error);
    }
  }
};

const managedGenerationFromLauncher = async (home: string): Promise<{
  readonly ownedRoot: OwnedLinuxInstallRoot;
  readonly activeBasename: string | undefined;
  readonly executablePath: string | undefined;
} | undefined> => {
  try {
    const resolvedHome = await resolveInstallHome(home);
    const root = join(resolvedHome, ".local/opt/vellum-command-alpha");
    const ownedRoot = await admitOwnedLinuxInstallRoot({ home: resolvedHome, rootPath: root });
    const incumbent = await readManagedLauncher(resolvedHome, root).catch(() => undefined);
    return {
      ownedRoot,
      activeBasename: incumbent === undefined ? undefined : generationBasename(dirname(incumbent.executablePath)),
      executablePath: incumbent?.executablePath,
    };
  } catch {
    return undefined;
  }
};

/** Process-local readiness after the selected generation opened product state. */
export const markLinuxDesktopInstallReady = async (input: {
  readonly home?: string;
  readonly executablePath: string;
}): Promise<void> => {
  requireOrdinaryUser();
  const home = await resolveInstallHome(input.home ?? homedir());
  const root = join(home, ".local/opt/vellum-command-alpha");
  const ownedRoot = await admitOwnedLinuxInstallRoot({ home, rootPath: root });
  const incumbent = await readManagedLauncher(home, root);
  if (incumbent === undefined || incumbent.executablePath !== input.executablePath) {
    throw new Error("Linux desktop updater requires the exact managed running generation");
  }
  const generationPath = dirname(incumbent.executablePath);
  const ready = mintLinuxDesktopInstallReadiness({
    executablePath: incumbent.executablePath,
    generationBasename: generationBasename(generationPath),
    generationIdentity: identity(await requireOwnedDirectory(generationPath)),
  });
  holdLinuxDesktopInstallReadiness(ready);
  await withInstallMutation(ownedRoot, async (lease) => {
    await collectLinuxInstallStorage({
      root: ownedRoot,
      lease,
      activeBasename: generationBasename(generationPath),
      currentExecutablePath: incumbent.executablePath,
      readiness: ready,
    });
  });
};

export const observeLinuxDesktopInstallStorage = async (input: {
  readonly home?: string;
  readonly executablePath?: string;
} = {}) => {
  const observed = await managedGenerationFromLauncher(input.home ?? homedir());
  if (observed === undefined) return undefined;
  return observeLinuxInstallStorage({
    root: observed.ownedRoot,
    activeBasename: observed.activeBasename,
    currentExecutablePath: input.executablePath ?? observed.executablePath,
  });
};

export const linuxDesktopInstallStorageDoctor = async (input: {
  readonly home?: string;
  readonly executablePath?: string;
} = {}) => {
  try {
    const observation = await observeLinuxDesktopInstallStorage(input);
    if (observation === undefined) return undefined;
    return linuxInstallStorageDoctorCheck(observation);
  } catch (error) {
    return linuxInstallStorageDoctorCheck(
      undefined,
      error instanceof Error ? error.message : "Linux managed install storage could not be observed.",
    );
  }
};

export { heldLinuxDesktopInstallReadiness, holdLinuxDesktopInstallReadiness };
