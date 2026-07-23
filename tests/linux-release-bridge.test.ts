import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LINUX_RELEASE_BRIDGE_AUTH_METADATA,
  LINUX_RELEASE_BRIDGE_AUTH_PROTOCOL,
  LINUX_RELEASE_BRIDGE_CLEAN_PROTOCOL,
  LINUX_RELEASE_BRIDGE_STAGE_METADATA,
  LINUX_RELEASE_BRIDGE_STAGE_PROTOCOL,
  decodeLinuxReleaseBridgeAuthArmed,
  decodeLinuxReleaseBridgeStageCleared,
  decodeLinuxReleaseBridgeStageRequest,
  encodeLinuxReleaseBridgeInventory,
  encodeLinuxReleaseBridgeStageCleared,
  encodeLinuxReleaseBridgeStageRequest,
  linuxReleaseBridgeStagePath,
  type LinuxReleaseBridgeFile,
  type LinuxReleaseBridgeStageRequest,
} from "../src/shared/linux-release-bridge";
import {
  LINUX_RELEASE_INSTALLER_RECEIPT,
  encodeLinuxReleaseInstallerReceipt,
  type LinuxReleaseInstallerReceipt,
} from "../src/shared/linux-release-installer";
import {
  LINUX_RELEASE_BRIDGE_EXEC_ENV,
  LINUX_RELEASE_BRIDGE_SUDO,
  LINUX_RELEASE_BRIDGE_SUDO_ARGV,
  LinuxReleaseBridgeError,
  runLinuxReleaseBridge,
  type LinuxReleaseBridgeChild,
  type LinuxReleaseBridgeInput,
  type LinuxReleaseBridgeInvocation,
  type LinuxReleaseBridgeStageOptions,
} from "../scripts/linux-release-bridge";

const uid = process.getuid?.() ?? 501;
const gid = process.getgid?.() ?? 20;
const transactionId = "12".repeat(16);
const providerNonce = "34".repeat(16);
const bridgeNonce = "56".repeat(16);
const manifest = Buffer.from("signed manifest");
const deb = Buffer.from("verified package bytes");

const digest = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

const files = (
  changes: Partial<Record<"manifest" | "deb", string>> = {},
): ReadonlyArray<LinuxReleaseBridgeFile> => [
  {
    name: "release-manifest.json",
    bytes: manifest.byteLength,
    sha256: changes.manifest ?? digest(manifest),
  },
  {
    name: "vellum.deb",
    bytes: deb.byteLength,
    sha256: changes.deb ?? digest(deb),
  },
];

const request = (
  changes: Partial<LinuxReleaseBridgeStageRequest> = {},
): LinuxReleaseBridgeStageRequest => {
  const inventoryFiles = changes.files ?? files();
  const totalBytes =
    changes.totalBytes ??
    inventoryFiles.reduce((total, file) => total + file.bytes, 0);
  const candidate = {
    version: "1.2.3",
    manifestSha256: digest(manifest),
    debSha256: digest(deb),
    inventorySha256: "00".repeat(32),
    ...changes.candidate,
  };
  const draft: LinuxReleaseBridgeStageRequest = {
    schema: LINUX_RELEASE_BRIDGE_STAGE_PROTOCOL,
    kind: "stage",
    transactionId,
    providerNonce,
    target: {
      uid,
      gid,
      host: "remote.example",
      stationId: "remote-01",
    },
    candidate,
    totalBytes,
    files: inventoryFiles,
    ...changes,
  };
  return {
    ...draft,
    candidate: {
      ...draft.candidate,
      inventorySha256: digest(encodeLinuxReleaseBridgeInventory(draft)),
    },
  };
};

class ExactBufferInput implements LinuxReleaseBridgeInput {
  #offset = 0;
  readonly requested: number[] = [];

  public constructor(readonly bytes: Buffer) {}

