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
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const UUID_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Node-capable credential vault used by Command Center and Remote.
 *
 * Secret values are never stored in SQLite. The default backend is an
 * owner-only directory beside the product database (same class as the
 * work-control token file). `KeychainCredentialStore` (macOS) and
 * `SecretServiceCredentialStore` (Linux) implement the same contract on the
 * platform's own store; `openPlatformSecretStore` picks one at startup.
 *
 * `available: false` means durable writes must fail closed. Reads degrade
 * to missing so Settings boot and ordinary preferences still work.
 */
export interface CredentialStore {
  readonly available: boolean;
  readonly put: (id: string, value: string) => void;
  readonly get: (id: string) => string | undefined;
  readonly delete: (id: string) => void;
  readonly listIds: () => ReadonlyArray<string>;
}

export class UnavailableCredentialStore implements CredentialStore {
  readonly available = false;

  put(): void {
    throw new Error("credential vault is unavailable");
  }

  get(): undefined {
    return undefined;
  }

  delete(): void {}

  listIds(): ReadonlyArray<string> {
    return [];
  }
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

  listIds(): ReadonlyArray<string> {
    return [...this.#values.keys()];
  }
}

const isEnoent = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code: unknown }).code === "ENOENT";

const fsyncDirectory = (path: string): void => {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const assertPrivateDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`credential vault path is not a real directory: ${path}`);
  }
  chmodSync(path, DIRECTORY_MODE);
};

export class FileCredentialStore implements CredentialStore {
  available = false;

  constructor(readonly directory: string) {
    try {
      assertPrivateDirectory(directory);
      this.available = true;
    } catch {
      this.available = false;
    }
  }

  #pathFor(id: string): string {
    if (!UUID_FILE.test(id)) {
      throw new Error("credential id is not a UUID");
    }
    return join(this.directory, `${id}.secret`);
  }

  put(id: string, value: string): void {
    if (!this.available) {
      throw new Error("credential vault is unavailable");
    }
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
      fsyncDirectory(this.directory);
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
    if (!this.available) return undefined;
    try {
      const path = this.#pathFor(id);
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink()) return undefined;
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  }

  delete(id: string): void {
    if (!this.available) return;
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

  listIds(): ReadonlyArray<string> {
    if (!this.available) return [];
    try {
      return readdirSync(this.directory).flatMap((name) => {
        if (!name.endsWith(".secret")) return [];
        const id = name.slice(0, -".secret".length);
        return UUID_FILE.test(id) ? [id] : [];
      });
    } catch {
      return [];
    }
  }
}

export const openFileCredentialStore = (directory: string): CredentialStore => {
  try {
    const store = new FileCredentialStore(directory);
    return store.available ? store : new UnavailableCredentialStore();
  } catch {
    return new UnavailableCredentialStore();
  }
};

/** Test helper: list leftover vault filenames. */
export const listCredentialStoreFiles = (directory: string): ReadonlyArray<string> => {
  try {
    return readdirSync(directory).filter((name) => name.endsWith(".secret"));
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
};

export const credentialStoreDirectory = (databasePath: string): string =>
  join(dirname(databasePath), "credentials");

// ── Platform secret stores ─────────────────────────────────────────────────
//
// The operating system already has a secret store. These backends keep
// Junto's own secrets in it, through the tools the system ships: `security`
// on macOS, `secret-tool` on Linux. A value goes in on stdin and never on a
// command line. The owner-only file store stays the fallback for a machine
// with neither (a headless station).

/** One bounded, synchronous call to a platform tool. Injected in tests. */
export type SecretToolExec = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly input?: string; readonly timeoutMs: number },
) => {
  /** Exit code; undefined when the tool did not run to completion. */
  readonly status: number | undefined;
  readonly stdout: string;
  readonly notInstalled: boolean;
  readonly timedOut: boolean;
};

const SECRET_TOOL_TIMEOUT_MS = 5_000;
const SECRET_TOOL_PROBE_TIMEOUT_MS = 2_000;

