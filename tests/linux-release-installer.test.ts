import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  chown,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  InstallerError,
  NodeLinuxReleaseInstallerHost,
  linuxReleaseInstallerReceiptExitCode,
  runLinuxReleaseInstaller,
  type FixedCommandResult,
  type LinuxReleaseInstallerInvocation,
  type LinuxReleaseFenceControl,
  type NodeLinuxReleaseInstallerHostOptions,
  type VerifiedProtectedLinuxBundle,
} from "../scripts/linux-release-installer";
import {
  LINUX_RELEASE_INSTALLER_MAX_FILE_BYTES,
  LINUX_RELEASE_INSTALLER_JOURNAL_PHASES,
  LINUX_RELEASE_INSTALLER_PROTOCOL,
  LINUX_RELEASE_INSTALLER_RECEIPT,
  decodeLinuxReleaseInstallerJournal,
  decodeLinuxReleaseInstallerReceipt,
  encodeLinuxReleaseInstallerJournal,
  encodeLinuxReleaseInstallerReceipt,
  type LinuxReleaseInstallerCandidate,
  type LinuxReleaseInstallerJournal,
  type LinuxReleaseInstallerJournalPhase,
  type LinuxReleaseInstallerRequest,
  type LinuxReleaseInstallerReceipt,
} from "../src/shared/linux-release-installer";
import {
  LINUX_RELEASE_BRIDGE_AUTH_PROTOCOL,
  LINUX_RELEASE_BRIDGE_AUTH_METADATA,
  LINUX_RELEASE_BRIDGE_STAGE_METADATA,
  LINUX_RELEASE_BRIDGE_STAGE_PROTOCOL,
  encodeLinuxReleaseBridgeAuthArmed,
  encodeLinuxReleaseBridgeInventory,
  encodeLinuxReleaseBridgeStageRequest,
  linuxReleaseBridgeStagePath,
  type LinuxReleaseBridgeAuthArmed,
  type LinuxReleaseBridgeStageRequest,
} from "../src/shared/linux-release-bridge";
import {
  encodeLinuxReleaseFence,
  type LinuxReleaseFence,
} from "../src/shared/linux-release-fence";
import {
  LinuxReleaseFenceController,
  type LinuxReleaseFenceAuthority,
  type LinuxReleaseMaintenanceLease,
} from "../scripts/linux-release-fence-control";

const roots: string[] = [];
const servers: Server[] = [];
const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");
const revision = "a".repeat(40);
const generation = "b".repeat(32);
const bootId = "12345678-1234-1234-1234-123456789abc";

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) =>
      new Promise<void>((resolve) => server.close(() => resolve()))
    ),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface FakeMachine {
  version: string | null;
  packageStatus:
    | "install ok installed"
    | "install ok half-configured";
  service:
    | "enabled-active"
    | "enabled-inactive"
    | "disabled-active"
    | "disabled-inactive"
    | "absent-inactive";
  linger: boolean;
  failInstallAfterMutation: boolean;
  failActivation: boolean;
  failQuarantine: boolean;
  events: string[];
}

interface Fixture {
  readonly root: string;
  readonly paths: {
    readonly stateRoot: string;
    readonly spoolRoot: string;
    readonly runtimeRoot: string;
    readonly dpkgInfoRoot: string;
    readonly installedRoot: string;
    readonly bridgeRoot: string;
  };
  readonly home: string;
  readonly invocation: LinuxReleaseInstallerInvocation;
  readonly machine: FakeMachine;
  readonly host: NodeLinuxReleaseInstallerHost;
  readonly lock: {
    held: boolean;
  };
  readonly fence: ReturnType<typeof makeFenceControl>;
}

const targetUid = (): number => {
  const uid = process.getuid?.() ?? 501;
  return uid === 0 ? 1000 : uid;
};

const targetGid = (): number => {
  const gid = process.getgid?.() ?? 20;
  return gid === 0 ? 1000 : gid;
};

const rootOwnerUid = (): number => process.getuid?.() ?? 501;
const rootOwnerGid = (): number => process.getgid?.() ?? 20;

const makeFenceControl = () => {
  let acquireCount = 0;
  let recovering = false;
  let authority: LinuxReleaseFenceAuthority | undefined;
  let published = false;
  let cleared = false;
  let preparedAbsent = false;
  const events: string[] = [];
  const control: LinuxReleaseFenceControl = {
    acquire: async (): Promise<LinuxReleaseMaintenanceLease> => {
      acquireCount += 1;
      const currentGeneration = !recovering && acquireCount === 1
        ? "e".repeat(32)
        : generation;
      events.push(`acquire:${currentGeneration}`);
      return {
        evidence: {
          activeTerminalSessions: 0,
          observationId: `tm_${String(acquireCount).padStart(16, "0")}`,
        },
        peer: {
          pid: 7000 + acquireCount,
          uid: targetUid(),
          gid: targetGid(),
          startTicks: String(8000 + acquireCount),
          generation: currentGeneration,
          invocationId: currentGeneration,
        },
        tokenDevice: "1",
        tokenInode: String(9000 + acquireCount),
        acknowledge: async (candidate) => {
          if (candidate !== authority || !published || cleared) {
            throw new Error("fake fence is not published");
          }
          events.push(`ack:${currentGeneration}`);
        },
        release: async () => {
          events.push(`release:${currentGeneration}`);
        },
      };
    },
    prepare: async (record: LinuxReleaseFence) => {
      authority = Object.freeze({
        record,
        device: "10",
        inode: "20",
      });
      published = false;
      cleared = false;
      recovering = false;
      events.push("prepare");
      return authority;
    },
    publish: async (candidate) => {
      if (candidate !== authority) throw new Error("wrong fake authority");
      published = true;
      events.push("publish");
    },
    observePrepared: async (record, device, inode) => {
      if (preparedAbsent) {
        preparedAbsent = false;
        events.push("observe-absent");
        return { state: "absent" };
      }
      authority = Object.freeze({
        record,
        device: device ?? "10",
        inode: inode ?? "20",
      });
      published = false;
      cleared = false;
      recovering = true;
      events.push("adopt-prepared");
      return { state: "pending", authority };
    },
    normalizePrepared: async (candidate) => {
      if (candidate !== authority) {
        throw new Error("wrong fake prepared authority");
      }
      return published ? "published" : "pending";
    },
    adoptPublished: async (record, device, inode) => {
      authority = Object.freeze({ record, device, inode });
      published = true;
      cleared = false;
      recovering = true;
      events.push("adopt-published");
      return authority;
    },
    assertExact: async (candidate) => {
      if (candidate !== authority || !published || cleared) {
        throw new Error("fake fence mismatch");
      }
    },
    proveAbsent: async () => {
      if (published && !cleared) {
        throw new Error("fake fence is still published");
      }
      recovering = false;
      acquireCount = 0;
      events.push("prove-absent");
    },
    discardPrepared: async (candidate) => {
      if (candidate !== authority || published) {
        throw new Error("wrong fake pending authority");
      }
      cleared = true;
      recovering = false;
      acquireCount = 0;
      events.push("discard");
    },
    clear: async (candidate) => {
      if (candidate !== authority || !published || cleared) {
        throw new Error("wrong fake published authority");
      }
      cleared = true;
      events.push("clear");
      acquireCount = 0;
      recovering = false;
    },
  };
  return Object.assign(control, {
    events,
    get cleared(): boolean {
      return cleared;
    },
    get published(): boolean {
      return published;
    },
    simulatePreparedAbsence(): void {
      preparedAbsent = true;
    },
  });
};

