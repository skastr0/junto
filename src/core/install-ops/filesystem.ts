import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_RECOVERY_LEAF_BYTES = 64 * 1024 * 1024;

const FAMILY_SUFFIXES = ["", "-journal", "-wal", "-shm"] as const;
type FamilySuffix = (typeof FAMILY_SUFFIXES)[number];

type FamilyPaths = Readonly<Record<FamilySuffix, string>>;
type FamilySnapshot = ReadonlyMap<FamilySuffix, Stats>;

type PinnedLeaf = {
  readonly descriptor: number;
  readonly identity: Stats;
};

const currentUid = (): number | undefined =>
  typeof process.getuid === "function" ? process.getuid() : undefined;

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

const sameIdentity = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const familyPaths = (databasePath: string): FamilyPaths => ({
  "": databasePath,
  "-journal": `${databasePath}-journal`,
  "-wal": `${databasePath}-wal`,
  "-shm": `${databasePath}-shm`,
});

const productDatabasePathBeside = (path: string): string =>
  resolve(join(dirname(path), "junto.db"));

const assertOwned = (path: string, info: Stats): void => {
  const uid = currentUid();
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(`install-ops path is not owned by the current user: ${path}`);
  }
};

const assertDirectory = (path: string, info: Stats): void => {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`install-ops path is not a real directory: ${path}`);
  }
  assertOwned(path, info);
};

const assertAdmissibleLeaf = (path: string, info: Stats): void => {
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`install-ops SQLite leaf is not a regular file: ${path}`);
  }
  if (info.nlink !== 1) {
    throw new Error(
      `install-ops SQLite leaf must have exactly one filesystem link: ${path}`,
    );
  }
  assertOwned(path, info);
  if (currentUid() !== undefined && (info.mode & 0o777) !== FILE_MODE) {
    throw new Error(`install-ops SQLite leaf is not owner-only: ${path}`);
  }
};

const hardenDirectory = (path: string): Stats => {
  mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
  const before = lstatSync(path);
  assertDirectory(path, before);

  try {
    chmodSync(path, DIRECTORY_MODE);
  } catch (error) {
    // Windows does not implement POSIX owner modes. Unix acquisition fails
    // closed if the state directory cannot be made owner-only.
    if (currentUid() !== undefined) throw error;
  }

  const after = lstatSync(path);
  assertDirectory(path, after);
  if (!sameIdentity(before, after)) {
    throw new Error(`install-ops directory changed during admission: ${path}`);
  }
  if (currentUid() !== undefined && (after.mode & 0o077) !== 0) {
    throw new Error(`install-ops directory is not owner-only: ${path}`);
  }
  return after;
};

const noFollowFlag =
  typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

const lstatIfPresent = (path: string): Stats | undefined => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

