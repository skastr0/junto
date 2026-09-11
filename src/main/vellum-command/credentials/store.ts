import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Node-capable credential vault used by Command Center and Remote.
 *
 * Secret values are never stored in SQLite. The default backend is an
 * owner-only directory beside the product database (same class as the
 * work-control token file). A later Keychain/libsecret helper can implement
 * the same contract without changing callers.
 */
export interface CredentialStore {
  readonly available: boolean;
  readonly put: (id: string, value: string) => void;
  readonly get: (id: string) => string | undefined;
  readonly delete: (id: string) => void;
}

export class MemoryCredentialStore implements CredentialStore {
  readonly available = true;
  readonly #values = new Map<string, string>();

  put(id: string, value: string): void {
    this.#values.set(id, value);
  }

  get(id: string): string | undefined {
    return this.#values.get(id);
  }

  delete(id: string): void {
    this.#values.delete(id);
  }
}

const isEnoent = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code: unknown }).code === "ENOENT";

const assertPrivateDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`credential vault path is not a real directory: ${path}`);
  }
  chmodSync(path, DIRECTORY_MODE);
};

export class FileCredentialStore implements CredentialStore {
  readonly available = true;

  constructor(readonly directory: string) {
    assertPrivateDirectory(directory);
  }

  #pathFor(id: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
      throw new Error("credential id is not a UUID");
    }
    return join(this.directory, `${id}.secret`);
  }

  put(id: string, value: string): void {
    assertPrivateDirectory(this.directory);
    const destination = this.#pathFor(id);
    const temporary = `${destination}.${process.pid}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        FILE_MODE,
      );
      fchmodSync(fd, FILE_MODE);
      writeFileSync(fd, value, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, destination);
      const published = lstatSync(destination);
      if (
        !published.isFile() ||
        published.isSymbolicLink() ||
        (published.mode & 0o777) !== FILE_MODE
      ) {
        throw new Error("credential vault file could not be hardened");
      }
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Preserve the original failure.
        }
      }
      try {
        unlinkSync(temporary);
      } catch {
        // Best-effort temp cleanup.
      }
      throw error;
    }
  }

  get(id: string): string | undefined {
    try {
      const path = this.#pathFor(id);
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink()) return undefined;
      return readFileSync(path, "utf8");
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw error;
    }
  }

  delete(id: string): void {
    try {
      const path = this.#pathFor(id);
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink()) return;
      unlinkSync(path);
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
  }
}

export const makeFileCredentialStore = (directory: string): CredentialStore =>
  new FileCredentialStore(directory);

/** Test helper: list leftover vault filenames. */
export const listCredentialStoreFiles = (directory: string): ReadonlyArray<string> => {
  try {
    return readdirSync(directory).filter((name) => name.endsWith(".secret"));
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
};