  public async read(maxBytes: number): Promise<Uint8Array> {
    this.requested.push(maxBytes);
    const end = Math.min(this.#offset + maxBytes, this.bytes.byteLength);
    const value = this.bytes.subarray(this.#offset, end);
    this.#offset = end;
    return value;
  }

  public remaining(): Buffer {
    return this.bytes.subarray(this.#offset);
  }
}

const invocation = (
  changes: Partial<LinuxReleaseBridgeInvocation> = {},
): LinuxReleaseBridgeInvocation => ({
  platform: "linux",
  uid,
  effectiveUid: uid,
  gid,
  effectiveGid: gid,
  arguments: [],
  environment: {},
  hostname: "remote.example",
  ...changes,
});

const roots: string[] = [];

const stageFixture = async (): Promise<{
  readonly fixture: string;
  readonly root: string;
  readonly rootMode: 0o733 | 0o1733;
}> => {
  const fixture = await mkdtemp(
    path.join(tmpdir(), "vellum-release-bridge-test-"),
  );
  roots.push(fixture);
  const root = path.join(fixture, "stage-root");
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o1733);
  const canonicalRoot = await realpath(root);
  const rootMode = (await stat(canonicalRoot)).mode & 0o7777;
  if (rootMode !== 0o733 && rootMode !== 0o1733) {
    throw new Error("test stage root mode is unsupported");
  }
  return { fixture, root: canonicalRoot, rootMode };
};

const optionsFor = (
  root: string,
  rootMode: 0o733 | 0o1733,
): LinuxReleaseBridgeStageOptions => ({
  root,
  rootUid: uid,
  rootGid: gid,
  rootMode,
  fdDirectoryRoot: null,
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const frame = (
  value: LinuxReleaseBridgeStageRequest,
  body = Buffer.concat([manifest, deb]),
  tail = Buffer.from("sudo-password\nroot-prepare-frame\n"),
): {
  readonly input: ExactBufferInput;
  readonly tail: Buffer;
} => ({
  input: new ExactBufferInput(
    Buffer.concat([
      Buffer.from(encodeLinuxReleaseBridgeStageRequest(value), "utf8"),
      body,
      tail,
    ]),
  ),
  tail,
});

const chunks = (
  records: ReadonlyArray<string | Uint8Array>,
): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    for (const record of records) {
      yield typeof record === "string"
        ? Buffer.from(record, "utf8")
        : record;
    }
  },
});

const child = (input: {
  readonly stdout?: ReadonlyArray<string | Uint8Array>;
  readonly stderr?: ReadonlyArray<string | Uint8Array>;
  readonly exitCode?: number;
  readonly onStdout?: () => Promise<void>;
} = {}): LinuxReleaseBridgeChild => ({
  stdout: {
    async *[Symbol.asyncIterator]() {
      await input.onStdout?.();
      for await (const value of chunks(input.stdout ?? [])) yield value;
    },
  },
  stderr: chunks(input.stderr ?? []),
  exited: Promise.resolve(input.exitCode ?? 0),
  terminate: () => undefined,
  kill: () => undefined,
});

const refusal = (
  transaction: string | null = null,
): Extract<LinuxReleaseInstallerReceipt, { readonly ok: false }> => ({
  schema: LINUX_RELEASE_INSTALLER_RECEIPT,
  ok: false,
  state: "refused",
  code: "protocol",
  transactionId: transaction,
  action: "send-a-new-bounded-frame",
});

describe("Linux release bridge wire", () => {
  it("round-trips only exact canonical stage, authorization, and cleanup shapes", () => {
    const value = request();
    expect(
      decodeLinuxReleaseBridgeStageRequest(
        JSON.parse(encodeLinuxReleaseBridgeStageRequest(value)),
      ),
    ).toEqual(value);
    expect(() =>
      decodeLinuxReleaseBridgeStageRequest({
        ...value,
        callerPath: "/tmp/attacker",
      }),
    ).toThrow(/unexpected fields/u);
    expect(() =>
      decodeLinuxReleaseBridgeStageRequest({
        ...value,
        files: [...value.files].reverse(),
      }),
    ).toThrow(/strictly ordered/u);
    expect(() =>
      decodeLinuxReleaseBridgeStageRequest({
        ...value,
        files: [
          {
            name: LINUX_RELEASE_BRIDGE_STAGE_METADATA,
            bytes: 1,
            sha256: "00".repeat(32),
          },
        ],
        totalBytes: 1,
      }),
    ).toThrow(/unsafe/u);

    const auth = decodeLinuxReleaseBridgeAuthArmed({
      schema: LINUX_RELEASE_BRIDGE_AUTH_PROTOCOL,
      kind: "AUTH_ARMED",
      transactionId,
      providerNonce,
      bridgeNonce,
      target: value.target,
      candidate: value.candidate,
      totalBytes: value.totalBytes,
    });
    expect(auth.bridgeNonce).toBe(bridgeNonce);
    expect(() =>
      decodeLinuxReleaseBridgeAuthArmed({ ...auth, retry: true }),
    ).toThrow(/unexpected fields/u);

    const cleanup = decodeLinuxReleaseBridgeStageCleared({
      schema: LINUX_RELEASE_BRIDGE_CLEAN_PROTOCOL,
      kind: "STAGE_CLEARED",
      transactionId,
      providerNonce,
      bridgeNonce,
      target: value.target,
      candidate: value.candidate,
      totalBytes: value.totalBytes,
      reason: "authorization-failed",
      cleanup: { files: "cleared", directory: "removed" },
    });
    expect(
      decodeLinuxReleaseBridgeStageCleared(
        JSON.parse(encodeLinuxReleaseBridgeStageCleared(cleanup)),
      ),
    ).toEqual(cleanup);
    expect(() =>
      decodeLinuxReleaseBridgeStageCleared({
        ...cleanup,
        cleanup: { files: "cleared", directory: "retained" },
      }),
    ).toThrow(/unsupported/u);
  });

  it("derives the only stage path from uid and a lowercase 32hex transaction", () => {
    expect(linuxReleaseBridgeStagePath(uid, transactionId)).toBe(
      `/var/tmp/vellum-release-bridge/u-${uid}-${transactionId}`,
    );
    expect(() =>
      linuxReleaseBridgeStagePath(uid, "../../etc/sudoers"),
    ).toThrow(/transaction/u);
  });
});

describe("unprivileged Linux release staging", () => {
  it("stages exact bytes, leaves the password unread, reaps sudo, and proves cleanup", async () => {
    const { root, rootMode } = await stageFixture();
    const value = request();
    const transfer = frame(value);
    const emitted: string[] = [];
    const stagePath = linuxReleaseBridgeStagePath(uid, transactionId, root);

    await runLinuxReleaseBridge({
      invocation: invocation(),
      input: transfer.input,
      stage: optionsFor(root, rootMode),
      nonce: () => bridgeNonce,
      emit: async (record) => {
        emitted.push(record);
      },
      spawnSudo: () =>
        child({
          exitCode: 1,
          onStdout: async () => {
            expect((await stat(stagePath)).mode & 0o7777).toBe(0o700);
            expect(
              (await stat(path.join(stagePath, value.files[0]!.name))).mode &
                0o7777,
            ).toBe(0o600);
            expect(
              await readFile(path.join(stagePath, value.files[0]!.name)),
            ).toEqual(manifest);
            expect(
              await readFile(path.join(stagePath, value.files[1]!.name)),
            ).toEqual(deb);
            expect(
              await readFile(
                path.join(stagePath, LINUX_RELEASE_BRIDGE_STAGE_METADATA),
                "utf8",
              ),
            ).toBe(encodeLinuxReleaseBridgeStageRequest(value));
            expect(
              await readFile(
                path.join(stagePath, LINUX_RELEASE_BRIDGE_AUTH_METADATA),
                "utf8",
              ),
            ).toBe(emitted[0]);
          },
        }),
    });

    expect(transfer.input.remaining()).toEqual(transfer.tail);
    expect(Math.max(...transfer.input.requested)).toBeLessThanOrEqual(64 * 1024);
    expect(emitted).toHaveLength(2);
    expect(
      decodeLinuxReleaseBridgeAuthArmed(JSON.parse(emitted[0]!)),
    ).toMatchObject({
      kind: "AUTH_ARMED",
      transactionId,
      providerNonce,
      bridgeNonce,
      target: value.target,
      candidate: value.candidate,
      totalBytes: value.totalBytes,
    });
    expect(
      decodeLinuxReleaseBridgeStageCleared(JSON.parse(emitted[1]!)),
    ).toMatchObject({
      kind: "STAGE_CLEARED",
      reason: "authorization-failed",
      transactionId,
      providerNonce,
      bridgeNonce,
      cleanup: { files: "cleared", directory: "removed" },
    });
    await expect(stat(stagePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("relays a canonical helper refusal, then proves exact stage cleanup", async () => {
    const { root, rootMode } = await stageFixture();
    const value = request();
    const emitted: string[] = [];
    await runLinuxReleaseBridge({
      invocation: invocation(),
      input: frame(value).input,
      stage: optionsFor(root, rootMode),
      nonce: () => bridgeNonce,
      emit: async (record) => {
        emitted.push(record);
      },
      spawnSudo: () =>
        child({
          stdout: [encodeLinuxReleaseInstallerReceipt(refusal(transactionId))],
        }),
    });
    expect(emitted).toHaveLength(3);
    expect(emitted[1]).toBe(
      encodeLinuxReleaseInstallerReceipt(refusal(transactionId)),
    );
    expect(
      decodeLinuxReleaseBridgeStageCleared(JSON.parse(emitted[2]!)).reason,
    ).toBe("installer-refused");
  });

  it("does not issue cleanup evidence for malformed or nonzero helper terminals", async () => {
    for (const sudoChild of [
      child({ stdout: ['{"state":"root-armed"}\n'] }),
      child({
        stdout: [encodeLinuxReleaseInstallerReceipt(refusal(transactionId))],
        exitCode: 1,
      }),
    ]) {
      const { root, rootMode } = await stageFixture();
      const emitted: string[] = [];
      await expect(
        runLinuxReleaseBridge({
          invocation: invocation(),
          input: frame(request()).input,
          stage: optionsFor(root, rootMode),
          nonce: () => bridgeNonce,
          emit: async (record) => {
            emitted.push(record);
          },
          spawnSudo: () => sudoChild,
        }),
      ).rejects.toBeInstanceOf(LinuxReleaseBridgeError);
      expect(
        emitted.some((record) => record.includes("STAGE_CLEARED")),
      ).toBe(false);
      await expect(
        stat(linuxReleaseBridgeStagePath(uid, transactionId, root)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("bounds one authorization attempt and cleans after the local deadline", async () => {
    const { root, rootMode } = await stageFixture();
    let resolveExit: ((code: number) => void) | undefined;
    let resolveStdout:
      | ((value: IteratorResult<Uint8Array>) => void)
      | undefined;
    let terminated = 0;
    const stalled: LinuxReleaseBridgeChild = {
      stdout: {
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              new Promise<IteratorResult<Uint8Array>>((resolve) => {
                resolveStdout = resolve;
              }),
          };
        },
      },
      stderr: chunks([]),
      exited: new Promise<number>((resolve) => {
        resolveExit = resolve;
      }),
      terminate: () => {
        terminated += 1;
        resolveStdout?.({ done: true, value: undefined });
        resolveExit?.(1);
      },
      kill: () => {
        resolveStdout?.({ done: true, value: undefined });
        resolveExit?.(137);
      },
    };
    const emitted: string[] = [];
    await runLinuxReleaseBridge({
      invocation: invocation(),
      input: frame(request()).input,
      stage: optionsFor(root, rootMode),
      nonce: () => bridgeNonce,
      emit: async (record) => {
        emitted.push(record);
      },
      spawnSudo: () => stalled,
      authorizationTimeoutMs: 1,
    });
    expect(terminated).toBe(1);
    expect(
      decodeLinuxReleaseBridgeStageCleared(JSON.parse(emitted.at(-1)!)).reason,
    ).toBe("authorization-failed");
  });

  it("rejects non-canonical framing before creating a stage", async () => {
    const { root, rootMode } = await stageFixture();
    const value = request();
    const input = new ExactBufferInput(
      Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
    );
    await expect(
      runLinuxReleaseBridge({
        invocation: invocation(),
        input,
        stage: optionsFor(root, rootMode),
        nonce: () => bridgeNonce,
        emit: async () => undefined,
        spawnSudo: () => child(),
      }),
    ).rejects.toMatchObject({ code: "protocol" });
    expect(await readdir(root)).toEqual([]);
  });

  it("cleans only its transaction stage on a file digest failure", async () => {
    const { root, rootMode } = await stageFixture();
    const value = request({ files: files({ manifest: "aa".repeat(32) }) });
    const transfer = frame(value);
    const foreign = path.join(root, "foreign");
    await writeFile(foreign, "preserve");
    await expect(
      runLinuxReleaseBridge({
        invocation: invocation(),
        input: transfer.input,
        stage: optionsFor(root, rootMode),
        nonce: () => bridgeNonce,
        emit: async () => {
          throw new Error("unreachable");
        },
        spawnSudo: () => child(),
      }),
    ).rejects.toMatchObject({ code: "protocol" });
    await expect(
      stat(linuxReleaseBridgeStagePath(uid, transactionId, root)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(foreign, "utf8")).resolves.toBe("preserve");
    expect(transfer.input.remaining().subarray(-transfer.tail.byteLength))
      .toEqual(transfer.tail);
  });

  it("cleans before AUTH_ARMED when stdout cannot flush", async () => {
    const { root, rootMode } = await stageFixture();
    const value = request();
    await expect(
      runLinuxReleaseBridge({
        invocation: invocation(),
        input: frame(value).input,
        stage: optionsFor(root, rootMode),
        nonce: () => bridgeNonce,
        emit: async () => {
          throw new Error("closed stdout");
        },
        spawnSudo: () => child(),
      }),
    ).rejects.toMatchObject({ code: "runtime" });
    await expect(
      stat(linuxReleaseBridgeStagePath(uid, transactionId, root)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses root, identity drift, hostile loader env, and inventory drift", async () => {
    const cases: ReadonlyArray<{
      readonly invocation?: Partial<LinuxReleaseBridgeInvocation>;
      readonly request?: LinuxReleaseBridgeStageRequest;
      readonly code: "identity" | "protocol";
    }> = [
      { invocation: { uid: 0, effectiveUid: 0 }, code: "identity" },
      { invocation: { effectiveGid: gid + 1 }, code: "identity" },
      {
        invocation: { environment: { NODE_OPTIONS: "--require=/tmp/hook" } },
        code: "identity",
      },
      {
        request: {
          ...request(),
          candidate: {
            ...request().candidate,
            inventorySha256: "ff".repeat(32),
          },
        },
        code: "protocol",
      },
    ];
    for (const testCase of cases) {
      const { root, rootMode } = await stageFixture();
      const value = testCase.request ?? request();
      await expect(
        runLinuxReleaseBridge({
          invocation: invocation(testCase.invocation),
          input: frame(value).input,
          stage: optionsFor(root, rootMode),
          nonce: () => bridgeNonce,
          emit: async () => undefined,
          spawnSudo: () => child(),
        }),
      ).rejects.toMatchObject({ code: testCase.code });
      expect(await readdir(root)).toEqual([]);
    }
  });

  it("refuses an attacker-precreated transaction without deleting it", async () => {
    const { root, rootMode } = await stageFixture();
    const value = request();
    const stagePath = linuxReleaseBridgeStagePath(uid, transactionId, root);
    await mkdir(stagePath, { mode: 0o700 });
    await writeFile(path.join(stagePath, "foreign"), "owned by caller");
    await expect(
      runLinuxReleaseBridge({
        invocation: invocation(),
        input: frame(value).input,
        stage: optionsFor(root, rootMode),
        nonce: () => bridgeNonce,
        emit: async () => undefined,
        spawnSudo: () => child(),
      }),
    ).rejects.toMatchObject({ code: "stage" });
    await expect(readFile(path.join(stagePath, "foreign"), "utf8")).resolves
      .toBe("owned by caller");
  });
});

describe("sudo child boundary", () => {
  it("pins a fixed child command, argv, and sanitized environment without execve", async () => {
    expect(LINUX_RELEASE_BRIDGE_SUDO).toBe("/usr/bin/sudo");
    expect(LINUX_RELEASE_BRIDGE_SUDO_ARGV).toEqual([
      "sudo",
      "-k",
      "-S",
      "-p",
      "",
      "--",
      "/usr/libexec/vellum-release-installer",
    ]);
    expect(LINUX_RELEASE_BRIDGE_EXEC_ENV).toEqual({
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C",
      LC_ALL: "C",
    });
    const source = await readFile(
      new URL("../scripts/linux-release-bridge.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("spawn(");
    expect(source).not.toContain("process.execve");
    expect(source).not.toContain("shell: true");
  });
});