const productIdentities = (paths: FamilyPaths): ReadonlyArray<{
  readonly path: string;
  readonly info: Stats;
}> => {
  const identities: Array<{ readonly path: string; readonly info: Stats }> = [];
  for (const suffix of FAMILY_SUFFIXES) {
    const path = paths[suffix];
    try {
      // Follow product-family symlinks only for identity comparison. No bytes
      // are opened or changed through this probe.
      identities.push({ path, info: statSync(path) });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return identities;
};

const inspectFamily = (
  opsPaths: FamilyPaths,
  productPaths: FamilyPaths,
): FamilySnapshot => {
  const product = productIdentities(productPaths);
  const seen: Array<{ readonly path: string; readonly info: Stats }> = [];
  const snapshot = new Map<FamilySuffix, Stats>();

  for (const suffix of FAMILY_SUFFIXES) {
    const path = opsPaths[suffix];
    if (Object.values(productPaths).includes(path)) {
      throw new Error(
        `install-ops SQLite leaf aliases a product database path: ${path}`,
      );
    }

    const info = lstatIfPresent(path);
    if (info === undefined) continue;
    assertAdmissibleLeaf(path, info);

    for (const prior of seen) {
      if (sameIdentity(info, prior.info)) {
        throw new Error(
          `install-ops SQLite leaves alias each other: ${prior.path} and ${path}`,
        );
      }
    }
    for (const member of product) {
      if (sameIdentity(info, member.info)) {
        throw new Error(
          `install-ops SQLite leaf aliases product state: ${path} and ${member.path}`,
        );
      }
    }

    seen.push({ path, info });
    snapshot.set(suffix, info);
  }

  return snapshot;
};

const pinExistingLeaf = (path: string, expected: Stats): PinnedLeaf => {
  const descriptor = openSync(path, constants.O_RDONLY | noFollowFlag);
  try {
    const descriptorInfo = fstatSync(descriptor);
    const pathInfo = lstatSync(path);
    assertAdmissibleLeaf(path, descriptorInfo);
    assertAdmissibleLeaf(path, pathInfo);
    if (
      !sameIdentity(expected, descriptorInfo) ||
      !sameIdentity(descriptorInfo, pathInfo)
    ) {
      throw new Error(`install-ops SQLite leaf changed during admission: ${path}`);
    }
    return { descriptor, identity: descriptorInfo };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
};

const readPinnedBytes = (
  leaf: PinnedLeaf,
  length: number,
  position = 0,
): Buffer => {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(
      leaf.descriptor,
      buffer,
      offset,
      length - offset,
      position + offset,
    );
    if (count <= 0) {
      throw new Error("install-ops SQLite family leaf ended unexpectedly");
    }
    offset += count;
  }
  return buffer;
};

const isPowerOfTwoPageSize = (value: number): boolean =>
  value >= 512 && value <= 65_536 && (value & (value - 1)) === 0;

const sqliteHeaderMode = (main: PinnedLeaf): "delete" | "wal" => {
  const info = fstatSync(main.descriptor);
  if (info.size < 100) {
    throw new Error("install-ops main file lacks a complete SQLite header");
  }
  const header = readPinnedBytes(main, 100);
  if (!header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))) {
    throw new Error("install-ops main file has an invalid SQLite header");
  }
  const readVersion = header[18];
  const writeVersion = header[19];
  if (readVersion === 1 && writeVersion === 1) return "delete";
  if (readVersion === 2 && writeVersion === 2) return "wal";
  throw new Error(
    "install-ops main file has unsupported SQLite header modes: " +
      `${String(readVersion)}/${String(writeVersion)}`,
  );
};

const assertHotRollbackJournal = (
  main: PinnedLeaf,
  journal: PinnedLeaf,
): number => {
  const mainInfo = fstatSync(main.descriptor);
  const journalInfo = fstatSync(journal.descriptor);
  if (journalInfo.size < 512) {
    throw new Error("install-ops rollback journal is not hot");
  }
  const header = readPinnedBytes(journal, 28);
  const magic = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);
  if (!header.subarray(0, 8).equals(magic)) {
    throw new Error("install-ops rollback journal lacks the hot-journal magic");
  }
  const tail = readPinnedBytes(journal, 16, journalInfo.size - 16);
  if (tail.subarray(8, 16).equals(magic)) {
    const masterNameLength = tail.readUInt32BE(0);
    if (masterNameLength > 0 && masterNameLength <= journalInfo.size - 16) {
      throw new Error(
        "install-ops rollback journal names an external master journal",
      );
    }
  }
  const recordCount = header.readUInt32BE(8);
  const originalPageCount = header.readUInt32BE(16);
  const sectorSize = header.readUInt32BE(20);
  const encodedPageSize = header.readUInt32BE(24);
  const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
  if (
    !isPowerOfTwoPageSize(sectorSize) ||
    !isPowerOfTwoPageSize(pageSize) ||
    mainInfo.size % pageSize !== 0
  ) {
    throw new Error("install-ops rollback journal has an invalid hot header");
  }
  if (originalPageCount === 0) {
    if (recordCount !== 0 || journalInfo.size < sectorSize) {
      throw new Error(
        "install-ops zero-origin rollback journal has an invalid header",
      );
    }
    return 0;
  }
  if (
    recordCount === 0 ||
    journalInfo.size < sectorSize + pageSize + 8 ||
    mainInfo.size < pageSize
  ) {
    throw new Error("install-ops rollback journal has an invalid hot header");
  }
  return originalPageCount;
};

