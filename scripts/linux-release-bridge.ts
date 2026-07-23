import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { read as readFd } from "node:fs";
import {
  constants as fsConstants,
  type Stats,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { hostname as kernelHostname } from "node:os";
import path from "node:path";
import process from "node:process";
import {
  LINUX_RELEASE_BRIDGE_AUTH_METADATA,
  LINUX_RELEASE_BRIDGE_AUTH_PROTOCOL,
  LINUX_RELEASE_BRIDGE_CLEAN_PROTOCOL,
  LINUX_RELEASE_BRIDGE_MAX_HEADER_BYTES,
  LINUX_RELEASE_BRIDGE_STAGE_METADATA,
  LINUX_RELEASE_BRIDGE_STAGE_ROOT,
  decodeLinuxReleaseBridgeStageRequest,
  encodeLinuxReleaseBridgeAuthArmed,
  encodeLinuxReleaseBridgeInventory,
  encodeLinuxReleaseBridgeStageCleared,
  encodeLinuxReleaseBridgeStageRequest,
  linuxReleaseBridgeStagePath,
  type LinuxReleaseBridgeAuthArmed,
  type LinuxReleaseBridgeCleanupReason,
  type LinuxReleaseBridgeFile,
  type LinuxReleaseBridgeStageCleared,
  type LinuxReleaseBridgeStageRequest,
} from "../src/shared/linux-release-bridge";
import {
  decodeLinuxReleaseInstallerReceipt,
  encodeLinuxReleaseInstallerReceipt,
  type LinuxReleaseInstallerReceipt,
} from "../src/shared/linux-release-installer";

/*
 * This source file is never the authorization command. Linux packaging
 * compiles it without runtime config autoloading and publishes the resulting
 * root-owned executable at this exact path.
 */
export const LINUX_RELEASE_BRIDGE_EXECUTABLE =
  "/usr/libexec/vellum-release-bridge" as const;
export const LINUX_RELEASE_BRIDGE_SUDO = "/usr/bin/sudo" as const;
export const LINUX_RELEASE_INSTALLER_EXECUTABLE =
  "/usr/libexec/vellum-release-installer" as const;
export const LINUX_RELEASE_BRIDGE_SUDO_ARGV = Object.freeze([
  "sudo",
  "-k",
  "-S",
  "-p",
  "",
  "--",
  LINUX_RELEASE_INSTALLER_EXECUTABLE,
] as const);
export const LINUX_RELEASE_BRIDGE_EXEC_ENV = Object.freeze({
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C",
  LC_ALL: "C",
});

const READ_CHUNK_BYTES = 64 * 1024;
const MAX_CHILD_LINE_BYTES = 16 * 1024;
const MAX_CHILD_STDOUT_BYTES = 64 * 1024;
const MAX_CHILD_STDERR_BYTES = 16 * 1024;
const AUTHORIZATION_TIMEOUT_MS = 10_000;
const TERMINATE_GRACE_MS = 1_000;
const HEX_32 = /^[0-9a-f]{32}$/u;
const DANGEROUS_ENVIRONMENT = [
  "BUN_OPTIONS",
  "BUN_INSTALL",
  "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
  "BUN_CONFIG_VERBOSE_FETCH",
  "BUN_CONFIG_LINK_NATIVE_BINS",
  "BUN_BE_BUN",
  "BUN_DEBUG_QUIET_LOGS",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "SUDO_ASKPASS",
] as const;

export type LinuxReleaseBridgeRefusal =
  | "identity"
  | "protocol"
  | "stage"
  | "runtime";

export class LinuxReleaseBridgeError extends Error {
  public constructor(readonly code: LinuxReleaseBridgeRefusal) {
    super(`release bridge refused: ${code}`);
  }
}

export interface LinuxReleaseBridgeInvocation {
  readonly platform: NodeJS.Platform;
  readonly uid: number;
  readonly effectiveUid: number;
  readonly gid: number;
  readonly effectiveGid: number;
  readonly arguments: ReadonlyArray<string>;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly hostname: string;
}

export interface LinuxReleaseBridgeInput {
  /**
   * Reads at most maxBytes from fd 0. Production deliberately uses a direct
   * bounded read, never process.stdin, so the following sudo password remains
   * unread in the kernel pipe.
   */
  readonly read: (maxBytes: number) => Promise<Uint8Array>;
}

export interface LinuxReleaseBridgeStageOptions {
  readonly root: string;
  readonly rootUid: number;
  readonly rootGid: number;
  readonly rootMode: 0o733 | 0o1733;
  /**
   * Linux production uses /proc/self/fd to retain the opened directory inode
   * across same-UID rename races. Tests on non-Linux hosts may set this null.
   */
  readonly fdDirectoryRoot: string | null;
}

export interface LinuxReleaseBridgeChild {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exited: Promise<number>;
  readonly terminate: () => void;
  readonly kill: () => void;
}

export interface LinuxReleaseBridgeRunOptions {
  readonly invocation: LinuxReleaseBridgeInvocation;
  readonly input: LinuxReleaseBridgeInput;
  readonly stage: LinuxReleaseBridgeStageOptions;
  readonly nonce: () => string;
  readonly emit: (record: string) => Promise<void>;
  readonly spawnSudo: () => LinuxReleaseBridgeChild;
  readonly authorizationTimeoutMs?: number;
}

interface ChildTranscript {
  readonly rootArmed: boolean;
  readonly terminal: LinuxReleaseInstallerReceipt | null;
}

const modeOf = (metadata: Stats): number => metadata.mode & 0o7777;

const sameInode = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { readonly code?: unknown }).code === "ENOENT";

