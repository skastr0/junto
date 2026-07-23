import { randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  type Stats,
} from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import path from "node:path";
import {
  LINUX_RELEASE_FENCE_DIRECTORY,
  LINUX_RELEASE_FENCE_PATH,
  encodeLinuxReleaseFence,
  type LinuxReleaseFence,
} from "../src/shared/linux-release-fence";
import {
  TERM_MAX_FRAME_BYTES,
  decodeTermMaintenanceAcquirePayload,
  decodeTermMaintenanceFencePayload,
  decodeTermMaintenanceReleasePayload,
  type TermControlResponse,
  type TermMaintenanceQuiescenceEvidence,
} from "../src/shared/term-control";
import type { LinuxReleaseInstallerTarget } from
  "../src/shared/linux-release-installer";

const TOKEN = /^[0-9a-f]{64}\n$/u;
const GENERATION = /^[0-9a-f]{32}$/u;
const START_TICKS = /^(0|[1-9][0-9]{0,19})$/u;
const REQUEST_TIMEOUT_MS = 5_000;

const modeOf = (metadata: Stats): number => metadata.mode & 0o777;

const sameInode = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const exactObject = (
  value: unknown,
  keys: ReadonlyArray<string>,
): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
};

const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(
    directory,
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

const boundedFile = async (
  file: string,
  uid: number,
  gid: number,
  mode: number,
  maximum: number,
): Promise<{ readonly bytes: Buffer; readonly metadata: Stats }> => {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.uid !== uid ||
      before.gid !== gid ||
      modeOf(before) !== mode ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > maximum
    ) {
      throw new Error("fixed control file metadata is unsafe");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameInode(before, after) || after.size !== bytes.length) {
      throw new Error("fixed control file changed while reading");
    }
    return { bytes, metadata: after };
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const assertOwnedDirectory = async (
  directory: string,
  uid: number,
  gid: number,
  mode: number,
): Promise<Stats> => {
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    metadata.gid !== gid ||
    modeOf(metadata) !== mode ||
    await realpath(directory) !== path.resolve(directory)
  ) {
    throw new Error("fixed control directory metadata is unsafe");
  }
  return metadata;
};

const connectUnix = (socketPath: string, timeoutMs: number): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("fixed TermControl socket timed out"));
    }, timeoutMs);
    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });

class ExactTermConnection {
  readonly #socket: Socket;
  #buffer = "";
  #closed = false;
  readonly #frames: unknown[] = [];
  readonly #waiters: Array<{
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }> = [];

  public constructor(socket: Socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (this.#closed) return;
      this.#buffer += chunk;
      if (Buffer.byteLength(this.#buffer, "utf8") > TERM_MAX_FRAME_BYTES) {
        this.#fail(new Error("TermControl response is oversized"));
        return;
      }
      for (;;) {
        const newline = this.#buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line.length === 0 || line.includes("\r") || line.includes("\0")) {
          this.#fail(new Error("TermControl response is malformed"));
          return;
        }
        let frame: unknown;
        try {
          frame = JSON.parse(line);
        } catch {
          this.#fail(new Error("TermControl response is not JSON"));
          return;
        }
        const waiter = this.#waiters.shift();
        if (waiter === undefined) this.#frames.push(frame);
        else {
          clearTimeout(waiter.timer);
          waiter.resolve(frame);
        }
      }
    });
    const close = (): void => {
      this.#fail(new Error("TermControl socket closed"));
    };
    socket.once("close", close);
    socket.once("error", close);
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  async #write(value: unknown): Promise<void> {
    if (this.#closed || this.#socket.destroyed) {
      throw new Error("TermControl socket is closed");
    }
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line, "utf8") > TERM_MAX_FRAME_BYTES) {
      throw new Error("TermControl request is oversized");
    }
    await new Promise<void>((resolve, reject) => {
      this.#socket.write(line, (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    });
  }

  #read(timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const queued = this.#frames.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#closed) {
      return Promise.reject(new Error("TermControl socket is closed"));
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          this.#fail(new Error("TermControl response timed out"));
          reject(new Error("TermControl response timed out"));
        }, timeoutMs),
      };
      this.#waiters.push(waiter);
    });
  }

  public async authenticate(token: string): Promise<void> {
    await this.#write({ token });
    const response = await this.#read();
    if (
      !exactObject(response, ["v", "id", "ok"]) ||
      response.v !== 1 ||
      response.id !== "auth" ||
      response.ok !== true
    ) {
      throw new Error("TermControl authentication failed");
    }
  }

  public async call(
    op: "maintenance.acquire" | "maintenance.fence" | "maintenance.release",
  ): Promise<TermControlResponse> {
    const id = randomBytes(8).toString("hex");
    await this.#write({ v: 1, id, op });
    const response = await this.#read();
    if (
      !exactObject(
        response,
        response !== null &&
          typeof response === "object" &&
          (response as { readonly ok?: unknown }).ok === true
          ? ["v", "id", "ok", "data"]
          : ["v", "id", "ok", "error"],
      ) ||
      response.v !== 1 ||
      response.id !== id ||
      typeof response.ok !== "boolean" ||
      (response.ok === false && typeof response.error !== "string")
    ) {
      throw new Error("TermControl response binding is invalid");
    }
    return response as TermControlResponse;
  }

  public close(): void {
    this.#fail(new Error("TermControl connection released"));
  }
}