const assertWalFile = (wal: PinnedLeaf): void => {
  const info = fstatSync(wal.descriptor);
  if (info.size < 32) {
    throw new Error("install-ops WAL file lacks a complete header");
  }
  const header = readPinnedBytes(wal, 32);
  const magic = header.readUInt32BE(0);
  const version = header.readUInt32BE(4);
  const encodedPageSize = header.readUInt32BE(8);
  const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
  if (
    (magic !== 0x377f0682 && magic !== 0x377f0683) ||
    version !== 3_007_000 ||
    !isPowerOfTwoPageSize(pageSize) ||
    info.size < 32 + pageSize + 24 ||
    (info.size - 32) % (pageSize + 24) !== 0
  ) {
    throw new Error("install-ops WAL file has an invalid header");
  }
};

const assertShmFile = (shm: PinnedLeaf, wal: PinnedLeaf): void => {
  const info = fstatSync(shm.descriptor);
  if (info.size === 0 || info.size % 32_768 !== 0) {
    throw new Error("install-ops SHM file has an invalid size");
  }
  const header = readPinnedBytes(shm, 96);
  if (!header.subarray(0, 48).equals(header.subarray(48, 96))) {
    throw new Error("install-ops SHM header copies disagree");
  }
  const littleEndian = header.readUInt32LE(0) === 3_007_000;
  const bigEndian = header.readUInt32BE(0) === 3_007_000;
  if (!littleEndian && !bigEndian) {
    throw new Error("install-ops SHM file has an invalid version");
  }
  if (header[12] !== 1) {
    throw new Error("install-ops SHM file is not initialized");
  }
  const shmPageSize = littleEndian
    ? header.readUInt16LE(14)
    : header.readUInt16BE(14);
  const shmFrames = littleEndian
    ? header.readUInt32LE(16)
    : header.readUInt32BE(16);
  const walHeader = readPinnedBytes(wal, 24);
  const encodedWalPageSize = walHeader.readUInt32BE(8);
  const walPageSize = encodedWalPageSize === 1
    ? 65_536
    : encodedWalPageSize;
  const normalizedShmPageSize = shmPageSize === 1 ? 65_536 : shmPageSize;
  if (
    shmFrames === 0 ||
    normalizedShmPageSize !== walPageSize ||
    !header.subarray(32, 40).equals(walHeader.subarray(16, 24))
  ) {
    throw new Error("install-ops SHM file does not match its WAL");
  }
};

const snapshotsMatch = (
  left: FamilySnapshot,
  right: FamilySnapshot,
): boolean =>
  FAMILY_SUFFIXES.every((suffix) => {
    const leftInfo = left.get(suffix);
    const rightInfo = right.get(suffix);
    return leftInfo === undefined
      ? rightInfo === undefined
      : rightInfo !== undefined && sameIdentity(leftInfo, rightInfo);
  });

export type InstallOpsStartupFamily =
  | "quiescent"
  | "hot-rollback"
  | "hot-rollback-zero-origin"
  | "wal-clean"
  | "wal-recovery";

export type InstallOpsFileGuard = {
  readonly path: string;
  /** True only for the atomically installed app-built seed inode. */
  readonly mainCreated: boolean;
  /**
   * Validate and pin the complete SQLite family. Call before and after every
   * SQLite open, schema action, PRAGMA, and marker operation.
   */
  readonly verifyFamily: () => void;
  /** Classify admitted startup bytes without asking SQLite to touch them. */
  readonly classifyStartupFamily: () => InstallOpsStartupFamily;
  /**
   * Recover a byte-for-byte clone of an admitted main + rollback journal.
   * The caller may use SQLite on the app-created clone, never the original.
   */
  readonly withRollbackRecoveryClone: <A>(
    use: (databasePath: string) => A,
  ) => A;
  /** Validate legacy WAL/SHM only through app-created copies first. */
  readonly withWalRecoveryClone: <A>(
    use: (databasePath: string) => A,
  ) => A;
  /** WAL recovery may use WAL/SHM, but never a rollback journal too. */
  readonly verifyNoRollbackJournal: () => void;
  /** Require the steady-state rollback-journal family: main only. */
  readonly verifyQuiescent: () => void;
  readonly close: () => void;
};