const directStdin: LinuxReleaseBridgeInput = Object.freeze({
  read: (maxBytes: number) =>
    new Promise<Uint8Array>((resolve, reject) => {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
        reject(new LinuxReleaseBridgeError("runtime"));
        return;
      }
      const buffer = Buffer.allocUnsafe(maxBytes);
      readFd(0, buffer, 0, maxBytes, null, (error, bytesRead) => {
        if (error !== null) {
          reject(new LinuxReleaseBridgeError("protocol"));
          return;
        }
        resolve(buffer.subarray(0, bytesRead));
      });
    }),
});

export const deriveLinuxReleaseBridgeInvocation =
  (): LinuxReleaseBridgeInvocation => ({
    platform: process.platform,
    uid: process.getuid?.() ?? -1,
    effectiveUid: process.geteuid?.() ?? -1,
    gid: process.getgid?.() ?? -1,
    effectiveGid: process.getegid?.() ?? -1,
    // A compiled Bun executable has only its own argv[0] when called correctly.
    arguments: process.argv.slice(1),
    environment: process.env,
    hostname: kernelHostname().toLowerCase(),
  });

const validateInvocation = (
  invocation: LinuxReleaseBridgeInvocation,
  request: LinuxReleaseBridgeStageRequest,
): void => {
  if (
    invocation.platform !== "linux" ||
    invocation.uid < 1 ||
    invocation.uid > 0x7fff_ffff ||
    invocation.effectiveUid !== invocation.uid ||
    invocation.gid < 1 ||
    invocation.gid > 0x7fff_ffff ||
    invocation.effectiveGid !== invocation.gid ||
    invocation.arguments.length !== 0 ||
    DANGEROUS_ENVIRONMENT.some(
      (name) => invocation.environment[name] !== undefined,
    ) ||
    request.target.uid !== invocation.uid ||
    request.target.gid !== invocation.gid ||
    request.target.host !== invocation.hostname
  ) {
    throw new LinuxReleaseBridgeError("identity");
  }
  const inventorySha256 = createHash("sha256")
    .update(encodeLinuxReleaseBridgeInventory(request), "utf8")
    .digest("hex");
  if (inventorySha256 !== request.candidate.inventorySha256) {
    throw new LinuxReleaseBridgeError("protocol");
  }
};

export const verifyInstalledLinuxReleaseBridge = async (): Promise<void> => {
  if (
    process.platform !== "linux" ||
    process.getuid?.() === 0 ||
    process.geteuid?.() === 0
  ) {
    throw new LinuxReleaseBridgeError("identity");
  }
  const executable = await realpath(process.execPath);
  if (executable !== LINUX_RELEASE_BRIDGE_EXECUTABLE) {
    throw new LinuxReleaseBridgeError("identity");
  }
  const metadata = await lstat(executable);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    metadata.gid !== 0 ||
    modeOf(metadata) !== 0o755 ||
    metadata.nlink !== 1
  ) {
    throw new LinuxReleaseBridgeError("identity");
  }
};