export interface LinuxReleaseTermPeerObservation {
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
  readonly startTicks: string;
  readonly generation: string;
  readonly invocationId: string;
}

export type ValidateLinuxReleaseTermPeer = (
  socket: Socket,
  target: LinuxReleaseInstallerTarget,
) => Promise<LinuxReleaseTermPeerObservation>;

export interface LinuxReleaseFenceControlPaths {
  readonly targetHome: string;
  readonly fenceDirectory?: string;
  readonly fencePath?: string;
}

interface ValidatedTermControlPaths {
  readonly socketPath: string;
  readonly socketMetadata: Stats;
  readonly token: string;
  readonly tokenMetadata: Stats;
}

export interface LinuxReleaseFenceAuthority {
  readonly record: LinuxReleaseFence;
  readonly device: string;
  readonly inode: string;
}

interface FenceAuthorityState {
  readonly encoded: string;
  readonly directory: string;
  readonly activePath: string;
  pendingPath: string | null;
  readonly metadata: Stats;
  published: boolean;
  cleared: boolean;
}

const fenceAuthorities = new WeakMap<
  LinuxReleaseFenceAuthority,
  FenceAuthorityState
>();

export interface LinuxReleaseMaintenanceLease {
  readonly evidence: TermMaintenanceQuiescenceEvidence;
  readonly peer: LinuxReleaseTermPeerObservation;
  readonly tokenDevice: string;
  readonly tokenInode: string;
  readonly acknowledge: (
    authority: LinuxReleaseFenceAuthority,
  ) => Promise<void>;
  readonly release: () => Promise<void>;
}

export interface LinuxReleaseFenceControllerOptions {
  readonly paths: LinuxReleaseFenceControlPaths;
  readonly target: LinuxReleaseInstallerTarget;
  readonly rootUid?: number;
  readonly rootGid?: number;
  readonly validatePeer: ValidateLinuxReleaseTermPeer;
  readonly timeoutMs?: number;
}

export class LinuxReleaseFenceController {
  readonly #paths: Required<LinuxReleaseFenceControlPaths>;
  readonly #target: LinuxReleaseInstallerTarget;
  readonly #rootUid: number;
  readonly #rootGid: number;
  readonly #validatePeer: ValidateLinuxReleaseTermPeer;
  readonly #timeoutMs: number;

  public constructor(options: LinuxReleaseFenceControllerOptions) {
    this.#paths = {
      targetHome: path.resolve(options.paths.targetHome),
      fenceDirectory: path.resolve(
        options.paths.fenceDirectory ?? LINUX_RELEASE_FENCE_DIRECTORY,
      ),
      fencePath: path.resolve(
        options.paths.fencePath ?? LINUX_RELEASE_FENCE_PATH,
      ),
    };
    if (
      path.dirname(this.#paths.fencePath) !== this.#paths.fenceDirectory
    ) {
      throw new Error("release fence path escapes its fixed directory");
    }
    this.#target = options.target;
    this.#rootUid = options.rootUid ?? 0;
    this.#rootGid = options.rootGid ?? 0;
    this.#validatePeer = options.validatePeer;
    this.#timeoutMs = Math.min(
      REQUEST_TIMEOUT_MS,
      Math.max(1, options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    );
  }