const makeReadiness = (): string => `${generation}\n`;

const startBus = async (
  runtimeRoot: string,
  uid: number,
  gid: number,
): Promise<void> => {
  await mkdir(runtimeRoot, { mode: 0o700 });
  const directory = path.join(runtimeRoot, String(uid));
  await mkdir(directory, { mode: 0o700 });
  if (rootOwnerUid() === 0) await chown(directory, uid, gid);
  const socket = path.join(directory, "bus");
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  if (rootOwnerUid() === 0) await chown(socket, uid, gid);
};

const packagePayload = (
  version: string,
  variant = "release",
): Buffer =>
  Buffer.from(JSON.stringify({ version, variant }), "utf8");

const bundle = (
  version: string,
  transactionId: string,
  variant = "release",
): {
  readonly request: Extract<
    LinuxReleaseInstallerRequest,
    { readonly kind: "prepare" }
  >;
  readonly body: ReadonlyArray<Buffer>;
  readonly candidate: LinuxReleaseInstallerCandidate;
} => {
  const manifest = Buffer.from(`manifest:${version}:${variant}`, "utf8");
  const deb = packagePayload(version, variant);
  const files = [
    {
      name: "release-manifest.json",
      bytes: manifest.length,
      sha256: sha256(manifest),
    },
    {
      name: "vellum.deb",
      bytes: deb.length,
      sha256: sha256(deb),
    },
  ];
  const candidateBase = {
    version,
    debSha256: sha256(deb),
    manifestSha256: sha256(manifest),
  };
  const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
  const inventorySha256 = sha256(
    encodeLinuxReleaseBridgeInventory({
      candidate: { ...candidateBase, inventorySha256: "0".repeat(64) },
      totalBytes,
      files,
    }),
  );
  const candidate = { ...candidateBase, inventorySha256 };
  return {
    request: {
      schema: LINUX_RELEASE_INSTALLER_PROTOCOL,
      kind: "prepare",
      transactionId,
      providerNonce: "c".repeat(32),
      bridgeNonce: "d".repeat(32),
      helperChallenge: "0".repeat(32),
      target: {
        uid: targetUid(),
        gid: targetGid(),
        host: "remote.test",
        stationId: "remote-test",
      },
      candidate,
      totalBytes,
      files,
    },
    body: [manifest, deb],
    candidate,
  };
};

const journalFence = (
  release: ReturnType<typeof bundle>,
  transactionId: string,
  operation: "install" | "adopt",
  phase: LinuxReleaseInstallerJournalPhase,
): LinuxReleaseInstallerJournal["fence"] => ({
  record: {
    schema: "vellum/linux-release-fence/v1",
    fenceId: "f".repeat(32),
    transactionId,
    operation,
    targetUid: release.request.target.uid,
    targetGid: release.request.target.gid,
    stationId: release.request.target.stationId,
    machineIdSha256: "c".repeat(64),
    bootId,
    candidateDigest: release.request.candidate.inventorySha256,
  },
  device: phase === "fence-intent" ? null : "10",
  inode: phase === "fence-intent" ? null : "20",
  preGeneration: "e".repeat(32),
  postGeneration: new Set<LinuxReleaseInstallerJournalPhase>([
      "aborted-acknowledged",
      "aborted-fence-clear-started",
      "aborted-fence-cleared",
      "postrestart-acknowledged",
      "fence-clear-started",
      "fence-cleared",
    ]).has(phase)
    ? generation
    : null,
});

const frame = (
  request: LinuxReleaseInstallerRequest | Record<string, unknown>,
  body: ReadonlyArray<Uint8Array> = [],
): AsyncIterable<Uint8Array> =>
  Readable.from([
    Buffer.from(`${JSON.stringify(request)}\n`, "utf8"),
    ...body.map((value) => Buffer.from(value)),
  ]);

const stageRelease = async (
  fixture: Fixture,
  release: ReturnType<typeof bundle>,
): Promise<void> => {
  const stagePath = linuxReleaseBridgeStagePath(
    release.request.target.uid,
    release.request.transactionId,
    fixture.paths.bridgeRoot,
  );
  await mkdir(stagePath, { mode: 0o700 });
  await chmod(stagePath, 0o700);
  if (rootOwnerUid() === 0) {
    await chown(
      stagePath,
      release.request.target.uid,
      release.request.target.gid,
    );
  }
  for (let index = 0; index < release.request.files.length; index += 1) {
    const descriptor = release.request.files[index]!;
    const file = path.join(stagePath, descriptor.name);
    await writeFile(file, release.body[index]!, { mode: 0o600 });
    await chmod(file, 0o600);
    if (rootOwnerUid() === 0) {
      await chown(
        file,
        release.request.target.uid,
        release.request.target.gid,
      );
    }
  }
  const stage: LinuxReleaseBridgeStageRequest = {
    schema: LINUX_RELEASE_BRIDGE_STAGE_PROTOCOL,
    kind: "stage",
    transactionId: release.request.transactionId,
    providerNonce: release.request.providerNonce,
    target: release.request.target,
    candidate: release.request.candidate,
    totalBytes: release.request.totalBytes,
    files: release.request.files,
  };
  const auth: LinuxReleaseBridgeAuthArmed = {
    schema: LINUX_RELEASE_BRIDGE_AUTH_PROTOCOL,
    kind: "AUTH_ARMED",
    transactionId: release.request.transactionId,
    providerNonce: release.request.providerNonce,
    bridgeNonce: release.request.bridgeNonce,
    target: release.request.target,
    candidate: release.request.candidate,
    totalBytes: release.request.totalBytes,
  };
  for (const [name, text] of [
    [LINUX_RELEASE_BRIDGE_STAGE_METADATA, encodeLinuxReleaseBridgeStageRequest(stage)],
    [LINUX_RELEASE_BRIDGE_AUTH_METADATA, encodeLinuxReleaseBridgeAuthArmed(auth)],
  ] as const) {
    const file = path.join(stagePath, name);
    await writeFile(file, text, { mode: 0o600 });
    await chmod(file, 0o600);
    if (rootOwnerUid() === 0) {
      await chown(
        file,
        release.request.target.uid,
        release.request.target.gid,
      );
    }
  }
};