class ExactLinuxReleaseBridgeReader {
  public constructor(
    private readonly input: LinuxReleaseBridgeInput,
  ) {}

  async #readAtMost(maxBytes: number): Promise<Buffer> {
    let value: Uint8Array;
    try {
      value = await this.input.read(maxBytes);
    } catch {
      throw new LinuxReleaseBridgeError("protocol");
    }
    if (value.byteLength > maxBytes) {
      throw new LinuxReleaseBridgeError("protocol");
    }
    return Buffer.from(value);
  }

  public async readHeader(): Promise<LinuxReleaseBridgeStageRequest> {
    const bytes = Buffer.allocUnsafe(LINUX_RELEASE_BRIDGE_MAX_HEADER_BYTES);
    let length = 0;
    while (length < bytes.byteLength) {
      const next = await this.#readAtMost(1);
      if (next.byteLength !== 1) {
        throw new LinuxReleaseBridgeError("protocol");
      }
      const byte = next[0]!;
      if (byte === 0x0a) {
        if (
          length === 0 ||
          bytes.subarray(0, length).includes(0x00) ||
          bytes.subarray(0, length).includes(0x0d)
        ) {
          throw new LinuxReleaseBridgeError("protocol");
        }
        const raw = bytes.subarray(0, length);
        let request: LinuxReleaseBridgeStageRequest;
        try {
          request = decodeLinuxReleaseBridgeStageRequest(
            JSON.parse(raw.toString("utf8")),
          );
        } catch {
          throw new LinuxReleaseBridgeError("protocol");
        }
        const canonical = Buffer.from(
          encodeLinuxReleaseBridgeStageRequest(request),
          "utf8",
        );
        if (
          canonical.byteLength !== raw.byteLength + 1 ||
          !canonical.subarray(0, raw.byteLength).equals(raw)
        ) {
          throw new LinuxReleaseBridgeError("protocol");
        }
        return request;
      }
      bytes[length] = byte;
      length += 1;
    }
    throw new LinuxReleaseBridgeError("protocol");
  }

  public async readFileChunk(remaining: number): Promise<Buffer> {
    const next = await this.#readAtMost(
      Math.min(remaining, READ_CHUNK_BYTES),
    );
    if (next.byteLength === 0) {
      throw new LinuxReleaseBridgeError("protocol");
    }
    return next;
  }
}

const assertSafeStageRoot = async (
  options: LinuxReleaseBridgeStageOptions,
): Promise<void> => {
  let metadata: Stats;
  let resolved: string;
  try {
    [metadata, resolved] = await Promise.all([
      lstat(options.root),
      realpath(options.root),
    ]);
  } catch {
    throw new LinuxReleaseBridgeError("stage");
  }
  if (
    resolved !== options.root ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== options.rootUid ||
    metadata.gid !== options.rootGid ||
    modeOf(metadata) !== options.rootMode
  ) {
    throw new LinuxReleaseBridgeError("stage");
  }
};

const writeAll = async (
  handle: FileHandle,
  bytes: Uint8Array,
): Promise<void> => {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      null,
    );
    if (result.bytesWritten < 1) {
      throw new LinuxReleaseBridgeError("stage");
    }
    offset += result.bytesWritten;
  }
};

class LinuxReleaseBridgeStageAuthority {
  readonly #created = new Set<string>();
  #closed = false;

  private constructor(
    readonly request: LinuxReleaseBridgeStageRequest,
    readonly stagePath: string,
    readonly directory: FileHandle,
    readonly inode: Stats,
    readonly options: LinuxReleaseBridgeStageOptions,
  ) {}