export const execSecretTool: SecretToolExec = (command, args, options) => {
  const result = spawnSync(command, [...args], {
    input: options.input ?? "",
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: 1024 * 1024,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    status: result.status ?? undefined,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    notInstalled: code === "ENOENT",
    timedOut: code === "ETIMEDOUT",
  };
};

/** Ids Junto has stored, kept beside the fallback directory. Never a value. */
class SecretIdIndex {
  readonly #path: string;

  constructor(directory: string) {
    this.#path = join(directory, "ids.json");
  }

  list(): string[] {
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string" && UUID_FILE.test(id))
        : [];
    } catch {
      return [];
    }
  }

  #write(ids: ReadonlyArray<string>): void {
    assertPrivateDirectory(dirname(this.#path));
    const temporary = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify([...new Set(ids)].sort()), {
      encoding: "utf8",
      mode: FILE_MODE,
    });
    renameSync(temporary, this.#path);
  }

  add(id: string): void {
    const ids = this.list();
    if (!ids.includes(id)) this.#write([...ids, id]);
  }

  remove(id: string): void {
    const ids = this.list();
    if (ids.includes(id)) this.#write(ids.filter((entry) => entry !== id));
  }
}

const assertSecretId = (id: string): void => {
  if (!UUID_FILE.test(id)) throw new Error("credential id is not a UUID");
};

/**
 * How a value is written to a store that hands it back as one line of text.
 * A printable single-line value is stored as it is, so the item reads
 * normally in the system's own tools. Anything else is wrapped.
 */
const WRAPPED_PREFIX = "junto-b64:";
const PLAIN_VALUE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/u;

const encodeStoredValue = (value: string): string =>
  PLAIN_VALUE.test(value) && !value.startsWith(WRAPPED_PREFIX)
    ? value
    : `${WRAPPED_PREFIX}${Buffer.from(value, "utf8").toString("base64")}`;

const decodeStoredValue = (stored: string): string => {
  const line = stored.replace(/\r?\n$/u, "");
  return line.startsWith(WRAPPED_PREFIX)
    ? Buffer.from(line.slice(WRAPPED_PREFIX.length), "base64").toString("utf8")
    : line;
};

const toHex = (text: string): string => Buffer.from(text, "utf8").toString("hex");

export type PlatformStoreOptions = {
  /** Owner-only directory for the id index (and the file fallback). */
  readonly directory: string;
  readonly exec?: SecretToolExec;
  /** Item service name. One per installation kind, so builds do not collide. */
  readonly service?: string;
};

export const JUNTO_SECRET_SERVICE = "Junto secret";

/**
 * macOS Keychain, through `/usr/bin/security`. One generic password per
 * secret: service `Junto secret`, account the secret id.
 */
export class KeychainCredentialStore implements CredentialStore {
  readonly available: boolean;
  readonly #exec: SecretToolExec;
  readonly #service: string;
  readonly #index: SecretIdIndex;
  static readonly tool = "/usr/bin/security";

  constructor(options: PlatformStoreOptions) {
    this.#exec = options.exec ?? execSecretTool;
    this.#service = options.service ?? JUNTO_SECRET_SERVICE;
    this.#index = new SecretIdIndex(options.directory);
    // Asking for the tool's own help touches no keychain and prompts nobody.
    const probe = this.#exec(KeychainCredentialStore.tool, ["help"], {
      timeoutMs: SECRET_TOOL_TIMEOUT_MS,
    });
    this.available = !probe.notInstalled && !probe.timedOut;
  }

  put(id: string, value: string): void {
    if (!this.available) throw new Error("credential vault is unavailable");
    assertSecretId(id);
    // `security -i` reads its command from stdin, so the value never sits on
    // a command line. `-X` takes the password as hex: no quoting to get wrong.
    const command =
      `add-generic-password -U -s "${this.#service}" -a ${id} -X ${toHex(encodeStoredValue(value))}\n`;
    const result = this.#exec(KeychainCredentialStore.tool, ["-i"], {
      input: command,
      timeoutMs: SECRET_TOOL_TIMEOUT_MS,
    });
    if (result.status !== 0) {
      throw new Error(
        result.timedOut
          ? "the Keychain did not answer in time"
          : "the Keychain refused to save the secret",
      );
    }
    this.#index.add(id);
  }

  get(id: string): string | undefined {
    if (!this.available || !UUID_FILE.test(id)) return undefined;
    const result = this.#exec(
      KeychainCredentialStore.tool,
      ["find-generic-password", "-s", this.#service, "-a", id, "-w"],
      { timeoutMs: SECRET_TOOL_TIMEOUT_MS },
    );
    return result.status === 0 ? decodeStoredValue(result.stdout) : undefined;
  }

  delete(id: string): void {
    if (!this.available || !UUID_FILE.test(id)) return;
    this.#exec(
      KeychainCredentialStore.tool,
      ["delete-generic-password", "-s", this.#service, "-a", id],
      { timeoutMs: SECRET_TOOL_TIMEOUT_MS },
    );
    this.#index.remove(id);
  }

  listIds(): ReadonlyArray<string> {
    return this.available ? this.#index.list() : [];
  }
}

/**
 * Linux Secret Service (GNOME Keyring, KWallet), through `secret-tool`. One
 * item per secret, looked up by `service` and `id` attributes.
 */