const releaseTranscript = (
  release: ReturnType<typeof bundle>,
  emitted: ReadonlyArray<LinuxReleaseInstallerReceipt>,
  mutateCommit?: (
    commit: Extract<
      LinuxReleaseInstallerRequest,
      { readonly kind: "commit" }
    >,
  ) => LinuxReleaseInstallerRequest | Record<string, unknown>,
): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    const armed = emitted.find((receipt) =>
      receipt.ok && receipt.state === "root-armed"
    );
    if (armed === undefined || !armed.ok || armed.state !== "root-armed") {
      throw new Error("ROOT_ARMED was not emitted before PREPARE");
    }
    const prepare = {
      ...release.request,
      helperChallenge: armed.helperChallenge,
    };
    yield Buffer.from(`${JSON.stringify(prepare)}\n`, "utf8");
    const ready = emitted.find((receipt) =>
      receipt.ok && receipt.state === "root-ready"
    );
    if (ready === undefined || !ready.ok || ready.state !== "root-ready") {
      throw new Error("ROOT_READY was not emitted before COMMIT");
    }
    const commit = {
      schema: LINUX_RELEASE_INSTALLER_PROTOCOL,
      kind: "commit",
      transactionId: ready.transactionId,
      providerNonce: ready.providerNonce,
      bridgeNonce: ready.bridgeNonce,
      helperChallenge: ready.helperChallenge,
      fenceId: ready.fence.fenceId,
      inventorySha256: ready.candidate.inventorySha256,
    } as const;
    yield Buffer.from(
      `${JSON.stringify(mutateCommit?.(commit) ?? commit)}\n`,
      "utf8",
    );
  },
});

const readinessPath = (fixture: Fixture): string =>
  path.join(
    fixture.paths.runtimeRoot,
    String(fixture.invocation.sudoUid),
    "vellum-remote",
    `ready-${generation}`,
  );

const seedReadiness = async (fixture: Fixture): Promise<void> => {
  const receipt = readinessPath(fixture);
  await mkdir(path.dirname(receipt), { recursive: true, mode: 0o700 });
  if (rootOwnerUid() === 0) {
    await chown(path.dirname(receipt), targetUid(), targetGid());
  }
  await writeFile(receipt, makeReadiness(), { mode: 0o600 });
  if (rootOwnerUid() === 0) {
    await chown(receipt, targetUid(), targetGid());
  }
};