  public static async create(
    request: LinuxReleaseBridgeStageRequest,
    options: LinuxReleaseBridgeStageOptions,
  ): Promise<LinuxReleaseBridgeStageAuthority> {
    await assertSafeStageRoot(options);
    const stagePath = linuxReleaseBridgeStagePath(
      request.target.uid,
      request.transactionId,
      options.root,
    );
    try {
      await mkdir(stagePath, { mode: 0o700 });
    } catch {
      throw new LinuxReleaseBridgeError("stage");
    }
    let directory: FileHandle | undefined;
    try {
      const pathMetadata = await lstat(stagePath);
      directory = await open(
        stagePath,
        fsConstants.O_RDONLY |
          fsConstants.O_DIRECTORY |
          fsConstants.O_NOFOLLOW,
      );
      const descriptorMetadata = await directory.stat();
      if (
        !sameInode(pathMetadata, descriptorMetadata) ||
        !descriptorMetadata.isDirectory() ||
        descriptorMetadata.uid !== request.target.uid ||
        descriptorMetadata.gid !== request.target.gid ||
        modeOf(descriptorMetadata) !== 0o700 ||
        descriptorMetadata.nlink !== 2
      ) {
        throw new LinuxReleaseBridgeError("stage");
      }
      return new LinuxReleaseBridgeStageAuthority(
        request,
        stagePath,
        directory,
        descriptorMetadata,
        options,
      );
    } catch (error) {
      await directory?.close().catch(() => undefined);
      await rmdir(stagePath).catch(() => undefined);
      throw error instanceof LinuxReleaseBridgeError
        ? error
        : new LinuxReleaseBridgeError("stage");
    }
  }

