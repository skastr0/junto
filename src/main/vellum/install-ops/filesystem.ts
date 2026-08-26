import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  statSync,
  type Stats,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

const currentUid = (): number | undefined =>
  typeof process.getuid === "function" ? process.getuid() : undefined;

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

const sameIdentity = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

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

const assertRegularFile = (path: string, info: Stats): void => {
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`install-ops database is not a regular file: ${path}`);
  }
  if (info.nlink !== 1) {
    throw new Error(
      `install-ops database must have exactly one filesystem link: ${path}`,
    );
  }
  assertOwned(path, info);
};

const productDatabasePathBeside = (path: string): string =>
  resolve(join(dirname(path), "vellum-command.db"));

const assertNotProductDatabase = (path: string, info: Stats): void => {
  const productPath = productDatabasePathBeside(path);
  if (path === productPath) {
    throw new Error(
      `install-ops database path aliases the product database: ${path}`,
    );
  }

  try {
    // Follow a product-path symlink only for identity comparison. No bytes are
    // opened or changed through this probe.
    const productInfo = statSync(productPath);
    if (sameIdentity(info, productInfo)) {
      throw new Error(
        `install-ops database aliases the product database: ${path}`,
      );
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
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

export type InstallOpsFileGuard = {
  readonly path: string;
  /** Run immediately after SQLite opens and before any PRAGMA or DDL. */
  readonly verifyPostOpen: () => void;
  readonly close: () => void;
};

/**
 * Admit the install-local database path without asking SQLite to create or
 * classify it. The returned descriptor pins the admitted inode through
 * SQLite acquisition and service lifetime.
 */
export const acquireInstallOpsFileGuard = (
  configuredPath: string,
): InstallOpsFileGuard => {
  const path = resolve(configuredPath);
  const directory = dirname(path);
  const productPath = productDatabasePathBeside(path);
  if (path === productPath) {
    throw new Error(
      `install-ops database path aliases the product database: ${path}`,
    );
  }

  const directoryIdentity = hardenDirectory(directory);
  let descriptor: number | undefined;

  try {
    let before: Stats | undefined;
    try {
      before = lstatSync(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    if (before !== undefined) {
      assertRegularFile(path, before);
      assertNotProductDatabase(path, before);
      descriptor = openSync(
        path,
        constants.O_RDWR | noFollowFlag,
      );
    } else {
      descriptor = openSync(
        path,
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_EXCL |
          noFollowFlag,
        FILE_MODE,
      );
    }

    const descriptorInfo = fstatSync(descriptor);
    const admittedPathInfo = lstatSync(path);
    assertRegularFile(path, descriptorInfo);
    assertRegularFile(path, admittedPathInfo);
    if (!sameIdentity(descriptorInfo, admittedPathInfo)) {
      throw new Error(`install-ops database changed during admission: ${path}`);
    }
    assertNotProductDatabase(path, descriptorInfo);

    try {
      fchmodSync(descriptor, FILE_MODE);
    } catch (error) {
      if (currentUid() !== undefined) throw error;
    }
    const hardenedInfo = fstatSync(descriptor);
    assertRegularFile(path, hardenedInfo);
    if (currentUid() !== undefined && (hardenedInfo.mode & 0o077) !== 0) {
      throw new Error(`install-ops database is not owner-only: ${path}`);
    }

    let closed = false;
    const verifyPostOpen = (): void => {
      if (closed) {
        throw new Error(`install-ops filesystem guard is closed: ${path}`);
      }

      const directoryAfter = lstatSync(directory);
      assertDirectory(directory, directoryAfter);
      if (!sameIdentity(directoryIdentity, directoryAfter)) {
        throw new Error(
          `install-ops directory changed while opening SQLite: ${directory}`,
        );
      }

      const descriptorAfter = fstatSync(descriptor!);
      const pathAfter = lstatSync(path);
      assertRegularFile(path, descriptorAfter);
      assertRegularFile(path, pathAfter);
      if (!sameIdentity(descriptorAfter, pathAfter)) {
        throw new Error(
          `install-ops database changed while opening SQLite: ${path}`,
        );
      }
      assertNotProductDatabase(path, descriptorAfter);
    };

    return {
      path,
      verifyPostOpen,
      close: () => {
        if (closed) return;
        closed = true;
        closeSync(descriptor!);
      },
    };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the admission failure.
      }
    }
    throw error;
  }
};