const makeRunner = (
  machine: FakeMachine,
  paths: Fixture["paths"],
  home: string,
): NodeLinuxReleaseInstallerHostOptions["runCommand"] => {
  const result = (
    code: number,
    stdout = "",
    stderr = "",
  ): FixedCommandResult => ({ code, stdout, stderr });
  return async (executable, arguments_) => {
    const argumentsArray = [...arguments_];
    if (executable === "/usr/bin/getent") {
      return result(
        0,
        `vellum:x:${targetUid()}:${targetGid()}::${home}:/bin/sh\n`,
      );
    }
    if (executable === "/usr/bin/dpkg-query") {
      if (argumentsArray[1]?.includes("${Package}")) {
        return machine.version === null
          ? result(
            1,
            "",
            "dpkg-query: no packages found matching vellum\n",
          )
          : result(
            0,
            `vellum\t${machine.version}\tamd64\t\t\tlibc6\n`,
          );
      }
      return machine.version === null
        ? result(
          1,
          "",
          "dpkg-query: no packages found matching vellum\n",
        )
        : result(0, `${machine.packageStatus}\t${machine.version}\n`);
    }
    if (executable === "/usr/bin/dpkg") {
      if (
        argumentsArray[0] === "--verify" &&
        argumentsArray[1] === "vellum"
      ) {
        return result(0);
      }
      throw new Error("unexpected direct dpkg command");
    }
    if (executable === "/usr/bin/dpkg-deb") {
      if (argumentsArray[0] === "--info") return result(0, "deb\n");
      if (
        argumentsArray[0] === "--control" ||
        argumentsArray[0] === "--extract"
      ) {
        const source = argumentsArray[1] ?? "";
        const destination = argumentsArray[2] ?? "";
        const decoded = JSON.parse(await readFile(source, "utf8")) as {
          readonly version: string;
        };
        if (argumentsArray[0] === "--control") {
          await writeFile(
            path.join(destination, "control"),
            `Package: vellum\nVersion: ${decoded.version}\nArchitecture: amd64\n`,
            { mode: 0o644 },
          );
          await writeFile(path.join(destination, "md5sums"), "fake-md5\n", {
            mode: 0o644,
          });
        } else {
          const payload = path.join(destination, "opt", "Vellum");
          await mkdir(payload, { recursive: true, mode: 0o755 });
          await chmod(path.join(destination, "opt"), 0o755);
          await chmod(payload, 0o755);
          await writeFile(
            path.join(payload, "app.bin"),
            `payload:${decoded.version}`,
            { mode: 0o644 },
          );
        }
        return result(0);
      }
      const packagePath = argumentsArray[1] ?? "";
      const field = argumentsArray[2];
      const decoded = JSON.parse(await readFile(packagePath, "utf8")) as {
        readonly version: string;
      };
      if (field === "Package") return result(0, "vellum\n");
      if (field === "Version") return result(0, `${decoded.version}\n`);
      if (field === "Architecture") return result(0, "amd64\n");
      if (field === "Essential" || field === "Pre-Depends") return result(0);
      if (field === "Depends") return result(0, "libc6\n");
      throw new Error(`unexpected deb field ${field}`);
    }
    if (executable === "/usr/bin/systemd-run") {
      const unit = argumentsArray.find((value) => value.startsWith("--unit="))
        ?.slice("--unit=".length) ?? "";
      const dpkg = argumentsArray.indexOf("/usr/bin/dpkg");
      const operation = argumentsArray[dpkg + 1];
      if (operation === "--install") {
        const source = argumentsArray[dpkg + 2] ?? "";
        const decoded = JSON.parse(await readFile(source, "utf8")) as {
          readonly version: string;
        };
        machine.version = decoded.version;
        machine.packageStatus =
          machine.failInstallAfterMutation
            ? "install ok half-configured"
            : "install ok installed";
        machine.events.push(`install:${decoded.version}`);
        const payload = path.join(
          paths.installedRoot,
          "opt",
          "Vellum",
        );
        await mkdir(payload, { recursive: true, mode: 0o755 });
        await chmod(path.join(paths.installedRoot, "opt"), 0o755);
        await chmod(payload, 0o755);
        await writeFile(
          path.join(payload, "app.bin"),
          `payload:${decoded.version}`,
          { mode: 0o644 },
        );
        await writeFile(
          path.join(paths.dpkgInfoRoot, "vellum.md5sums"),
          "fake-md5\n",
          { mode: 0o644 },
        );
        await writeFile(
          path.join(paths.dpkgInfoRoot, "vellum.list"),
          "/opt\n/opt/Vellum\n/opt/Vellum/app.bin\n",
          { mode: 0o644 },
        );
        if (
          machine.failInstallAfterMutation
        ) {
          machine.failInstallAfterMutation = false;
          return result(1);
        }
        return result(0);
      }
    }
    if (executable === "/usr/bin/systemctl") {
    }
    if (executable === "/usr/bin/loginctl") {
      if (argumentsArray[0] === "show-user") {
        return result(0, machine.linger ? "yes\n" : "no\n");
      }
      if (argumentsArray[0] === "enable-linger") {
        machine.linger = true;
        return result(0);
      }
      if (argumentsArray[0] === "disable-linger") {
        machine.linger = false;
        return result(0);
      }
    }
    if (executable === "/usr/sbin/runuser") {
      const systemctl = argumentsArray.indexOf("/usr/bin/systemctl");
      const command = argumentsArray.slice(systemctl + 2);
      if (command[0] === "is-enabled") {
        if (machine.service.startsWith("enabled")) {
          return result(0, "enabled\n");
        }
        if (machine.service.startsWith("disabled")) {
          return result(1, "disabled\n");
        }
        return result(1, "not-found\n");
      }
      if (command[0] === "is-active") {
        return machine.service.endsWith("active") &&
            !machine.service.endsWith("inactive")
          ? result(0, "active\n")
          : result(3, "inactive\n");
      }
      if (command[0] === "daemon-reload") return result(0);
      if (command[0] === "show") {
        const property = command.find((value) =>
          value.startsWith("--property=")
        )?.slice("--property=".length);
        const values: Record<string, string> = {
          FragmentPath: "/usr/lib/systemd/user/vellum-remote.service\n",
          DropInPaths: "\n",
          LoadState: "loaded\n",
          Type: "notify\n",
          NotifyAccess: "all\n",
          UnsetEnvironment:
            "BASH_ENV BASHOPTS BUN_BE_BUN BUN_CONFIG_LINK_NATIVE_BINS BUN_CONFIG_VERBOSE_FETCH BUN_DEBUG_QUIET_LOGS BUN_INSTALL BUN_OPTIONS BUN_RUNTIME_TRANSPILER_CACHE_PATH CHROME_WRAPPER ELECTRON_RUN_AS_NODE ENV GCONV_PATH GI_TYPELIB_PATH GIO_EXTRA_MODULES GLIBC_TUNABLES GTK_MODULES HOSTALIASES IFS LD_ASSUME_KERNEL LD_AUDIT LD_DEBUG LD_DEBUG_OUTPUT LD_LIBRARY_PATH LD_ORIGIN_PATH LD_PRELOAD LD_PROFILE LD_SHOW_AUXV LOCPATH MALLOC_TRACE NLSPATH NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE PYTHONHOME PYTHONPATH QT_PLUGIN_PATH RESOLV_HOST_CONF SHELLOPTS TZDIR VELLUM_BROWSER_CAPABILITY VELLUM_BROWSER_HOME VELLUM_CANVASES_DIR VELLUM_E2E VELLUM_E2E_RENDERER_SURFACE_TIMEOUT_MS VELLUM_NODE_REF\n",
          InvocationID: `${generation}\n`,
        };
        return result(0, values[property ?? ""] ?? "");
      }
      if (command[0] === "enable") {
        machine.service = machine.service.endsWith("active") &&
            !machine.service.endsWith("inactive")
          ? "enabled-active"
          : "enabled-inactive";
        return result(0);
      }
      if (command[0] === "disable") {
        machine.events.push("quarantine");
        if (machine.failQuarantine) return result(1);
        machine.service = command.includes("--now")
          ? "disabled-inactive"
          : machine.service.endsWith("active") &&
            !machine.service.endsWith("inactive")
          ? "disabled-active"
          : "disabled-inactive";
        return result(0);
      }
      if (command[0] === "start" || command[0] === "restart") {
        machine.service = machine.service.startsWith("disabled")
          ? "disabled-active"
          : "enabled-active";
        const directory = path.join(
          paths.runtimeRoot,
          String(targetUid()),
          "vellum-remote",
        );
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (rootOwnerUid() === 0) {
          await chown(directory, targetUid(), targetGid());
        }
        const receipt = path.join(directory, `ready-${generation}`);
        await writeFile(receipt, makeReadiness(), { mode: 0o600 });
        if (rootOwnerUid() === 0) {
          await chown(receipt, targetUid(), targetGid());
        }
        if (machine.failActivation) {
          machine.failActivation = false;
          return result(1);
        }
        return result(0);
      }
      if (command[0] === "stop") {
        machine.service = machine.service.startsWith("disabled")
          ? "disabled-inactive"
          : "enabled-inactive";
        return result(0);
      }
    }
    throw new Error(
      `unexpected fixed command: ${executable} ${argumentsArray.join(" ")}`,
    );
  };
};