export class SecretServiceCredentialStore implements CredentialStore {
  readonly available: boolean;
  readonly #exec: SecretToolExec;
  readonly #service: string;
  readonly #index: SecretIdIndex;
  static readonly tool = "secret-tool";

  constructor(options: PlatformStoreOptions) {
    this.#exec = options.exec ?? execSecretTool;
    this.#service = options.service ?? JUNTO_SECRET_SERVICE;
    this.#index = new SecretIdIndex(options.directory);
    // A lookup that finds nothing exits 1 with a keyring behind it. No tool,
    // no session bus or a locked-out keyring answers differently, or not at
    // all: then the file store is the honest choice.
    const probe = this.#exec(
      SecretServiceCredentialStore.tool,
      ["lookup", "service", this.#service, "id", "00000000-0000-4000-8000-000000000000"],
      // Short: this runs once when the store is first opened, and a keyring
      // that takes longer than this to say "not found" is not one to rely on.
      { timeoutMs: SECRET_TOOL_PROBE_TIMEOUT_MS },
    );
    this.available =
      !probe.notInstalled && !probe.timedOut && (probe.status === 0 || probe.status === 1);
  }

  #attributes(id: string): string[] {
    return ["service", this.#service, "id", id];
  }

  put(id: string, value: string): void {
    if (!this.available) throw new Error("credential vault is unavailable");
    assertSecretId(id);
    // `secret-tool store` reads the secret from stdin.
    const result = this.#exec(
      SecretServiceCredentialStore.tool,
      ["store", `--label=${this.#service}`, ...this.#attributes(id)],
      { input: encodeStoredValue(value), timeoutMs: SECRET_TOOL_TIMEOUT_MS },
    );
    if (result.status !== 0) {
      throw new Error(
        result.timedOut
          ? "the keyring did not answer in time"
          : "the keyring refused to save the secret",
      );
    }
    this.#index.add(id);
  }

  get(id: string): string | undefined {
    if (!this.available || !UUID_FILE.test(id)) return undefined;
    const result = this.#exec(
      SecretServiceCredentialStore.tool,
      ["lookup", ...this.#attributes(id)],
      { timeoutMs: SECRET_TOOL_TIMEOUT_MS },
    );
    return result.status === 0 && result.stdout.length > 0
      ? decodeStoredValue(result.stdout)
      : undefined;
  }

  delete(id: string): void {
    if (!this.available || !UUID_FILE.test(id)) return;
    this.#exec(SecretServiceCredentialStore.tool, ["clear", ...this.#attributes(id)], {
      timeoutMs: SECRET_TOOL_TIMEOUT_MS,
    });
    this.#index.remove(id);
  }

  listIds(): ReadonlyArray<string> {
    return this.available ? this.#index.list() : [];
  }
}

/** Which store holds Junto's own secrets on this machine. */
export type SecretStoreBackend = "keychain" | "secret-service" | "file" | "unavailable";

export type OpenedSecretStore = {
  readonly store: CredentialStore;
  readonly backend: SecretStoreBackend;
  /** One plain sentence naming the active store, for startup and the doctor. */
  readonly description: string;
};

const BACKEND_DESCRIPTION: Readonly<Record<SecretStoreBackend, string>> = {
  keychain: "Junto keeps its secrets in the macOS Keychain.",
  "secret-service": "Junto keeps its secrets in the Linux keyring (Secret Service).",
  file: "Junto keeps its secrets in owner-only files in its own folder.",
  unavailable: "Junto has nowhere to keep secrets on this machine.",
};

/**
 * Pick the secret store for this platform, once, at startup: the Keychain on
 * macOS, the Secret Service on Linux, and the owner-only file store wherever
 * the platform store is not there to use.
 */
export const openPlatformSecretStore = (
  options: PlatformStoreOptions & { readonly platform?: NodeJS.Platform },
): OpenedSecretStore => {
  const platform = options.platform ?? process.platform;
  const opened = (store: CredentialStore, backend: SecretStoreBackend): OpenedSecretStore => ({
    store,
    backend,
    description: BACKEND_DESCRIPTION[backend],
  });
  try {
    if (platform === "darwin") {
      const keychain = new KeychainCredentialStore(options);
      if (keychain.available) return opened(keychain, "keychain");
    }
    if (platform === "linux") {
      const keyring = new SecretServiceCredentialStore(options);
      if (keyring.available) return opened(keyring, "secret-service");
    }
  } catch {
    // Fall through to the file store.
  }
  const file = openFileCredentialStore(options.directory);
  return file.available ? opened(file, "file") : opened(file, "unavailable");
};

/** Where region secrets live when the file store is the backend. */
export const regionSecretDirectory = (databasePath: string): string =>
  join(dirname(databasePath), "region-secrets");