  #directoryPath(): string {
    return this.options.fdDirectoryRoot === null
      ? this.stagePath
      : path.join(
        this.options.fdDirectoryRoot,
        String(this.directory.fd),
      );
  }

  #childPath(name: string): string {
    return path.join(this.#directoryPath(), name);
  }

  async #assertDirectory(): Promise<void> {
    if (this.#closed) throw new LinuxReleaseBridgeError("stage");
    const descriptorMetadata = await this.directory.stat();
    // APFS reports directory link counts for regular children; Linux does not.
    // Production always uses the descriptor-backed branch.
    const expectedLinks = this.options.fdDirectoryRoot === null
      ? 2 + this.#created.size
      : 2;
    if (
      !sameInode(this.inode, descriptorMetadata) ||
      !descriptorMetadata.isDirectory() ||
      descriptorMetadata.uid !== this.request.target.uid ||
      descriptorMetadata.gid !== this.request.target.gid ||
      modeOf(descriptorMetadata) !== 0o700 ||
      descriptorMetadata.nlink !== expectedLinks
    ) {
      throw new LinuxReleaseBridgeError("stage");
    }
    if (this.options.fdDirectoryRoot === null) {
      const pathMetadata = await lstat(this.stagePath);
      if (!sameInode(this.inode, pathMetadata)) {
        throw new LinuxReleaseBridgeError("stage");
      }
    }
  }

  async #openExclusive(name: string): Promise<FileHandle> {
    await this.#assertDirectory();
    let handle: FileHandle;
    try {
      handle = await open(
        this.#childPath(name),
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      throw new LinuxReleaseBridgeError("stage");
    }
    this.#created.add(name);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== this.request.target.uid ||
      metadata.gid !== this.request.target.gid ||
      modeOf(metadata) !== 0o600 ||
      metadata.nlink !== 1
    ) {
      await handle.close().catch(() => undefined);
      throw new LinuxReleaseBridgeError("stage");
    }
    return handle;
  }

  public async writeReleaseFile(
    descriptor: LinuxReleaseBridgeFile,
    reader: ExactLinuxReleaseBridgeReader,
  ): Promise<void> {
    const handle = await this.#openExclusive(descriptor.name);
    const hash = createHash("sha256");
    let written = 0;
    try {
      while (written < descriptor.bytes) {
        const chunk = await reader.readFileChunk(descriptor.bytes - written);
        await writeAll(handle, chunk);
        hash.update(chunk);
        written += chunk.byteLength;
      }
      await handle.sync();
      const metadata = await handle.stat();
      if (
        written !== descriptor.bytes ||
        metadata.size !== descriptor.bytes ||
        hash.digest("hex") !== descriptor.sha256
      ) {
        throw new LinuxReleaseBridgeError("protocol");
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  public async writeMetadata(name: string, value: string): Promise<void> {
    const handle = await this.#openExclusive(name);
    try {
      await writeAll(handle, Buffer.from(value, "utf8"));
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  public async sync(): Promise<void> {
    await this.#assertDirectory();
    await this.directory.sync();
  }

  /**
   * Removes only names minted by this authority, relative to its retained
   * directory descriptor. The final nlink=0 check proves rmdir removed this
   * exact inode even if the same UID attempted a pathname swap.
   */
  public async cleanup(): Promise<void> {
    if (this.#closed) throw new LinuxReleaseBridgeError("stage");
    try {
      for (const name of [...this.#created].reverse()) {
        try {
          await unlink(this.#childPath(name));
        } catch (error) {
          if (!isMissing(error)) {
            throw new LinuxReleaseBridgeError("stage");
          }
        }
      }
      const remaining = await readdir(this.#directoryPath());
      if (remaining.length !== 0) {
        throw new LinuxReleaseBridgeError("stage");
      }
      await this.directory.sync();
      const pathMetadata = await lstat(this.stagePath);
      if (!sameInode(this.inode, pathMetadata)) {
        throw new LinuxReleaseBridgeError("stage");
      }
      await rmdir(this.stagePath);
      const removed = await this.directory.stat();
      if (
        this.options.fdDirectoryRoot !== null &&
        removed.nlink !== 0
      ) {
        throw new LinuxReleaseBridgeError("stage");
      }
      if (this.options.fdDirectoryRoot === null) {
        try {
          await lstat(this.stagePath);
          throw new LinuxReleaseBridgeError("stage");
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
    } catch (error) {
      throw error instanceof LinuxReleaseBridgeError
        ? error
        : new LinuxReleaseBridgeError("stage");
    } finally {
      this.#closed = true;
      await this.directory.close().catch(() => undefined);
    }
  }
}

const stageRequest = async (
  request: LinuxReleaseBridgeStageRequest,
  reader: ExactLinuxReleaseBridgeReader,
  options: LinuxReleaseBridgeStageOptions,
  nonce: () => string,
): Promise<{
  readonly authority: LinuxReleaseBridgeStageAuthority;
  readonly auth: LinuxReleaseBridgeAuthArmed;
  readonly encodedAuth: string;
}> => {
  const authority = await LinuxReleaseBridgeStageAuthority.create(
    request,
    options,
  );
  try {
    let totalBytes = 0;
    for (const descriptor of request.files) {
      await authority.writeReleaseFile(descriptor, reader);
      totalBytes += descriptor.bytes;
    }
    if (totalBytes !== request.totalBytes) {
      throw new LinuxReleaseBridgeError("protocol");
    }
    await authority.writeMetadata(
      LINUX_RELEASE_BRIDGE_STAGE_METADATA,
      encodeLinuxReleaseBridgeStageRequest(request),
    );
    await authority.sync();

    const bridgeNonce = nonce();
    if (!HEX_32.test(bridgeNonce)) {
      throw new LinuxReleaseBridgeError("runtime");
    }
    const auth: LinuxReleaseBridgeAuthArmed = {
      schema: LINUX_RELEASE_BRIDGE_AUTH_PROTOCOL,
      kind: "AUTH_ARMED",
      transactionId: request.transactionId,
      providerNonce: request.providerNonce,
      bridgeNonce,
      target: request.target,
      candidate: request.candidate,
      totalBytes: request.totalBytes,
    };
    const encodedAuth = encodeLinuxReleaseBridgeAuthArmed(auth);
    await authority.writeMetadata(
      LINUX_RELEASE_BRIDGE_AUTH_METADATA,
      encodedAuth,
    );
    await authority.sync();
    return { authority, auth, encodedAuth };
  } catch (error) {
    await authority.cleanup().catch(() => undefined);
    throw error instanceof LinuxReleaseBridgeError
      ? error
      : new LinuxReleaseBridgeError("stage");
  }
};

const exactInstallerReceipt = (
  line: Buffer,
): LinuxReleaseInstallerReceipt => {
  if (
    line.byteLength === 0 ||
    line.byteLength > MAX_CHILD_LINE_BYTES ||
    line.includes(0x00) ||
    line.includes(0x0d)
  ) {
    throw new LinuxReleaseBridgeError("protocol");
  }
  let receipt: LinuxReleaseInstallerReceipt;
  try {
    receipt = decodeLinuxReleaseInstallerReceipt(
      JSON.parse(line.toString("utf8")),
    );
  } catch {
    throw new LinuxReleaseBridgeError("protocol");
  }
  const canonical = Buffer.from(
    encodeLinuxReleaseInstallerReceipt(receipt),
    "utf8",
  );
  if (
    canonical.byteLength !== line.byteLength + 1 ||
    !canonical.subarray(0, line.byteLength).equals(line)
  ) {
    throw new LinuxReleaseBridgeError("protocol");
  }
  return receipt;
};

const relayChildStdout = async (
  source: AsyncIterable<Uint8Array>,
  emit: (record: string) => Promise<void>,
  onRootArmed: () => void,
): Promise<ChildTranscript> => {
  let buffered = Buffer.alloc(0);
  let totalBytes = 0;
  let phase: "await-root" | "await-ready" | "await-terminal" | "terminal" =
    "await-root";
  let rootArmed = false;
  let terminal: LinuxReleaseInstallerReceipt | null = null;

  for await (const raw of source) {
    const chunk = Buffer.from(raw);
    totalBytes += chunk.byteLength;
    if (totalBytes > MAX_CHILD_STDOUT_BYTES) {
      throw new LinuxReleaseBridgeError("protocol");
    }
    buffered = Buffer.concat([buffered, chunk]);
    if (
      buffered.byteLength > MAX_CHILD_LINE_BYTES &&
      !buffered.includes(0x0a)
    ) {
      throw new LinuxReleaseBridgeError("protocol");
    }
    for (;;) {
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) break;
      const line = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      const receipt = exactInstallerReceipt(line);

      if (!receipt.ok) {
        if (phase === "terminal") {
          throw new LinuxReleaseBridgeError("protocol");
        }
        terminal = receipt;
        phase = "terminal";
      } else if (phase === "await-root" && receipt.state === "root-armed") {
        rootArmed = true;
        phase = "await-ready";
        onRootArmed();
      } else if (phase === "await-ready" && receipt.state === "root-ready") {
        phase = "await-terminal";
      } else if (phase === "await-terminal" && receipt.state === "ready") {
        terminal = receipt;
        phase = "terminal";
      } else {
        throw new LinuxReleaseBridgeError("protocol");
      }
      await emit(`${line.toString("utf8")}\n`);
    }
  }
  if (buffered.byteLength !== 0) {
    throw new LinuxReleaseBridgeError("protocol");
  }
  return Object.freeze({ rootArmed, terminal });
};

const drainChildStderr = async (
  source: AsyncIterable<Uint8Array>,
): Promise<number> => {
  let bytes = 0;
  for await (const raw of source) {
    bytes += raw.byteLength;
    if (bytes > MAX_CHILD_STDERR_BYTES) {
      throw new LinuxReleaseBridgeError("runtime");
    }
  }
  return bytes;
};

const cleanupReason = (
  transcript: ChildTranscript,
): LinuxReleaseBridgeCleanupReason => {
  if (!transcript.rootArmed && transcript.terminal?.ok === false) {
    return "installer-refused";
  }
  if (!transcript.rootArmed) return "authorization-failed";
  if (transcript.terminal !== null) return "installer-terminal";
  return "interrupted";
};

const cleanupReceipt = (
  auth: LinuxReleaseBridgeAuthArmed,
  reason: LinuxReleaseBridgeCleanupReason,
): LinuxReleaseBridgeStageCleared => ({
  schema: LINUX_RELEASE_BRIDGE_CLEAN_PROTOCOL,
  kind: "STAGE_CLEARED",
  transactionId: auth.transactionId,
  providerNonce: auth.providerNonce,
  bridgeNonce: auth.bridgeNonce,
  target: auth.target,
  candidate: auth.candidate,
  totalBytes: auth.totalBytes,
  reason,
  cleanup: {
    files: "cleared",
    directory: "removed",
  },
});

const stopChild = async (child: LinuxReleaseBridgeChild): Promise<void> => {
  child.terminate();
  let force: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => child.kill(),
    TERMINATE_GRACE_MS,
  );
  try {
    await child.exited.catch(() => undefined);
  } finally {
    if (force !== undefined) {
      clearTimeout(force);
      force = undefined;
    }
  }
};

export const runLinuxReleaseBridge = async (
  options: LinuxReleaseBridgeRunOptions,
): Promise<void> => {
  const reader = new ExactLinuxReleaseBridgeReader(options.input);
  const request = await reader.readHeader();
  validateInvocation(options.invocation, request);
  const staged = await stageRequest(
    request,
    reader,
    options.stage,
    options.nonce,
  );
  let child: LinuxReleaseBridgeChild | undefined;
  let authorizationTimer: ReturnType<typeof setTimeout> | undefined;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let authorizationExpired = false;
  try {
    await options.emit(staged.encodedAuth);
    child = options.spawnSudo();
    const timeout = options.authorizationTimeoutMs ??
      AUTHORIZATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) {
      throw new LinuxReleaseBridgeError("runtime");
    }
    authorizationTimer = setTimeout(() => {
      authorizationExpired = true;
      child?.terminate();
      forceTimer = setTimeout(
        () => child?.kill(),
        TERMINATE_GRACE_MS,
      );
    }, timeout);
    const transcriptPromise = relayChildStdout(
      child.stdout,
      options.emit,
      () => {
        if (authorizationTimer !== undefined) {
          clearTimeout(authorizationTimer);
          authorizationTimer = undefined;
        }
      },
    );
    const stderrPromise = drainChildStderr(child.stderr);
    const [transcript, stderrBytes, exitCode] = await Promise.all([
      transcriptPromise,
      stderrPromise,
      child.exited,
    ]);
    if (authorizationTimer !== undefined) {
      clearTimeout(authorizationTimer);
      authorizationTimer = undefined;
    }
    if (forceTimer !== undefined) {
      clearTimeout(forceTimer);
      forceTimer = undefined;
    }
    const reason = cleanupReason(transcript);
    if (
      (transcript.terminal !== null && exitCode !== 0) ||
      (transcript.rootArmed && stderrBytes !== 0) ||
      (authorizationExpired && reason !== "authorization-failed")
    ) {
      throw new LinuxReleaseBridgeError("runtime");
    }
    await staged.authority.cleanup();
    await options.emit(
      encodeLinuxReleaseBridgeStageCleared(
        cleanupReceipt(staged.auth, reason),
      ),
    );
  } catch (error) {
    if (authorizationTimer !== undefined) clearTimeout(authorizationTimer);
    if (forceTimer !== undefined) clearTimeout(forceTimer);
    if (child !== undefined) await stopChild(child);
    await staged.authority.cleanup().catch(() => undefined);
    throw error instanceof LinuxReleaseBridgeError
      ? error
      : new LinuxReleaseBridgeError("runtime");
  }
};

export const spawnFixedLinuxReleaseSudo = (): LinuxReleaseBridgeChild => {
  const child = spawn(
    LINUX_RELEASE_BRIDGE_SUDO,
    [...LINUX_RELEASE_BRIDGE_SUDO_ARGV.slice(1)],
    {
      argv0: LINUX_RELEASE_BRIDGE_SUDO_ARGV[0],
      cwd: "/",
      env: { ...LINUX_RELEASE_BRIDGE_EXEC_ENV },
      shell: false,
      windowsHide: true,
      stdio: ["inherit", "pipe", "pipe"],
    },
  );
  if (child.stdout === null || child.stderr === null) {
    child.kill("SIGKILL");
    throw new LinuxReleaseBridgeError("runtime");
  }
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", () => reject(new LinuxReleaseBridgeError("runtime")));
    child.once("close", (code, signal) => {
      resolve(code ?? (signal === null ? 1 : 128));
    });
  });
  return Object.freeze({
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    terminate: () => {
      child.kill("SIGTERM");
    },
    kill: () => {
      child.kill("SIGKILL");
    },
  });
};

const emit = (record: string): Promise<void> =>
  new Promise((resolve, reject) => {
    process.stdout.write(record, (error) => {
      if (error !== null && error !== undefined) {
        reject(new LinuxReleaseBridgeError("runtime"));
        return;
      }
      resolve();
    });
  });

if (import.meta.main) {
  try {
    process.umask(0o077);
    await verifyInstalledLinuxReleaseBridge();
    await runLinuxReleaseBridge({
      invocation: deriveLinuxReleaseBridgeInvocation(),
      input: directStdin,
      stage: {
        root: LINUX_RELEASE_BRIDGE_STAGE_ROOT,
        rootUid: 0,
        rootGid: 0,
        rootMode: 0o1733,
        fdDirectoryRoot: "/proc/self/fd",
      },
      nonce: () => randomBytes(16).toString("hex"),
      emit,
      spawnSudo: spawnFixedLinuxReleaseSudo,
    });
  } catch (error) {
    const code = error instanceof LinuxReleaseBridgeError
      ? error.code
      : "runtime";
    process.stderr.write(`vellum release bridge refused: ${code}\n`);
    process.exitCode = 1;
  }
}