const createFixture = async (
  options: {
    readonly verifyGate?: Promise<void>;
  } = {},
): Promise<Fixture> => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "vellum-installer-")),
  );
  roots.push(root);
  const paths = {
    stateRoot: path.join(root, "state"),
    spoolRoot: path.join(root, "spool"),
    runtimeRoot: path.join(root, "run"),
    dpkgInfoRoot: path.join(root, "dpkg-info"),
    installedRoot: path.join(root, "installed"),
    bridgeRoot: path.join(root, "bridge"),
  };
  const home = path.join(root, "home");
  await mkdir(home, { mode: 0o700 });
  if (rootOwnerUid() === 0) {
    await chown(home, targetUid(), targetGid());
  }
  await startBus(paths.runtimeRoot, targetUid(), targetGid());
  await mkdir(paths.dpkgInfoRoot, { mode: 0o755 });
  await mkdir(paths.installedRoot, { mode: 0o755 });
  await mkdir(paths.bridgeRoot, { mode: 0o1733 });
  await chmod(paths.bridgeRoot, 0o1733);
  // Bun's fs.promises.chmod currently drops the sticky bit in its test
  // runner; use the platform chmod utility to construct the same fixed-root
  // authority exercised in production.
  execFileSync("/bin/chmod", ["1733", paths.bridgeRoot]);
  expect((await stat(paths.bridgeRoot)).mode & 0o7777).toBe(0o1733);
  const invocation: LinuxReleaseInstallerInvocation = {
    effectiveUid: 0,
    arguments: [],
    environment: {},
    hostname: "remote.test",
    sudoUid: targetUid(),
    sudoGid: targetGid(),
    sudoUser: "vellum",
    sudoCommand: "/usr/libexec/vellum-release-installer",
    process: {
      pid: 4242,
      startTicks: "12345",
      bootId,
    },
  };
  const machine: FakeMachine = {
    version: null,
    packageStatus: "install ok installed",
    service: "absent-inactive",
    linger: false,
    failInstallAfterMutation: false,
    failActivation: false,
    failQuarantine: false,
    events: [],
  };
  const lock = { held: false };
  const fence = makeFenceControl();
  const verifier = async (
    directory: string,
  ): Promise<VerifiedProtectedLinuxBundle> => {
    await options.verifyGate;
    const directoryMetadata = await stat(directory);
    expect(directoryMetadata.mode & 0o777).toBe(0o700);
    const deb = await readFile(path.join(directory, "vellum.deb"));
    const manifest = await readFile(
      path.join(directory, "release-manifest.json"),
    );
    const decoded = JSON.parse(deb.toString("utf8")) as {
      readonly version: string;
    };
    return {
      version: decoded.version,
      sourceRevision: revision,
      manifestSha256: sha256(manifest),
      debFile: "vellum.deb",
      debBytes: deb.length,
      debSha256: sha256(deb),
    };
  };
  const host = new NodeLinuxReleaseInstallerHost({
    paths,
    ownerUid: rootOwnerUid(),
    ownerGid: rootOwnerGid(),
    verifyProtectedBundle: verifier,
    runCommand: makeRunner(machine, paths, home),
    isProcessLive: async () => false,
    acquireKernelLock: async () => {
      if (lock.held) throw new InstallerError("busy", "held");
      lock.held = true;
      return {
        assertHeld: async () => {
          if (!lock.held) throw new InstallerError("unsafe-state", "lost");
        },
        release: async () => {
          lock.held = false;
        },
      };
    },
    bridgeStageRoot: paths.bridgeRoot,
    fenceControlFactory: async () => fence,
    readMachineIdSha256: async () => "c".repeat(64),
  });

  return { root, paths, home, invocation, machine, host, lock, fence };
};

const install = async (
  fixture: Fixture,
  version: string,
  transactionId: string,
  variant = "release",
) => {
  const release = bundle(version, transactionId, variant);
  await stageRelease(fixture, release);
  const emitted: LinuxReleaseInstallerReceipt[] = [];
  const receipt = await runLinuxReleaseInstaller(
    releaseTranscript(release, emitted),
    fixture.invocation,
    fixture.host,
    { idleMs: 1_000, overallMs: 30_000 },
    async (value) => {
      emitted.push(value);
    },
  );
  return { release, receipt, emitted };
};

const seedInstalledBaseline = async (
  fixture: Fixture,
  version: string,
): Promise<void> => {
  fixture.machine.version = version;
  fixture.machine.packageStatus = "install ok installed";
  fixture.machine.service = "disabled-inactive";
  fixture.machine.linger = false;
  const directory = path.join(
    fixture.paths.installedRoot,
    "opt",
    "Vellum",
  );
  await mkdir(directory, { recursive: true, mode: 0o755 });
  await chmod(path.join(fixture.paths.installedRoot, "opt"), 0o755);
  await chmod(directory, 0o755);
  await writeFile(path.join(directory, "app.bin"), `payload:${version}`, {
    mode: 0o644,
  });
  await writeFile(
    path.join(fixture.paths.dpkgInfoRoot, "vellum.md5sums"),
    "fake-md5\n",
    { mode: 0o644 },
  );
  await writeFile(
    path.join(fixture.paths.dpkgInfoRoot, "vellum.list"),
    "/opt\n/opt/Vellum\n/opt/Vellum/app.bin\n",
    { mode: 0o644 },
  );
};