  async #validateControlPaths(): Promise<ValidatedTermControlPaths> {
    const vellum = path.join(this.#paths.targetHome, ".vellum");
    const term = path.join(vellum, "term");
    const socketPath = path.join(term, "control.sock");
    const tokenPath = path.join(term, "token");
    const home = await lstat(this.#paths.targetHome);
    if (
      !home.isDirectory() ||
      home.isSymbolicLink() ||
      home.uid !== this.#target.uid ||
      await realpath(this.#paths.targetHome) !== this.#paths.targetHome
    ) {
      throw new Error("target home is not exact");
    }
    await assertOwnedDirectory(vellum, this.#target.uid, this.#target.gid, 0o700);
    await assertOwnedDirectory(term, this.#target.uid, this.#target.gid, 0o700);
    const socketMetadata = await lstat(socketPath);
    if (
      !socketMetadata.isSocket() ||
      socketMetadata.isSymbolicLink() ||
      socketMetadata.uid !== this.#target.uid ||
      socketMetadata.gid !== this.#target.gid ||
      modeOf(socketMetadata) !== 0o600
    ) {
      throw new Error("fixed TermControl socket metadata is unsafe");
    }
    const token = await boundedFile(
      tokenPath,
      this.#target.uid,
      this.#target.gid,
      0o600,
      65,
    );
    const text = token.bytes.toString("utf8");
    if (!TOKEN.test(text)) {
      throw new Error("fixed TermControl token is malformed");
    }
    return {
      socketPath,
      socketMetadata,
      token: text.slice(0, -1),
      tokenMetadata: token.metadata,
    };
  }

  async #revalidateConnectedPaths(
    captured: ValidatedTermControlPaths,
  ): Promise<void> {
    const socket = await lstat(captured.socketPath);
    const token = await lstat(path.join(
      this.#paths.targetHome,
      ".vellum",
      "term",
      "token",
    ));
    if (
      !sameInode(socket, captured.socketMetadata) ||
      !sameInode(token, captured.tokenMetadata)
    ) {
      throw new Error("TermControl path changed during admission");
    }
  }

  public async acquire(): Promise<LinuxReleaseMaintenanceLease> {
    const captured = await this.#validateControlPaths();
    const socket = await connectUnix(captured.socketPath, this.#timeoutMs);
    let connection: ExactTermConnection | undefined;
    try {
      const peer = await this.#validatePeer(socket, this.#target);
      if (
        !Number.isSafeInteger(peer.pid) ||
        peer.pid < 1 ||
        peer.uid !== this.#target.uid ||
        peer.gid !== this.#target.gid ||
        !START_TICKS.test(peer.startTicks) ||
        !GENERATION.test(peer.generation) ||
        peer.invocationId !== peer.generation
      ) {
        throw new Error("TermControl peer observation is malformed");
      }
      await this.#revalidateConnectedPaths(captured);
      connection = new ExactTermConnection(socket);
      await connection.authenticate(captured.token);
      const response = await connection.call("maintenance.acquire");
      if (!response.ok) throw new Error(response.error);
      const acquisition = decodeTermMaintenanceAcquirePayload(response.data);
      if (acquisition === undefined || !acquisition.acquired) {
        throw new Error("TermControl maintenance is not quiescent");
      }
      let released = false;
      const assertPeer = async (): Promise<void> => {
        const current = await this.#validatePeer(socket, this.#target);
        if (
          current.pid !== peer.pid ||
          current.uid !== peer.uid ||
          current.gid !== peer.gid ||
          current.startTicks !== peer.startTicks ||
          current.generation !== peer.generation ||
          current.invocationId !== peer.invocationId
        ) {
          throw new Error("TermControl peer generation changed");
        }
      };
      const lease: LinuxReleaseMaintenanceLease = Object.freeze({
        evidence: Object.freeze(acquisition.evidence),
        peer: Object.freeze(peer),
        tokenDevice: captured.tokenMetadata.dev.toString(),
        tokenInode: captured.tokenMetadata.ino.toString(),
        acknowledge: async (authority: LinuxReleaseFenceAuthority) => {
          const state = fenceAuthorities.get(authority);
          if (
            released ||
            state === undefined ||
            !state.published ||
            state.cleared
          ) {
            throw new Error("release fence authority is not published");
          }
          await assertPeer();
          await this.assertExact(authority);
          const receipt = await connection!.call("maintenance.fence");
          if (!receipt.ok) throw new Error(receipt.error);
          const payload = decodeTermMaintenanceFencePayload(receipt.data);
          if (
            payload === undefined ||
            payload.evidence.observationId !==
              acquisition.evidence.observationId ||
            encodeLinuxReleaseFence(payload.fence) !== state.encoded
          ) {
            throw new Error("TermControl fence acknowledgment is not exact");
          }
          await assertPeer();
        },
        release: async () => {
          if (released) return;
          released = true;
          try {
            const receipt = await connection!.call("maintenance.release");
            if (!receipt.ok) throw new Error(receipt.error);
            const payload = decodeTermMaintenanceReleasePayload(receipt.data);
            if (payload?.released !== true) {
              throw new Error("TermControl maintenance release was ambiguous");
            }
          } finally {
            connection!.close();
          }
        },
      });
      return lease;
    } catch (error) {
      connection?.close();
      socket.destroy();
      throw error;
    }
  }

  async #ensureFenceDirectory(): Promise<void> {
    let created = false;
    try {
      // A private, recognizable intermediate mode makes a crash between
      // mkdir(2) and publication repairable without accepting arbitrary
      // pre-existing directory metadata.
      await mkdir(this.#paths.fenceDirectory, { mode: 0o700 });
      created = true;
      await syncDirectory(path.dirname(this.#paths.fenceDirectory));
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        (error as { readonly code?: unknown }).code !== "EEXIST"
      ) {
        throw error;
      }
    }
    const metadata = await lstat(this.#paths.fenceDirectory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== this.#rootUid ||
      metadata.gid !== this.#rootGid ||
      await realpath(this.#paths.fenceDirectory) !==
        this.#paths.fenceDirectory
    ) {
      throw new Error("fixed control directory metadata is unsafe");
    }
    const mode = modeOf(metadata);
    if (mode === 0o700) {
      if ((await readdir(this.#paths.fenceDirectory)).length !== 0) {
        throw new Error("partial release fence directory is not empty");
      }
      await chmod(this.#paths.fenceDirectory, 0o755);
      await syncDirectory(path.dirname(this.#paths.fenceDirectory));
    } else if (mode !== 0o755 || created) {
      throw new Error("fixed control directory metadata is unsafe");
    }
    await assertOwnedDirectory(
      this.#paths.fenceDirectory,
      this.#rootUid,
      this.#rootGid,
      0o755,
    );
  }

  public async prepare(
    record: LinuxReleaseFence,
  ): Promise<LinuxReleaseFenceAuthority> {
    await this.#ensureFenceDirectory();
    if ((await readdir(this.#paths.fenceDirectory)).length !== 0) {
      throw new Error("release fence directory is not empty");
    }
    try {
      await lstat(this.#paths.fencePath);
      throw new Error("release fence is already occupied");
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        (error as { readonly code?: unknown }).code !== "ENOENT"
      ) {
        throw error;
      }
    }
    const encoded = encodeLinuxReleaseFence(record);
    const pendingPath = path.join(
      this.#paths.fenceDirectory,
      `.pending-${record.fenceId}`,
    );
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        pendingPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o400,
      );
      await handle.chown(this.#rootUid, this.#rootGid);
      await handle.chmod(0o444);
      await handle.writeFile(encoded, "utf8");
      await handle.sync();
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.uid !== this.#rootUid ||
        metadata.gid !== this.#rootGid ||
        modeOf(metadata) !== 0o444 ||
        metadata.nlink !== 1 ||
        metadata.size !== Buffer.byteLength(encoded, "utf8")
      ) {
        throw new Error("prepared release fence metadata is unsafe");
      }
      await handle.close();
      handle = undefined;
      await syncDirectory(this.#paths.fenceDirectory);
      const authority: LinuxReleaseFenceAuthority = Object.freeze({
        record,
        device: metadata.dev.toString(),
        inode: metadata.ino.toString(),
      });
      fenceAuthorities.set(authority, {
        encoded,
        directory: this.#paths.fenceDirectory,
        activePath: this.#paths.fencePath,
        pendingPath,
        metadata,
        published: false,
        cleared: false,
      });
      return authority;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(pendingPath).catch(() => undefined);
      await syncDirectory(this.#paths.fenceDirectory).catch(() => undefined);
      throw error;
    }
  }

  public async publish(authority: LinuxReleaseFenceAuthority): Promise<void> {
    const state = fenceAuthorities.get(authority);
    if (state === undefined || state.published || state.cleared) {
      throw new Error("prepared release fence authority is invalid");
    }
    if (state.pendingPath === null) {
      throw new Error("prepared release fence has no pending inode");
    }
    const pending = await lstat(state.pendingPath);
    if (
      !sameInode(pending, state.metadata) ||
      pending.nlink !== 1 ||
      modeOf(pending) !== 0o444
    ) {
      throw new Error("prepared release fence changed before publication");
    }
    await link(state.pendingPath, state.activePath);
    state.published = true;
    try {
      await unlink(state.pendingPath);
      state.pendingPath = null;
      await syncDirectory(state.directory);
      await this.assertExact(authority);
    } catch (error) {
      // The active link is deliberately retained on ambiguous publication.
      throw error;
    }
  }

  public async assertExact(
    authority: LinuxReleaseFenceAuthority,
  ): Promise<void> {
    const state = fenceAuthorities.get(authority);
    if (state === undefined || !state.published || state.cleared) {
      throw new Error("published release fence authority is invalid");
    }
    const file = await boundedFile(
      state.activePath,
      this.#rootUid,
      this.#rootGid,
      0o444,
      Buffer.byteLength(state.encoded, "utf8"),
    );
    if (
      !sameInode(file.metadata, state.metadata) ||
      file.bytes.toString("utf8") !== state.encoded
    ) {
      throw new Error("published release fence is not exact");
    }
  }

  public async discardPrepared(
    authority: LinuxReleaseFenceAuthority,
  ): Promise<void> {
    const state = fenceAuthorities.get(authority);
    if (
      state === undefined ||
      state.published ||
      state.cleared
    ) {
      throw new Error("prepared release fence authority cannot be discarded");
    }
    if (state.pendingPath === null) {
      throw new Error("prepared release fence has no pending inode");
    }
    const pending = await lstat(state.pendingPath);
    if (!sameInode(pending, state.metadata) || pending.nlink !== 1) {
      throw new Error("prepared release fence changed before discard");
    }
    await unlink(state.pendingPath);
    await syncDirectory(state.directory);
    state.cleared = true;
  }

  async #preparedCandidate(
    candidate: string,
    encoded: string,
  ): Promise<{ readonly bytes: Buffer; readonly metadata: Stats } | null> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        candidate,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.uid !== this.#rootUid ||
        before.gid !== this.#rootGid ||
        modeOf(before) !== 0o444 ||
        (before.nlink !== 1 && before.nlink !== 2) ||
        before.size !== Buffer.byteLength(encoded, "utf8")
      ) {
        throw new Error("prepared release fence metadata is unsafe");
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      const pathname = await lstat(candidate);
      if (
        !sameInode(before, after) ||
        !sameInode(before, pathname) ||
        after.size !== bytes.length ||
        bytes.toString("utf8") !== encoded
      ) {
        throw new Error("prepared release fence changed while reading");
      }
      return { bytes, metadata: after };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { readonly code?: unknown }).code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #recoverIntent(
    record: LinuxReleaseFence,
  ): Promise<{
    readonly state: "pending" | "absent";
    readonly authority?: LinuxReleaseFenceAuthority;
  }> {
    await this.#ensureFenceDirectory();
    const encoded = encodeLinuxReleaseFence(record);
    const expected = Buffer.from(encoded, "utf8");
    const pendingName = `.pending-${record.fenceId}`;
    const pendingPath = path.join(this.#paths.fenceDirectory, pendingName);
    const entries = (await readdir(this.#paths.fenceDirectory)).sort();
    if (entries.length === 0) return { state: "absent" };
    if (entries.length !== 1 || entries[0] !== pendingName) {
      throw new Error("release fence intent topology is ambiguous");
    }

    let handle: FileHandle | undefined;
    let metadata: Stats;
    let bytes: Buffer;
    try {
      handle = await open(
        pendingPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      const before = await handle.stat();
      const mode = modeOf(before);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.uid !== this.#rootUid ||
        before.gid !== this.#rootGid ||
        (mode !== 0o400 && mode !== 0o444) ||
        before.nlink !== 1 ||
        before.size < 0 ||
        before.size > expected.length
      ) {
        throw new Error("partial release fence metadata is unsafe");
      }
      bytes = await handle.readFile();
      const after = await handle.stat();
      const pathname = await lstat(pendingPath);
      if (
        !sameInode(before, after) ||
        !sameInode(before, pathname) ||
        after.size !== bytes.length ||
        !expected.subarray(0, bytes.length).equals(bytes)
      ) {
        throw new Error("partial release fence changed while reading");
      }
      metadata = after;
    } finally {
      await handle?.close().catch(() => undefined);
    }

    if (modeOf(metadata) === 0o444 && bytes.equals(expected)) {
      const authority: LinuxReleaseFenceAuthority = Object.freeze({
        record,
        device: metadata.dev.toString(),
        inode: metadata.ino.toString(),
      });
      fenceAuthorities.set(authority, {
        encoded,
        directory: this.#paths.fenceDirectory,
        activePath: this.#paths.fencePath,
        pendingPath,
        metadata,
        published: false,
        cleared: false,
      });
      return { state: "pending", authority };
    }

    const pathname = await lstat(pendingPath);
    if (!sameInode(pathname, metadata) || pathname.nlink !== 1) {
      throw new Error("partial release fence changed before discard");
    }
    await unlink(pendingPath);
    await syncDirectory(this.#paths.fenceDirectory);
    return { state: "absent" };
  }

  public async observePrepared(
    record: LinuxReleaseFence,
    device: string | null,
    inode: string | null,
  ): Promise<{
    readonly state: "pending" | "published" | "both" | "absent";
    readonly authority?: LinuxReleaseFenceAuthority;
  }> {
    if (device === null && inode === null) {
      return await this.#recoverIntent(record);
    }
    try {
      await assertOwnedDirectory(
        this.#paths.fenceDirectory,
        this.#rootUid,
        this.#rootGid,
        0o755,
      );
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        (error as { readonly code?: unknown }).code !== "ENOENT" ||
        device !== null ||
        inode !== null
      ) {
        throw error;
      }
      await syncDirectory(path.dirname(this.#paths.fenceDirectory));
      try {
        await lstat(this.#paths.fenceDirectory);
        throw new Error("release fence directory appeared during recovery");
      } catch (secondError) {
        if (
          typeof secondError === "object" &&
          secondError !== null &&
          "code" in secondError &&
          (secondError as { readonly code?: unknown }).code === "ENOENT"
        ) {
          return { state: "absent" };
        }
        throw secondError;
      }
    }
    const encoded = encodeLinuxReleaseFence(record);
    const pendingPath = path.join(
      this.#paths.fenceDirectory,
      `.pending-${record.fenceId}`,
    );
    const [active, pending] = await Promise.all([
      this.#preparedCandidate(this.#paths.fencePath, encoded),
      this.#preparedCandidate(pendingPath, encoded),
    ]);
    if (active === null && pending === null) {
      return { state: "absent" };
    }
    const file = active ?? pending!;
    if (
      (device !== null && file.metadata.dev.toString() !== device) ||
      (inode !== null && file.metadata.ino.toString() !== inode)
    ) {
      throw new Error("prepared release fence differs from its journal");
    }
    if (
      active !== null &&
      pending !== null &&
      (!sameInode(active.metadata, pending.metadata) ||
        active.metadata.nlink !== 2 ||
        pending.metadata.nlink !== 2)
    ) {
      throw new Error("prepared release fence topology is ambiguous");
    }
    const authority: LinuxReleaseFenceAuthority = Object.freeze({
      record,
      device: file.metadata.dev.toString(),
      inode: file.metadata.ino.toString(),
    });
    fenceAuthorities.set(authority, {
      encoded,
      directory: this.#paths.fenceDirectory,
      activePath: this.#paths.fencePath,
      pendingPath: pending === null ? null : pendingPath,
      metadata: file.metadata,
      published: active !== null,
      cleared: false,
    });
    return {
      state: active !== null && pending !== null
        ? "both"
        : active !== null
        ? "published"
        : "pending",
      authority,
    };
  }

  public async normalizePrepared(
    authority: LinuxReleaseFenceAuthority,
  ): Promise<"pending" | "published"> {
    const state = fenceAuthorities.get(authority);
    if (state === undefined || state.cleared) {
      throw new Error("prepared release fence authority is invalid");
    }
    if (!state.published) return "pending";
    if (state.pendingPath !== null) {
      const [active, pending] = await Promise.all([
        lstat(state.activePath),
        lstat(state.pendingPath),
      ]);
      if (
        !sameInode(active, state.metadata) ||
        !sameInode(pending, state.metadata) ||
        active.nlink !== 2 ||
        pending.nlink !== 2
      ) {
        throw new Error("prepared release fence links changed");
      }
      await unlink(state.pendingPath);
      await syncDirectory(state.directory);
      state.pendingPath = null;
    }
    await this.assertExact(authority);
    return "published";
  }

  public async adoptPublished(
    record: LinuxReleaseFence,
    device: string,
    inode: string,
  ): Promise<LinuxReleaseFenceAuthority> {
    await assertOwnedDirectory(
      this.#paths.fenceDirectory,
      this.#rootUid,
      this.#rootGid,
      0o755,
    );
    const encoded = encodeLinuxReleaseFence(record);
    const file = await boundedFile(
      this.#paths.fencePath,
      this.#rootUid,
      this.#rootGid,
      0o444,
      Buffer.byteLength(encoded, "utf8"),
    );
    if (
      file.metadata.dev.toString() !== device ||
      file.metadata.ino.toString() !== inode ||
      file.bytes.toString("utf8") !== encoded
    ) {
      throw new Error("durable release fence differs from its journal");
    }
    const authority: LinuxReleaseFenceAuthority = Object.freeze({
      record,
      device,
      inode,
    });
    fenceAuthorities.set(authority, {
      encoded,
      directory: this.#paths.fenceDirectory,
      activePath: this.#paths.fencePath,
      pendingPath: null,
      metadata: file.metadata,
      published: true,
      cleared: false,
    });
    return authority;
  }

  public async clear(
    authority: LinuxReleaseFenceAuthority,
  ): Promise<void> {
    const state = fenceAuthorities.get(authority);
    if (state === undefined || !state.published || state.cleared) {
      throw new Error("published release fence cannot be cleared");
    }
    await this.assertExact(authority);
    const pathname = await lstat(state.activePath);
    if (!sameInode(pathname, state.metadata) || pathname.nlink !== 1) {
      throw new Error("release fence path changed before clear");
    }
    await unlink(state.activePath);
    await syncDirectory(state.directory);
    try {
      await lstat(state.activePath);
      throw new Error("release fence remained after clear");
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        (error as { readonly code?: unknown }).code !== "ENOENT"
      ) {
        throw error;
      }
    }
    state.cleared = true;
  }

  public async proveAbsent(record: LinuxReleaseFence): Promise<void> {
    try {
      await assertOwnedDirectory(
        this.#paths.fenceDirectory,
        this.#rootUid,
        this.#rootGid,
        0o755,
      );
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        (error as { readonly code?: unknown }).code !== "ENOENT"
      ) {
        throw error;
      }
      await syncDirectory(path.dirname(this.#paths.fenceDirectory));
      try {
        await lstat(this.#paths.fenceDirectory);
        throw new Error("release fence directory appeared during absence proof");
      } catch (secondError) {
        if (
          typeof secondError === "object" &&
          secondError !== null &&
          "code" in secondError &&
          (secondError as { readonly code?: unknown }).code === "ENOENT"
        ) {
          return;
        }
        throw secondError;
      }
    }
    const pendingPath = path.join(
      this.#paths.fenceDirectory,
      `.pending-${record.fenceId}`,
    );
    const assertMissing = async (candidate: string): Promise<void> => {
      try {
        await lstat(candidate);
        throw new Error("release fence path unexpectedly exists");
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          (error as { readonly code?: unknown }).code !== "ENOENT"
        ) {
          throw error;
        }
      }
    };
    await assertMissing(this.#paths.fencePath);
    await assertMissing(pendingPath);
    if ((await readdir(this.#paths.fenceDirectory)).length !== 0) {
      throw new Error("release fence directory contains an orphan");
    }
    await syncDirectory(this.#paths.fenceDirectory);
    await assertMissing(this.#paths.fencePath);
    await assertMissing(pendingPath);
    if ((await readdir(this.#paths.fenceDirectory)).length !== 0) {
      throw new Error("release fence directory changed during absence proof");
    }
  }
}