/**
 * Admit the install-local SQLite family without asking SQLite to create or
 * classify any leaf. Existing family leaves are never chmodded, unlinked, or
 * cleaned by this guard. Rollback recovery runs only against app-created clone
 * files. The main inode and every persistent sidecar inode stay pinned.
 *
 * This blocks static aliases and substitutions that persist through a family
 * check. It is not an OS security boundary against a process running
 * concurrently as the same uid:
 * stock `DatabaseSync` exposes neither its opened fd nor an open-by-handle VFS,
 * so a same-uid process can still race the final check and SQLite open. The
 * engine therefore fingerprints the actual connection read-only before its
 * first mutating statement and reports that residual active-race boundary.
 */
export const acquireInstallOpsFileGuard = (
  configuredPath: string,
  createFreshBytes: () => Uint8Array,
): InstallOpsFileGuard => {
  const path = resolve(configuredPath);
  const directory = dirname(path);
  const opsPaths = familyPaths(path);
  const productPaths = familyPaths(productDatabasePathBeside(path));

  for (const opsPath of Object.values(opsPaths)) {
    if (Object.values(productPaths).includes(opsPath)) {
      throw new Error(
        `install-ops SQLite family aliases product state: ${opsPath}`,
      );
    }
  }

  const directoryIdentity = hardenDirectory(directory);
  const pins = new Map<FamilySuffix, PinnedLeaf>();
  let mainCreated = false;
  let closed = false;

  const closePins = (): void => {
    let failure: unknown;
    for (const pin of pins.values()) {
      try {
        closeSync(pin.descriptor);
      } catch (error) {
        failure ??= error;
      }
    }
    pins.clear();
    if (failure !== undefined) throw failure;
  };

  const assertDirectoryIdentity = (): void => {
    const current = lstatSync(directory);
    assertDirectory(directory, current);
    if (!sameIdentity(directoryIdentity, current)) {
      throw new Error(
        `install-ops directory changed during SQLite use: ${directory}`,
      );
    }
    if (currentUid() !== undefined && (current.mode & 0o077) !== 0) {
      throw new Error(`install-ops directory is not owner-only: ${directory}`);
    }
  };

  const syncDirectory = (pathToSync: string): void => {
    const descriptor = openSync(
      pathToSync,
      constants.O_RDONLY | noFollowFlag,
    );
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  };

  const verifyFamily = (): void => {
    if (closed) {
      throw new Error(`install-ops filesystem guard is closed: ${path}`);
    }
    assertDirectoryIdentity();

    const first = inspectFamily(opsPaths, productPaths);
    if (first.get("") === undefined) {
      throw new Error(`install-ops database disappeared during use: ${path}`);
    }

    for (const suffix of FAMILY_SUFFIXES) {
      const current = first.get(suffix);
      const pinned = pins.get(suffix);
      const leafPath = opsPaths[suffix];

      if (current === undefined) {
        if (pinned !== undefined) {
          closeSync(pinned.descriptor);
          pins.delete(suffix);
        }
        continue;
      }

      if (pinned === undefined) {
        pins.set(suffix, pinExistingLeaf(leafPath, current));
        continue;
      }

      const descriptorInfo = fstatSync(pinned.descriptor);
      assertAdmissibleLeaf(leafPath, descriptorInfo);
      if (
        !sameIdentity(pinned.identity, descriptorInfo) ||
        !sameIdentity(descriptorInfo, current)
      ) {
        throw new Error(
          `install-ops SQLite leaf changed during use: ${leafPath}`,
        );
      }
    }

    const second = inspectFamily(opsPaths, productPaths);
    if (!snapshotsMatch(first, second)) {
      throw new Error(`install-ops SQLite family changed during verification: ${path}`);
    }
    assertDirectoryIdentity();
  };

  try {
    const initial = inspectFamily(opsPaths, productPaths);
    const initialMain = initial.get("");
    if (initialMain === undefined) {
      const existingSidecar = FAMILY_SUFFIXES.find(
        (suffix) => suffix !== "" && initial.has(suffix),
      );
      if (existingSidecar !== undefined) {
        throw new Error(
          `install-ops sidecar exists without its database: ${opsPaths[existingSidecar]}`,
        );
      }

      const bytes = Buffer.from(createFreshBytes());
      if (bytes.length === 0 || bytes.length > MAX_RECOVERY_LEAF_BYTES) {
        throw new Error("install-ops fresh seed has an invalid byte length");
      }

      const seedDirectory = mkdtempSync(
        join(directory, ".install-ops-seed-"),
      );
      const seedPath = join(seedDirectory, "install-ops.db");
      let seedDescriptor: number | undefined;
      let seedIdentity: Stats | undefined;
      let installed = false;
      try {
        chmodSync(seedDirectory, DIRECTORY_MODE);
        const seedDirectoryInfo = lstatSync(seedDirectory);
        assertDirectory(seedDirectory, seedDirectoryInfo);
        if (
          currentUid() !== undefined &&
          (seedDirectoryInfo.mode & 0o777) !== DIRECTORY_MODE
        ) {
          throw new Error(
            `install-ops seed directory is not owner-only: ${seedDirectory}`,
          );
        }

        seedDescriptor = openSync(
          seedPath,
          constants.O_RDWR |
            constants.O_CREAT |
            constants.O_EXCL |
            noFollowFlag,
          FILE_MODE,
        );
        if (currentUid() !== undefined) {
          fchmodSync(seedDescriptor, FILE_MODE);
        }
        seedIdentity = fstatSync(seedDescriptor);
        assertAdmissibleLeaf(seedPath, seedIdentity);
        let written = 0;
        while (written < bytes.length) {
          written += writeSync(
            seedDescriptor,
            bytes,
            written,
            bytes.length - written,
            written,
          );
        }
        fsyncSync(seedDescriptor);
        const completeSeedInfo = fstatSync(seedDescriptor);
        assertAdmissibleLeaf(seedPath, completeSeedInfo);
        if (completeSeedInfo.size !== bytes.length) {
          throw new Error("install-ops fresh seed was not written completely");
        }
        syncDirectory(seedDirectory);

        const beforeInstall = inspectFamily(opsPaths, productPaths);
        if (FAMILY_SUFFIXES.some((suffix) => beforeInstall.has(suffix))) {
          throw new Error(
            "install-ops SQLite family appeared before atomic seed install",
          );
        }
        renameSync(seedPath, path);
        installed = true;
        const pathInfo = lstatSync(path);
        assertAdmissibleLeaf(path, pathInfo);
        if (!sameIdentity(seedIdentity, pathInfo)) {
          throw new Error(
            `install-ops seed changed during atomic install: ${path}`,
          );
        }
        pins.set("", { descriptor: seedDescriptor, identity: seedIdentity });
        mainCreated = true;
        seedDescriptor = undefined;
        rmdirSync(seedDirectory);
        syncDirectory(directory);
      } catch (error) {
        if (!installed && seedDescriptor !== undefined) {
          try {
            const descriptorInfo = fstatSync(seedDescriptor);
            const current = lstatIfPresent(seedPath);
            if (
              seedIdentity !== undefined &&
              current !== undefined &&
              sameIdentity(seedIdentity, descriptorInfo) &&
              sameIdentity(descriptorInfo, current)
            ) {
              unlinkSync(seedPath);
            }
          } finally {
            closeSync(seedDescriptor);
          }
        }
        try {
          if (readdirSync(seedDirectory).length === 0) {
            rmdirSync(seedDirectory);
            syncDirectory(directory);
          }
        } catch {
          // Preserve the seed failure. Only an app-created scratch directory
          // can remain here; an installed canonical seed stays exact.
        }
        throw error;
      }
    } else {
      for (const suffix of FAMILY_SUFFIXES) {
        const info = initial.get(suffix);
        if (info !== undefined) {
          pins.set(suffix, pinExistingLeaf(opsPaths[suffix], info));
        }
      }
    }

    verifyFamily();
    if (mainCreated) {
      const afterCreate = inspectFamily(opsPaths, productPaths);
      const unexpected = FAMILY_SUFFIXES.find(
        (suffix) => suffix !== "" && afterCreate.has(suffix),
      );
      if (unexpected !== undefined) {
        throw new Error(
          `install-ops sidecar appeared before SQLite opened: ${opsPaths[unexpected]}`,
        );
      }
    }

    const classifyStartupFamily = (): InstallOpsStartupFamily => {
      verifyFamily();
      const main = pins.get("");
      if (main === undefined) {
        throw new Error("install-ops main capability is unavailable");
      }
      const journal = pins.get("-journal");
      const wal = pins.get("-wal");
      const shm = pins.get("-shm");
      const mainInfo = fstatSync(main.descriptor);

      if (mainCreated && mainInfo.size === 0) {
        if (journal !== undefined || wal !== undefined || shm !== undefined) {
          throw new Error(
            "fresh install-ops inode has an unowned SQLite sidecar",
          );
        }
        return "quiescent";
      }

      if (journal !== undefined) {
        if (wal !== undefined || shm !== undefined) {
          throw new Error(
            "rollback-mode install-ops database has an unowned WAL/SHM leaf",
          );
        }
        const originalPageCount = assertHotRollbackJournal(main, journal);
        if (originalPageCount === 0) return "hot-rollback-zero-origin";
        if (sqliteHeaderMode(main) !== "delete") {
          throw new Error(
            "install-ops hot journal conflicts with the main header mode",
          );
        }
        return "hot-rollback";
      }

      const headerMode = sqliteHeaderMode(main);
      if (headerMode === "delete") {
        if (wal !== undefined || shm !== undefined) {
          throw new Error(
            "rollback-mode install-ops database has an unowned WAL/SHM leaf",
          );
        }
        return "quiescent";
      }
      if (wal === undefined) {
        if (shm !== undefined) {
          throw new Error(
            "install-ops SHM leaf exists without its admitted WAL",
          );
        }
        return "wal-clean";
      }
      assertWalFile(wal);
      if (shm !== undefined) assertShmFile(shm, wal);
      return "wal-recovery";
    };

    const withRecoveryClone = <A>(
      kind: "rollback" | "wal",
      use: (databasePath: string) => A,
    ): A => {
      verifyFamily();
      const original = inspectFamily(opsPaths, productPaths);
      const mainSource = pins.get("");
      if (original.get("") === undefined || mainSource === undefined) {
        throw new Error(
          "install-ops recovery lacks its pinned main capability",
        );
      }

      let copySuffixes: readonly FamilySuffix[];
      if (kind === "rollback") {
        const journalSource = pins.get("-journal");
        if (
          journalSource === undefined ||
          original.get("-wal") !== undefined ||
          original.get("-shm") !== undefined
        ) {
          throw new Error(
            "install-ops rollback recovery requires exactly main and -journal",
          );
        }
        assertHotRollbackJournal(mainSource, journalSource);
        copySuffixes = ["", "-journal"];
      } else {
        const walSource = pins.get("-wal");
        const shmSource = pins.get("-shm");
        if (pins.get("-journal") !== undefined || walSource === undefined) {
          throw new Error(
            "install-ops WAL recovery requires main + WAL and no journal",
          );
        }
        assertWalFile(walSource);
        if (shmSource !== undefined) assertShmFile(shmSource, walSource);
        copySuffixes = shmSource === undefined
          ? ["", "-wal"]
          : ["", "-wal", "-shm"];
      }

      const recoveryDirectory = mkdtempSync(
        join(directory, ".install-ops-recovery-"),
      );
      try {
        chmodSync(recoveryDirectory, DIRECTORY_MODE);
        const recoveryDirectoryInfo = lstatSync(recoveryDirectory);
        assertDirectory(recoveryDirectory, recoveryDirectoryInfo);
        if (
          currentUid() !== undefined &&
          (recoveryDirectoryInfo.mode & 0o777) !== DIRECTORY_MODE
        ) {
          throw new Error(
            `install-ops recovery directory is not owner-only: ${recoveryDirectory}`,
          );
        }
        syncDirectory(directory);
      } catch (setupFailure) {
        try {
          if (readdirSync(recoveryDirectory).length === 0) {
            rmdirSync(recoveryDirectory);
            syncDirectory(directory);
          }
        } catch {
          // Preserve the directory-setup failure. The random app-created
          // directory contains no admitted product bytes.
        }
        throw setupFailure;
      }

      type RecoveryPin = {
        readonly path: string;
        readonly descriptor: number;
        readonly identity: Stats;
      };
      const recoveryPins: RecoveryPin[] = [];
      let result: A | undefined;
      let useFailed = false;
      let useFailure: unknown;

      const createRecoveryLeaf = (destinationPath: string): RecoveryPin => {
        const descriptor = openSync(
          destinationPath,
          constants.O_RDWR |
            constants.O_CREAT |
            constants.O_EXCL |
            noFollowFlag,
          FILE_MODE,
        );
        if (currentUid() !== undefined) fchmodSync(descriptor, FILE_MODE);
        const destinationInfo = fstatSync(descriptor);
        assertAdmissibleLeaf(destinationPath, destinationInfo);
        const recovery = {
          path: destinationPath,
          descriptor,
          identity: destinationInfo,
        } satisfies RecoveryPin;
        recoveryPins.push(recovery);
        return recovery;
      };

      const writeAll = (
        destination: number,
        bytes: Buffer,
        position: number,
      ): void => {
        let written = 0;
        while (written < bytes.length) {
          written += writeSync(
            destination,
            bytes,
            written,
            bytes.length - written,
            position + written,
          );
        }
      };

      const copyPinnedLeaf = (
        sourcePath: string,
        source: PinnedLeaf,
        destinationPath: string,
      ): void => {
        const sourceBefore = fstatSync(source.descriptor);
        assertAdmissibleLeaf(sourcePath, sourceBefore);
        if (!sameIdentity(source.identity, sourceBefore)) {
          throw new Error(
            `install-ops recovery source changed: ${sourcePath}`,
          );
        }
        if (sourceBefore.size > MAX_RECOVERY_LEAF_BYTES) {
          throw new Error(
            `install-ops recovery source exceeds the byte cap: ${sourcePath}`,
          );
        }

        const recovery = createRecoveryLeaf(destinationPath);
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        while (position < sourceBefore.size) {
          const length = Math.min(buffer.length, sourceBefore.size - position);
          const bytesRead = readSync(
            source.descriptor,
            buffer,
            0,
            length,
            position,
          );
          if (bytesRead <= 0) {
            throw new Error(
              `install-ops recovery source ended early: ${sourcePath}`,
            );
          }
          writeAll(
            recovery.descriptor,
            buffer.subarray(0, bytesRead),
            position,
          );
          position += bytesRead;
        }
        fsyncSync(recovery.descriptor);

        const sourceAfter = fstatSync(source.descriptor);
        if (
          !sameIdentity(sourceBefore, sourceAfter) ||
          sourceAfter.size !== sourceBefore.size ||
          sourceAfter.mtimeMs !== sourceBefore.mtimeMs ||
          sourceAfter.ctimeMs !== sourceBefore.ctimeMs
        ) {
          throw new Error(
            `install-ops recovery source changed while copying: ${sourcePath}`,
          );
        }
      };

      try {
        const recoveryMain = join(recoveryDirectory, "install-ops.db");
        for (const suffix of copySuffixes) {
          const source = pins.get(suffix);
          if (source === undefined) {
            throw new Error(
              `install-ops recovery lost source capability: ${opsPaths[suffix]}`,
            );
          }
          copyPinnedLeaf(
            opsPaths[suffix],
            source,
            suffix === "" ? recoveryMain : `${recoveryMain}${suffix}`,
          );
        }
        if (kind === "wal" && !copySuffixes.includes("-shm")) {
          const scratchShm = createRecoveryLeaf(`${recoveryMain}-shm`);
          writeAll(scratchShm.descriptor, Buffer.alloc(32_768), 0);
          fsyncSync(scratchShm.descriptor);
        }
        syncDirectory(recoveryDirectory);
        result = use(recoveryMain);
        if (
          kind === "rollback" &&
          lstatIfPresent(`${recoveryMain}-journal`) !== undefined
        ) {
          throw new Error(
            "SQLite did not consume the clone-validated rollback journal",
          );
        }
      } catch (error) {
        useFailed = true;
        useFailure = error;
      }

      let cleanupFailure: unknown;
      for (const recovery of recoveryPins.reverse()) {
        try {
          const descriptorInfo = fstatSync(recovery.descriptor);
          const current = lstatIfPresent(recovery.path);
          if (current !== undefined) {
            assertAdmissibleLeaf(recovery.path, current);
            if (
              !sameIdentity(recovery.identity, descriptorInfo) ||
              !sameIdentity(descriptorInfo, current)
            ) {
              throw new Error(
                `install-ops recovery clone changed before cleanup: ${recovery.path}`,
              );
            }
            unlinkSync(recovery.path);
          }
        } catch (error) {
          cleanupFailure ??= error;
        } finally {
          try {
            closeSync(recovery.descriptor);
          } catch (error) {
            cleanupFailure ??= error;
          }
        }
      }

      try {
        const remaining = readdirSync(recoveryDirectory);
        if (remaining.length !== 0) {
          throw new Error(
            `install-ops recovery directory contains unowned leaves: ${remaining.join(", ")}`,
          );
        }
        rmdirSync(recoveryDirectory);
        syncDirectory(directory);
      } catch (error) {
        cleanupFailure ??= error;
      }

      if (useFailed) throw useFailure;
      if (cleanupFailure !== undefined) throw cleanupFailure;
      return result as A;
    };

    const withRollbackRecoveryClone = <A>(
      use: (databasePath: string) => A,
    ): A => withRecoveryClone("rollback", use);

    const withWalRecoveryClone = <A>(
      use: (databasePath: string) => A,
    ): A => withRecoveryClone("wal", use);

    const verifyNoRollbackJournal = (): void => {
      verifyFamily();
      const snapshot = inspectFamily(opsPaths, productPaths);
      if (snapshot.has("-journal")) {
        throw new Error(
          `install-ops rollback journal conflicts with WAL recovery: ${opsPaths["-journal"]}`,
        );
      }
    };

    const verifyQuiescent = (): void => {
      verifyFamily();
      const snapshot = inspectFamily(opsPaths, productPaths);
      const sidecar = FAMILY_SUFFIXES.find(
        (suffix) => suffix !== "" && snapshot.has(suffix),
      );
      if (sidecar !== undefined) {
        throw new Error(
          `install-ops SQLite sidecar exists outside recovery: ${opsPaths[sidecar]}`,
        );
      }
    };

    return {
      path,
      mainCreated,
      verifyFamily,
      classifyStartupFamily,
      withRollbackRecoveryClone,
      withWalRecoveryClone,
      verifyNoRollbackJournal,
      verifyQuiescent,
      close: () => {
        if (closed) return;
        closed = true;
        closePins();
      },
    };
  } catch (error) {
    closed = true;
    try {
      closePins();
    } catch {
      // Preserve the admission failure.
    }
    throw error;
  }
};