describe("Linux privileged release installer", () => {
  it("emits and flushes ROOT_ARMED before reading PREPARE", async () => {
    const fixture = await createFixture();
    const emitted: LinuxReleaseInstallerReceipt[] = [];
    const input: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        expect(emitted).toHaveLength(1);
        expect(emitted[0]).toMatchObject({
          ok: true,
          state: "root-armed",
          target: {
            uid: targetUid(),
            gid: targetGid(),
            host: "remote.test",
          },
          machineIdSha256: "c".repeat(64),
          bootId,
        });
        yield Buffer.from("{}\n");
      },
    };
    const receipt = await runLinuxReleaseInstaller(
      input,
      fixture.invocation,
      fixture.host,
      { idleMs: 1_000, overallMs: 5_000 },
      async (value) => {
        expect(encodeLinuxReleaseInstallerReceipt(value).endsWith("\n"))
          .toBe(true);
        emitted.push(value);
      },
    );
    expect(receipt).toMatchObject({ ok: false, code: "protocol" });
    expect(linuxReleaseInstallerReceiptExitCode(receipt)).toBe(0);
    await expect(lstat(fixture.paths.stateRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const preparedFixture = await createFixture();
    const release = bundle("1.0.0", "0f".repeat(16));
    await stageRelease(preparedFixture, release);
    const preparedEmitted: LinuxReleaseInstallerReceipt[] = [];
    const preparedInput: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        const armed = preparedEmitted[0];
        if (armed === undefined || !armed.ok || armed.state !== "root-armed") {
          throw new Error("ROOT_ARMED was not flushed");
        }
        yield Buffer.from(`${JSON.stringify({
          ...release.request,
          helperChallenge: armed.helperChallenge,
        })}\n`);
        expect(preparedEmitted.at(-1)).toMatchObject({
          ok: true,
          state: "root-ready",
        });
        expect(preparedFixture.machine.events).toEqual([]);
        expect(preparedFixture.fence.events).not.toContain("prepare");
        expect(preparedFixture.fence.events).not.toContain("publish");
        await expect(
          lstat(path.join(
            preparedFixture.paths.stateRoot,
            "transaction.json",
          )),
        ).rejects.toMatchObject({ code: "ENOENT" });
        yield Buffer.from("{}\n");
      },
    };
    const preparedReceipt = await runLinuxReleaseInstaller(
      preparedInput,
      preparedFixture.invocation,
      preparedFixture.host,
      { idleMs: 1_000, overallMs: 5_000 },
      async (value) => {
        preparedEmitted.push(value);
      },
    );
    expect(preparedReceipt).toMatchObject({ ok: false, code: "protocol" });
    expect(preparedFixture.machine.events).toEqual([]);
    expect(preparedFixture.fence.events).not.toContain("prepare");
    expect(preparedFixture.fence.events).not.toContain("publish");
  });

  it.each([
    ["path traversal", "../vellum.deb", 1],
    ["oversized file", "vellum.deb", LINUX_RELEASE_INSTALLER_MAX_FILE_BYTES + 1],
  ])("rejects hostile %s framing before privileged mutation", async (
    _label,
    name,
    bytes,
  ) => {
    const fixture = await createFixture();
    const hostile = {
      schema: LINUX_RELEASE_INSTALLER_PROTOCOL,
      kind: "install",
      transactionId: "2".repeat(32),
      target: {
        uid: targetUid(),
        gid: targetGid(),
        host: "remote.test",
      },
      files: [{ name, bytes, sha256: "0".repeat(64) }],
    };
    const receipt = await runLinuxReleaseInstaller(
      frame(hostile),
      fixture.invocation,
      fixture.host,
    );
    expect(receipt).toMatchObject({
      ok: false,
      code: "protocol",
      action: "send-a-new-bounded-frame",
    });
    await expect(lstat(fixture.paths.stateRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects PREPARE without its ROOT_ARMED challenge", async () => {
    const fixture = await createFixture();
    const release = bundle("1.0.0", "3".repeat(32));
    const emitted: LinuxReleaseInstallerReceipt[] = [];
    const receipt = await runLinuxReleaseInstaller(
      frame(release.request),
      fixture.invocation,
      fixture.host,
      { idleMs: 1_000, overallMs: 5_000 },
      async (value) => {
        emitted.push(value);
      },
    );
    expect(receipt).toMatchObject({ ok: false, code: "protocol" });
    expect(emitted[0]).toMatchObject({ state: "root-armed" });
    expect(fixture.lock.held).toBe(false);
    await expect(lstat(fixture.paths.stateRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("closes a stalled input iterator at the helper-owned deadline", async () => {
    const fixture = await createFixture();
    let returned = false;
    const input: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
          return: async () => {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const receipt = await runLinuxReleaseInstaller(
      input,
      fixture.invocation,
      fixture.host,
      { idleMs: 10, overallMs: 20 },
    );
    expect(receipt).toMatchObject({ ok: false, code: "protocol" });
    expect(returned).toBe(true);
  });

  it.each([
    ["non-root", { effectiveUid: 501 }],
    ["direct argv", { arguments: ["install"] }],
    ["direct root", { sudoCommand: "", sudoUser: "" }],
    ["startup injection", { environment: { BUN_BE_BUN: "1" } }],
  ])("rejects %s before reading or creating state", async (
    _label,
    patch,
  ) => {
    const fixture = await createFixture();
    const receipt = await runLinuxReleaseInstaller(
      frame({}),
      { ...fixture.invocation, ...patch },
      fixture.host,
    );
    expect(receipt).toMatchObject({
      ok: false,
      code: "identity",
      action: "invoke-with-fixed-sudo-command",
    });
    await expect(lstat(fixture.paths.stateRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writes root-protected O_EXCL stage files and refuses replacement", async () => {
    const fixture = await createFixture();
    await fixture.host.ensureLayout();
    const stage = await fixture.host.beginStage("4".repeat(32));
    const body = Buffer.from("protected");
    const descriptor = {
      name: "vellum.deb",
      bytes: body.length,
      sha256: sha256(body),
    };
    await fixture.host.writeStageFile(
      stage,
      descriptor,
      Readable.from([body]),
    );
    const directory = path.join(fixture.paths.spoolRoot, "4".repeat(32));
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(directory, "vellum.deb"))).mode & 0o777)
      .toBe(0o600);
    await expect(
      fixture.host.writeStageFile(stage, descriptor, Readable.from([body])),
    ).rejects.toThrow("stage authority is invalid");
    await fixture.host.discardStage(stage);

    const fenceDirectory = path.join(fixture.root, "release-fence");
    const fencePath = path.join(fenceDirectory, "active.json");
    const release = bundle("1.0.0", "41".repeat(16));
    const makeController = () =>
      new LinuxReleaseFenceController({
        paths: {
          targetHome: fixture.home,
          fenceDirectory,
          fencePath,
        },
        target: release.request.target,
        rootUid: rootOwnerUid(),
        rootGid: rootOwnerGid(),
        validatePeer: async () => {
          throw new Error("unused peer validator");
        },
      });
    const record = {
      schema: "vellum/linux-release-fence/v1",
      fenceId: "42".repeat(16),
      transactionId: release.request.transactionId,
      operation: "install",
      targetUid: release.request.target.uid,
      targetGid: release.request.target.gid,
      stationId: release.request.target.stationId,
      machineIdSha256: "c".repeat(64),
      bootId,
      candidateDigest: release.request.candidate.inventorySha256,
    } satisfies LinuxReleaseFence;
    const pendingPath = path.join(
      fenceDirectory,
      `.pending-${record.fenceId}`,
    );
    await mkdir(fenceDirectory, { mode: 0o700 });
    await chmod(fenceDirectory, 0o700);
    expect(
      (await makeController().observePrepared(record, null, null)).state,
    ).toBe("absent");
    expect((await stat(fenceDirectory)).mode & 0o777).toBe(0o755);
    await makeController().proveAbsent(record);
    const encodedFence = encodeLinuxReleaseFence(record);
    for (const cut of [
      { mode: 0o400, bytes: "" },
      { mode: 0o444, bytes: "" },
      {
        mode: 0o444,
        bytes: encodedFence.slice(0, Math.floor(encodedFence.length / 2)),
      },
    ]) {
      await writeFile(pendingPath, cut.bytes, { mode: cut.mode });
      await chmod(pendingPath, cut.mode);
      expect(
        (await makeController().observePrepared(record, null, null)).state,
      ).toBe("absent");
      await expect(lstat(pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await writeFile(pendingPath, encodedFence, { mode: 0o444 });
    await chmod(pendingPath, 0o444);
    const exactIntent = await makeController().observePrepared(
      record,
      null,
      null,
    );
    expect(exactIntent.state).toBe("pending");
    await makeController().discardPrepared(exactIntent.authority!);
    const prepared = await makeController().prepare(record);
    expect((await stat(fenceDirectory)).mode & 0o777).toBe(0o755);
    await link(pendingPath, fencePath);
    const crashRecovery = makeController();
    const both = await crashRecovery.observePrepared(
      record,
      prepared.device,
      prepared.inode,
    );
    expect(both.state).toBe("both");
    expect(
      await crashRecovery.normalizePrepared(both.authority!),
    ).toBe("published");
    await crashRecovery.clear(both.authority!);
    await crashRecovery.proveAbsent(record);

    const pendingRecord = {
      ...record,
      fenceId: "43".repeat(16),
      transactionId: "44".repeat(16),
    };
    const pendingAuthority = await makeController().prepare(pendingRecord);
    const pendingRecovery = makeController();
    const pending = await pendingRecovery.observePrepared(
      pendingRecord,
      pendingAuthority.device,
      pendingAuthority.inode,
    );
    expect(pending.state).toBe("pending");
    await pendingRecovery.discardPrepared(pending.authority!);
    expect(
      (await makeController().observePrepared(
        pendingRecord,
        pendingAuthority.device,
        pendingAuthority.inode,
      )).state,
    ).toBe("absent");
  });

  it("installs a first release without requiring a prior service quarantine", async () => {
    const fixture = await createFixture();
    const { receipt } = await install(fixture, "1.0.0", "5".repeat(32));
    expect(receipt).toMatchObject({ ok: true, state: "ready", operation: "install" });
    expect(fixture.machine.events).toContain("install:1.0.0");
  });

  it("quarantines before upgrade mutation and retains forward repair on dpkg failure", async () => {
    const fixture = await createFixture();
    await seedInstalledBaseline(fixture, "1.0.0");
    fixture.machine.service = "enabled-active";
    fixture.machine.failInstallAfterMutation = true;
    const { receipt } = await install(fixture, "2.0.0", "6".repeat(32));
    expect(receipt).toMatchObject({ ok: false, code: "install-failed", action: "repair-installed-package-manually" });
    expect(fixture.machine.service).toBe("disabled-inactive");
    expect(fixture.machine.events).toContain("install:2.0.0");
    expect(fixture.machine.events.indexOf("quarantine"))
      .toBeLessThan(fixture.machine.events.indexOf("install:2.0.0"));
    expect(fixture.machine.events).not.toContain("install:1.0.0");
    expect(await fixture.host.readJournal()).toMatchObject({ phase: "dpkg-started", fromVersion: "1.0.0", toVersion: "2.0.0" });
    expect(fixture.fence.events).toContain("publish");
    expect(fixture.fence.events).not.toContain("clear");
  });

  it("adopts an exact same-version baseline without dpkg", async () => {
    const fixture = await createFixture();
    await seedInstalledBaseline(fixture, "1.0.0");
    const { receipt } = await install(fixture, "1.0.0", "70".repeat(16));
    expect(receipt).toMatchObject({ ok: true, state: "ready", operation: "adopt" });
    expect(fixture.machine.events).toContain("quarantine");
    expect(fixture.machine.events.filter((event) => event.startsWith("install:")))
      .toEqual([]);
  });

  it("refuses a mismatched installed payload before activation", async () => {
    const fixture = await createFixture();
    await seedInstalledBaseline(fixture, "1.0.0");
    await writeFile(
      path.join(fixture.paths.installedRoot, "opt", "Vellum", "app.bin"),
      "tampered",
    );
    const { receipt } = await install(fixture, "1.0.0", "71".repeat(16));
    expect(receipt).toMatchObject({ ok: false, code: "unsafe-state" });
    expect(fixture.machine.events).toEqual([]);
    await expect(fixture.host.readJournal()).resolves.toBeNull();
  });

  it("retains a quarantined forward journal when activation fails", async () => {
    const fixture = await createFixture();
    await seedInstalledBaseline(fixture, "1.0.0");
    fixture.machine.service = "enabled-active";
    fixture.machine.failActivation = true;
    const { receipt } = await install(fixture, "2.0.0", "72".repeat(16));
    expect(receipt).toMatchObject({ ok: false, code: "install-failed", action: "repair-installed-package-manually" });
    expect(fixture.machine.service).toBe("disabled-inactive");
    expect(await fixture.host.readJournal()).toMatchObject({ schema: "vellum/linux-release-installer-journal/v3", phase: "activation-started" });
    expect(fixture.fence.events).not.toContain("clear");
  });

  it("refuses a busy kernel lease before package work", async () => {
    const fixture = await createFixture();
    fixture.lock.held = true;
    const { receipt } = await install(fixture, "1.0.0", "73".repeat(16));
    expect(receipt).toMatchObject({ ok: false, code: "busy" });
    expect(fixture.machine.events).toEqual([]);
  });

  it("retains forward authority when quarantine proof fails", async () => {
    const fixture = await createFixture();
    await seedInstalledBaseline(fixture, "1.0.0");
    fixture.machine.service = "enabled-active";
    fixture.machine.failQuarantine = true;
    const { receipt } = await install(fixture, "2.0.0", "74".repeat(16));
    expect(receipt).toMatchObject({ ok: false, code: "unsafe-state", action: "repair-root-installer-state-manually" });
    expect(await fixture.host.readJournal()).toMatchObject({ schema: "vellum/linux-release-installer-journal/v3", phase: "prepared" });
    expect(fixture.fence.events).toContain("publish");
    expect(fixture.fence.events).not.toContain("clear");
    expect(fixture.machine.events.filter((event) => event.startsWith("install:")))
      .toEqual([]);
  });

  it("quarantines and refuses an interrupted post-mutation journal without execution", async () => {
    const fixture = await createFixture();
    await fixture.host.ensureLayout();
    const prior = bundle("2.0.0", "75".repeat(16));
    await fixture.host.writeJournal({
      schema: "vellum/linux-release-installer-journal/v3",
      transactionId: prior.request.transactionId,
      operation: "install",
      owner: fixture.invocation.process,
      target: prior.request.target,
      fence: journalFence(prior, prior.request.transactionId, "install", "dpkg-started"),
      manifestSha256: prior.candidate.manifestSha256,
      debSha256: prior.candidate.debSha256,
      sourceRevision: revision,
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      phase: "dpkg-started",
    });
    const { receipt } = await install(fixture, "3.0.0", "76".repeat(16));
    expect(receipt).toMatchObject({ ok: false, code: "install-failed", action: "repair-installed-package-manually" });
    expect(fixture.machine.service).toBe("disabled-inactive");
    expect(fixture.machine.events).toEqual(["quarantine"]);
    expect(await fixture.host.readJournal()).toMatchObject({ phase: "dpkg-started", toVersion: "2.0.0" });
    expect(fixture.fence.events).not.toContain("clear");
  });

  it("cleans an interrupted aborted fence clear before installing the candidate", async () => {
    const fixture = await createFixture();
    await fixture.host.ensureLayout();
    const prior = bundle("1.0.0", "78".repeat(16));
    const fence = {
      ...journalFence(
        prior,
        prior.request.transactionId,
        "install",
        "aborted-fence-clear-started",
      ),
      postGeneration: generation,
    };
    await fixture.host.writeJournal({
      schema: "vellum/linux-release-installer-journal/v3",
      transactionId: prior.request.transactionId,
      operation: "install",
      owner: fixture.invocation.process,
      target: prior.request.target,
      fence,
      manifestSha256: prior.candidate.manifestSha256,
      debSha256: prior.candidate.debSha256,
      sourceRevision: revision,
      fromVersion: null,
      toVersion: "1.0.0",
      phase: "aborted-fence-clear-started",
    });
    const { receipt } = await install(fixture, "2.0.0", "79".repeat(16));
    expect(receipt).toMatchObject({ ok: true, state: "ready", operation: "install" });
    expect(fixture.fence.events).toContain("clear");
    expect(fixture.machine.events).toContain("install:2.0.0");
    expect(fixture.machine.events).not.toContain("quarantine");
  });

  it("refuses a malformed durable journal before package execution", async () => {
    const fixture = await createFixture();
    await fixture.host.ensureLayout();
    await writeFile(
      path.join(fixture.paths.stateRoot, "transaction.json"),
      "{not-json}\n",
      { mode: 0o600 },
    );
    const { receipt } = await install(fixture, "1.0.0", "77".repeat(16));
    expect(receipt).toMatchObject({ ok: false, code: "unsafe-state" });
    expect(fixture.machine.events).toEqual([]);
  });

  it("rejects v2 and rollback-shaped durable receipts and journals", () => {
    expect(() => decodeLinuxReleaseInstallerReceipt({
      schema: "vellum/linux-release-installer-receipt/v2",
      ok: false,
      state: "refused",
    })).toThrow();
    expect(() => decodeLinuxReleaseInstallerJournal({
      schema: "vellum/linux-release-installer-journal/v3",
      transactionId: "7".repeat(32),
      operation: "install",
      owner: { pid: 1, startTicks: "1", bootId },
      target: { uid: targetUid(), gid: targetGid(), host: "remote.test", stationId: "station" },
      fence: { record: { schema: "vellum/linux-release-fence/v1", fenceId: "8".repeat(32), transactionId: "7".repeat(32), operation: "install", targetUid: targetUid(), targetGid: targetGid(), stationId: "station", machineIdSha256: "c".repeat(64), bootId, candidateDigest: "d".repeat(64) }, device: "1", inode: "2", preGeneration: "b".repeat(32), postGeneration: null },
      manifestSha256: "e".repeat(64), debSha256: "f".repeat(64), sourceRevision: revision,
      fromVersion: "1.0.0", toVersion: "2.0.0", phase: "dpkg-started",
      oldServiceState: "enabled-active",
    })).toThrow();
    expect(() => decodeLinuxReleaseInstallerJournal({
      schema: "vellum/linux-release-installer-journal/v3",
      transactionId: "9".repeat(32),
      operation: "install",
      owner: { pid: 1, startTicks: "1", bootId },
      target: { uid: targetUid(), gid: targetGid(), host: "remote.test", stationId: "station" },
      fence: { record: { schema: "vellum/linux-release-fence/v1", fenceId: "a".repeat(32), transactionId: "9".repeat(32), operation: "recover", targetUid: targetUid(), targetGid: targetGid(), stationId: "station", machineIdSha256: "c".repeat(64), bootId, candidateDigest: "d".repeat(64) }, device: "1", inode: "2", preGeneration: "b".repeat(32), postGeneration: null },
      manifestSha256: "e".repeat(64), debSha256: "f".repeat(64), sourceRevision: revision,
      fromVersion: "1.0.0", toVersion: "2.0.0", phase: "dpkg-started",
    })).toThrow();
  });
});
