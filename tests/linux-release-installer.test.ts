import { createHash } from "node:crypto";
import {
  chmod,
  chown,
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
  runLinuxReleaseInstaller,
  type FixedCommandResult,
  type LinuxReleaseInstallerInvocation,
  type NodeLinuxReleaseInstallerHostOptions,
  type VerifiedProtectedLinuxBundle,
} from "../scripts/linux-release-installer";
import {
  LINUX_RELEASE_INSTALLER_MAX_FILE_BYTES,
  LINUX_RELEASE_INSTALLER_PROTOCOL,
  LINUX_RELEASE_INSTALLER_RECEIPT,
  encodeLinuxReleaseInstallerJournal,
  encodeLinuxReleaseInstallerReceipt,
  type LinuxReleaseInstallerCandidate,
  type LinuxReleaseInstallerJournal,
  type LinuxReleaseInstallerJournalPhase,
  type LinuxReleaseInstallerRequest,
} from "../src/shared/linux-release-installer";

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
  failRollback: boolean;
  failActivation: boolean;
  transientInstallActive: boolean;
  events: string[];
}

interface Fixture {
  readonly root: string;
  readonly paths: {
    readonly stateRoot: string;
    readonly spoolRoot: string;
    readonly cacheRoot: string;
    readonly runtimeRoot: string;
    readonly dpkgInfoRoot: string;
    readonly installedRoot: string;
  };
  readonly home: string;
  readonly invocation: LinuxReleaseInstallerInvocation;
  readonly machine: FakeMachine;
  readonly host: NodeLinuxReleaseInstallerHost;
  readonly lock: {
    held: boolean;
  };
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

const makeReadiness = (): string =>
  `${JSON.stringify({
    version: 1,
    generation,
    state: "ready",
    components: {
      version: "ready",
      role: "ready",
      host: "ready",
      package: "ready",
      supervisor: "ready",
      canvasPull: "ready",
      work: "ready",
      terminal: "ready",
      browserTransport: "ready",
      browserComposition: "ready",
      display: "ready",
      sandbox: "ready",
      browserCapability: "ready",
    },
  })}\n`;

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
    { readonly kind: "install" }
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
  return {
    request: {
      schema: LINUX_RELEASE_INSTALLER_PROTOCOL,
      kind: "install",
      transactionId,
      target: {
        uid: targetUid(),
        gid: targetGid(),
        host: "remote.test",
      },
      files,
    },
    body: [manifest, deb],
    candidate: {
      version,
      debSha256: sha256(deb),
      manifestSha256: sha256(manifest),
    },
  };
};

const frame = (
  request: LinuxReleaseInstallerRequest | Record<string, unknown>,
  body: ReadonlyArray<Uint8Array> = [],
): AsyncIterable<Uint8Array> =>
  Readable.from([
    Buffer.from(`${JSON.stringify(request)}\n`, "utf8"),
    ...body.map((value) => Buffer.from(value)),
  ]);

const readinessPath = (fixture: Fixture): string =>
  path.join(
    fixture.paths.runtimeRoot,
    String(fixture.invocation.sudoUid),
    "vellum",
    "station-ready.json",
  );

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
      if (unit.includes("rollback") && machine.failRollback) {
        machine.events.push("rollback-failed");
        return result(1);
      }
      if (operation === "--purge") {
        machine.events.push("purge");
        machine.version = null;
        machine.packageStatus = "install ok installed";
        machine.service = "absent-inactive";
        return result(0);
      }
      if (operation === "--install") {
        const source = argumentsArray[dpkg + 2] ?? "";
        const decoded = JSON.parse(await readFile(source, "utf8")) as {
          readonly version: string;
        };
        machine.version = decoded.version;
        machine.packageStatus =
          !unit.includes("rollback") && machine.failInstallAfterMutation
            ? "install ok half-configured"
            : "install ok installed";
        machine.events.push(
          unit.includes("rollback")
            ? `rollback:${decoded.version}`
            : `install:${decoded.version}`,
        );
        if (
          !unit.includes("rollback") &&
          machine.failInstallAfterMutation
        ) {
          machine.failInstallAfterMutation = false;
          return result(1);
        }
        return result(0);
      }
    }
    if (executable === "/usr/bin/systemctl") {
      if (
        argumentsArray[0] === "is-active" &&
        argumentsArray[1]?.startsWith("vellum-release-install-")
      ) {
        return machine.transientInstallActive
          ? result(0, "active\n")
          : result(4);
      }
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
        machine.service = machine.service.endsWith("active") &&
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
          "vellum",
        );
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (rootOwnerUid() === 0) {
          await chown(directory, targetUid(), targetGid());
        }
        const receipt = path.join(directory, "station-ready.json");
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
    cacheRoot: path.join(root, "cache"),
    runtimeRoot: path.join(root, "run"),
    dpkgInfoRoot: path.join(root, "dpkg-info"),
    installedRoot: path.join(root, "installed"),
  };
  const home = path.join(root, "home");
  await mkdir(home, { mode: 0o700 });
  if (rootOwnerUid() === 0) {
    await chown(home, targetUid(), targetGid());
  }
  await startBus(paths.runtimeRoot, targetUid(), targetGid());
  await mkdir(paths.dpkgInfoRoot, { mode: 0o755 });
  await mkdir(paths.installedRoot, { mode: 0o755 });
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
    failRollback: false,
    failActivation: false,
    transientInstallActive: false,
    events: [],
  };
  const lock = { held: false };
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
  });
  return { root, paths, home, invocation, machine, host, lock };
};

const install = async (
  fixture: Fixture,
  version: string,
  transactionId: string,
  variant = "release",
) => {
  const release = bundle(version, transactionId, variant);
  const receipt = await runLinuxReleaseInstaller(
    frame(release.request, release.body),
    fixture.invocation,
    fixture.host,
  );
  return { release, receipt };
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
  it("keeps probe exact and mutation-free before bootstrap", async () => {
    const fixture = await createFixture();
    const release = bundle("1.0.0", "1".repeat(32));
    const request: LinuxReleaseInstallerRequest = {
      schema: LINUX_RELEASE_INSTALLER_PROTOCOL,
      kind: "probe",
      target: release.request.target,
      candidate: release.candidate,
    };
    const receipt = await runLinuxReleaseInstaller(
      frame(request),
      fixture.invocation,
      fixture.host,
    );
    expect(encodeLinuxReleaseInstallerReceipt(receipt)).toBe(
      `${JSON.stringify({
        schema: LINUX_RELEASE_INSTALLER_RECEIPT,
        ok: true,
        state: "ready",
        protocol: LINUX_RELEASE_INSTALLER_PROTOCOL,
        target: release.request.target,
        currentVersion: null,
        artifactMatches: false,
        journalState: "clear",
      })}\n`,
    );
    await expect(lstat(fixture.paths.stateRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
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

  it("rejects truncated bodies, removes the stage, and releases the lock", async () => {
    const fixture = await createFixture();
    const release = bundle("1.0.0", "3".repeat(32));
    const receipt = await runLinuxReleaseInstaller(
      frame(release.request, [release.body[0]!, release.body[1]!.subarray(1)]),
      fixture.invocation,
      fixture.host,
    );
    expect(receipt).toMatchObject({ ok: false, code: "protocol" });
    expect(fixture.lock.held).toBe(false);
    expect(await readFile(path.join(fixture.paths.stateRoot, "transaction.lock")))
      .toHaveLength(0);
    expect(await lstat(fixture.paths.spoolRoot)).toMatchObject({
      mode: expect.any(Number),
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
  });

  it("installs first release, fsyncs durable cache, and proves exact no-op", async () => {
    const fixture = await createFixture();
    const { release, receipt } = await install(
      fixture,
      "1.0.0",
      "5".repeat(32),
    );
    expect(receipt).toMatchObject({
      ok: true,
      state: "installed",
      fromVersion: null,
      toVersion: "1.0.0",
    });
    const cache = path.join(fixture.paths.cacheRoot, "v-1.0.0");
    expect((await stat(cache)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(cache, "package.deb"))).mode & 0o777)
      .toBe(0o600);
    await expect(
      lstat(path.join(fixture.paths.stateRoot, "transaction.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const probe: LinuxReleaseInstallerRequest = {
      schema: LINUX_RELEASE_INSTALLER_PROTOCOL,
      kind: "probe",
      target: release.request.target,
      candidate: release.candidate,
    };
    expect(
      await runLinuxReleaseInstaller(
        frame(probe),
        fixture.invocation,
        fixture.host,
      ),
    ).toMatchObject({
      ok: true,
      currentVersion: "1.0.0",
      artifactMatches: true,
      journalState: "clear",
    });
  });

  it("adopts an exact signed installed baseline and activates disabled Remote", async () => {
    const fixture = await createFixture();
    await seedInstalledBaseline(fixture, "1.0.0");
    const receipt = (await install(
      fixture,
      "1.0.0",
      "5a".repeat(16),
    )).receipt;
    expect(receipt).toMatchObject({
      ok: true,
      state: "installed",
      fromVersion: "1.0.0",
      toVersion: "1.0.0",
    });
    expect(fixture.machine.events).toEqual([]);
    expect(fixture.machine.service).toBe("enabled-active");
    expect(fixture.machine.linger).toBe(true);
    expect(
      await readFile(
        path.join(fixture.paths.cacheRoot, "v-1.0.0", "package.deb"),
      ),
    ).toEqual(packagePayload("1.0.0"));
  });

  it("restores service and linger when baseline adoption activation fails", async () => {
    const fixture = await createFixture();
    await seedInstalledBaseline(fixture, "1.0.0");
    fixture.machine.failActivation = true;
    const receipt = (await install(
      fixture,
      "1.0.0",
      "5b".repeat(16),
    )).receipt;
    expect(receipt).toMatchObject({
      ok: false,
      state: "rolled-back",
      code: "install-failed",
    });
    expect(fixture.machine.version).toBe("1.0.0");
    expect(fixture.machine.service).toBe("disabled-inactive");
    expect(fixture.machine.linger).toBe(false);
    expect(fixture.machine.events).toEqual([]);
    await expect(
      lstat(path.join(fixture.paths.cacheRoot, "v-1.0.0")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses baseline adoption when one installed payload byte differs", async () => {
    const fixture = await createFixture();
    await seedInstalledBaseline(fixture, "1.0.0");
    await writeFile(
      path.join(
        fixture.paths.installedRoot,
        "opt",
        "Vellum",
        "app.bin",
      ),
      "payload:tampered",
      { mode: 0o644 },
    );
    const receipt = (await install(
      fixture,
      "1.0.0",
      "5f".repeat(16),
    )).receipt;
    expect(receipt).toMatchObject({
      ok: false,
      code: "unsafe-state",
      action: "repair-root-installer-state-manually",
    });
    expect(fixture.machine.service).toBe("disabled-inactive");
    expect(fixture.machine.events).toEqual([]);
    await expect(
      lstat(path.join(fixture.paths.cacheRoot, "v-1.0.0")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["activation-started", "verified"] as const)(
    "recovers stale adoption %s without invoking dpkg",
    async (phase) => {
      const fixture = await createFixture();
      await seedInstalledBaseline(fixture, "1.0.0");
      const release = bundle("1.0.0", "5c".repeat(16));
      await fixture.host.ensureLayout();
      const journal: LinuxReleaseInstallerJournal = {
        schema: "vellum/linux-release-installer-journal/v1",
        transactionId: "5d".repeat(16),
        operation: "adopt",
        owner: { pid: 1, startTicks: "1", bootId },
        target: release.request.target,
        manifestSha256: release.candidate.manifestSha256,
        debSha256: release.candidate.debSha256,
        sourceRevision: revision,
        fromVersion: "1.0.0",
        toVersion: "1.0.0",
        priorArtifactSha256: null,
        oldServiceState: "disabled-inactive",
        oldLinger: false,
        phase,
      };
      fixture.machine.service = "enabled-active";
      fixture.machine.linger = true;
      await fixture.host.writeJournal(journal);
      const receipt = (await install(
        fixture,
        "1.0.0",
        "5e".repeat(16),
      )).receipt;
      expect(receipt).toMatchObject({
        ok: true,
        recoveredTransactionId: "5d".repeat(16),
      });
      expect(fixture.machine.events).toEqual([]);
    },
  );

  it("serializes probe with the same kernel lease and fails closed while busy", async () => {
    const fixture = await createFixture();
    await fixture.host.ensureLayout();
    const lease = await fixture.host.acquireLock(fixture.invocation.process);
    const release = bundle("1.0.0", "6".repeat(32));
    const probe: LinuxReleaseInstallerRequest = {
      schema: LINUX_RELEASE_INSTALLER_PROTOCOL,
      kind: "probe",
      target: release.request.target,
      candidate: release.candidate,
    };
    expect(
      await runLinuxReleaseInstaller(
        frame(probe),
        fixture.invocation,
        fixture.host,
      ),
    ).toMatchObject({
      ok: true,
      artifactMatches: false,
      journalState: "busy",
    });
    await lease.release();
  });

  it("refuses a reissued same version without replacing rollback authority", async () => {
    const fixture = await createFixture();
    await install(fixture, "1.0.0", "7".repeat(32));
    const original = await readFile(
      path.join(fixture.paths.cacheRoot, "v-1.0.0", "package.deb"),
    );
    const receipt = (await install(
      fixture,
      "1.0.0",
      "8".repeat(32),
      "different-bits",
    )).receipt;
    expect(receipt).toMatchObject({ ok: false, code: "policy" });
    expect(
      await readFile(
        path.join(fixture.paths.cacheRoot, "v-1.0.0", "package.deb"),
      ),
    ).toEqual(original);
    expect(fixture.machine.version).toBe("1.0.0");
  });

  it("rolls back a half-configured dpkg failure before clearing the journal", async () => {
    const fixture = await createFixture();
    await install(fixture, "1.0.0", "9".repeat(32));
    fixture.machine.failInstallAfterMutation = true;
    const receipt = (await install(
      fixture,
      "2.0.0",
      "a".repeat(32),
    )).receipt;
    expect(receipt).toMatchObject({
      ok: false,
      state: "rolled-back",
      code: "install-failed",
    });
    expect(fixture.machine.version).toBe("1.0.0");
    expect(fixture.machine.events).toContain("rollback:1.0.0");
    await expect(
      lstat(path.join(fixture.paths.stateRoot, "transaction.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains rollback-started journal on rollback failure and recovers it first", async () => {
    const fixture = await createFixture();
    await install(fixture, "1.0.0", "b".repeat(32));
    fixture.machine.failInstallAfterMutation = true;
    fixture.machine.failRollback = true;
    const failed = (await install(
      fixture,
      "2.0.0",
      "c".repeat(32),
    )).receipt;
    expect(failed).toMatchObject({
      ok: false,
      code: "rollback-failed",
      action: "repair-root-installer-state-manually",
    });
    expect(
      JSON.parse(
        await readFile(
          path.join(fixture.paths.stateRoot, "transaction.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ phase: "rollback-started" });
    fixture.machine.failRollback = false;
    const recovered = (await install(
      fixture,
      "2.0.0",
      "d".repeat(32),
    )).receipt;
    expect(recovered).toMatchObject({
      ok: true,
      state: "installed",
      recoveredTransactionId: "c".repeat(32),
    });
    expect(
      fixture.machine.events.lastIndexOf("rollback:1.0.0"),
    ).toBeLessThan(fixture.machine.events.lastIndexOf("install:2.0.0"));
  });

  it("refuses recovery while a prior systemd dpkg scope is still live", async () => {
    const fixture = await createFixture();
    const first = await install(fixture, "1.0.0", "e".repeat(32));
    const journal: LinuxReleaseInstallerJournal = {
      schema: "vellum/linux-release-installer-journal/v1",
      transactionId: "f".repeat(32),
      operation: "install",
      owner: { pid: 1, startTicks: "1", bootId },
      target: first.release.request.target,
      manifestSha256: first.release.candidate.manifestSha256,
      debSha256: sha256(packagePayload("2.0.0")),
      sourceRevision: revision,
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      priorArtifactSha256: first.release.candidate.debSha256,
      oldServiceState: "enabled-active",
      oldLinger: true,
      phase: "dpkg-started",
    };
    await fixture.host.writeJournal(journal);
    fixture.machine.version = "2.0.0";
    fixture.machine.transientInstallActive = true;
    const receipt = (await install(
      fixture,
      "2.0.0",
      "0".repeat(32),
    )).receipt;
    expect(receipt).toMatchObject({ ok: false, code: "rollback-failed" });
    expect(fixture.machine.events.filter((value) => value === "install:2.0.0"))
      .toHaveLength(0);
  });

  it("does not reinstall the prior artifact when recovery already sees it installed", async () => {
    const fixture = await createFixture();
    const first = await install(fixture, "1.0.0", "4a".repeat(16));
    const start = fixture.machine.events.length;
    const journal: LinuxReleaseInstallerJournal = {
      schema: "vellum/linux-release-installer-journal/v1",
      transactionId: "4b".repeat(16),
      operation: "install",
      owner: { pid: 1, startTicks: "1", bootId },
      target: first.release.request.target,
      manifestSha256: sha256("manifest:2"),
      debSha256: sha256(packagePayload("2.0.0")),
      sourceRevision: revision,
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      priorArtifactSha256: first.release.candidate.debSha256,
      oldServiceState: "enabled-active",
      oldLinger: true,
      phase: "dpkg-started",
    };
    await fixture.host.writeJournal(journal);
    const receipt = (await install(
      fixture,
      "2.0.0",
      "4c".repeat(16),
    )).receipt;
    expect(receipt).toMatchObject({
      ok: true,
      recoveredTransactionId: "4b".repeat(16),
    });
    expect(fixture.machine.events.slice(start)).toEqual(["install:2.0.0"]);
  });

  it("refuses stale rollback over an unrelated installed version", async () => {
    const fixture = await createFixture();
    const first = await install(fixture, "1.0.0", "4d".repeat(16));
    const start = fixture.machine.events.length;
    const journal: LinuxReleaseInstallerJournal = {
      schema: "vellum/linux-release-installer-journal/v1",
      transactionId: "4e".repeat(16),
      operation: "install",
      owner: { pid: 1, startTicks: "1", bootId },
      target: first.release.request.target,
      manifestSha256: sha256("manifest:2"),
      debSha256: sha256(packagePayload("2.0.0")),
      sourceRevision: revision,
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      priorArtifactSha256: first.release.candidate.debSha256,
      oldServiceState: "enabled-active",
      oldLinger: true,
      phase: "activation-started",
    };
    await fixture.host.writeJournal(journal);
    fixture.machine.version = "3.0.0";
    fixture.machine.packageStatus = "install ok installed";
    const receipt = (await install(
      fixture,
      "3.0.0",
      "4f".repeat(16),
    )).receipt;
    expect(receipt).toMatchObject({
      ok: false,
      code: "rollback-failed",
      action: "repair-root-installer-state-manually",
    });
    expect(fixture.machine.version).toBe("3.0.0");
    expect(fixture.machine.events.slice(start)).toEqual([]);
    expect(
      JSON.parse(
        await readFile(
          path.join(fixture.paths.stateRoot, "transaction.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ phase: "rollback-started" });
  });

  it.each([
    "prepared",
    "dpkg-started",
    "dpkg-installed",
    "activation-started",
    "verified",
    "rollback-started",
    "rolled-back",
  ] satisfies LinuxReleaseInstallerJournalPhase[])(
    "recovers a valid stale %s journal before a fresh transaction",
    async (phase) => {
      const fixture = await createFixture();
      const first = await install(fixture, "1.0.0", "1".repeat(32));
      const start = fixture.machine.events.length;
      if (phase !== "prepared" && phase !== "rolled-back") {
        fixture.machine.version = "2.0.0";
      }
      const journal: LinuxReleaseInstallerJournal = {
        schema: "vellum/linux-release-installer-journal/v1",
        transactionId: "2".repeat(32),
        operation: "install",
        owner: { pid: 1, startTicks: "1", bootId },
        target: first.release.request.target,
        manifestSha256: sha256("manifest:2"),
        debSha256: sha256(packagePayload("2.0.0")),
        sourceRevision: revision,
        fromVersion: "1.0.0",
        toVersion: "2.0.0",
        priorArtifactSha256: first.release.candidate.debSha256,
        oldServiceState: "enabled-active",
        oldLinger: true,
        phase,
      };
      await fixture.host.writeJournal(journal);
      const result = await install(
        fixture,
        "2.0.0",
        "3".repeat(32),
      );
      expect(result.receipt).toMatchObject({
        ok: true,
        recoveredTransactionId: "2".repeat(32),
      });
      const events = fixture.machine.events.slice(start);
      if (phase === "prepared" || phase === "rolled-back") {
        expect(events).toEqual(["install:2.0.0"]);
      } else {
        expect(events[0]).toBe("rollback:1.0.0");
        expect(events.at(-1)).toBe("install:2.0.0");
      }
    },
  );

  it("refuses malformed root journal without package mutation", async () => {
    const fixture = await createFixture();
    await fixture.host.ensureLayout();
    await writeFile(
      path.join(fixture.paths.stateRoot, "transaction.json"),
      '{"malformed":true}\n',
      { mode: 0o600 },
    );
    const receipt = (await install(
      fixture,
      "1.0.0",
      "4".repeat(32),
    )).receipt;
    expect(receipt).toMatchObject({
      ok: false,
      code: "unsafe-state",
      action: "repair-root-installer-state-manually",
    });
    expect(fixture.machine.events).toEqual([]);
  });

  it("reconciles strict crash orphans but refuses unknown root entries", async () => {
    const fixture = await createFixture();
    await fixture.host.ensureLayout();
    const orphan = path.join(fixture.paths.spoolRoot, "5".repeat(32));
    await mkdir(orphan, { mode: 0o700 });
    await writeFile(path.join(orphan, "vellum.deb"), "partial", {
      mode: 0o600,
    });
    const control = path.join(orphan, ".candidate-control");
    await mkdir(control, { mode: 0o700 });
    await writeFile(path.join(control, "control"), "partial", {
      mode: 0o600,
    });
    const payload = path.join(orphan, ".candidate-payload", "opt", "Vellum");
    await mkdir(payload, { recursive: true, mode: 0o755 });
    await chmod(path.join(orphan, ".candidate-payload"), 0o700);
    await writeFile(path.join(payload, "app.bin"), "partial", {
      mode: 0o600,
    });
    await fixture.host.reconcileOrphans();
    await expect(lstat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(path.join(fixture.paths.spoolRoot, "unknown"), "x", {
      mode: 0o600,
    });
    await expect(fixture.host.reconcileOrphans()).rejects.toThrow(
      "unrecognized root entry",
    );
  });

  it("decodes only canonical durable journal bytes used by recovery", async () => {
    const fixture = await createFixture();
    await fixture.host.ensureLayout();
    const release = bundle("1.0.0", "6".repeat(32));
    const journal: LinuxReleaseInstallerJournal = {
      schema: "vellum/linux-release-installer-journal/v1",
      transactionId: "6".repeat(32),
      operation: "install",
      owner: fixture.invocation.process,
      target: release.request.target,
      manifestSha256: release.candidate.manifestSha256,
      debSha256: release.candidate.debSha256,
      sourceRevision: revision,
      fromVersion: null,
      toVersion: "1.0.0",
      priorArtifactSha256: null,
      oldServiceState: "absent-inactive",
      oldLinger: false,
      phase: "prepared",
    };
    await fixture.host.writeJournal(journal);
    expect(
      await readFile(
        path.join(fixture.paths.stateRoot, "transaction.json"),
        "utf8",
      ),
    ).toBe(encodeLinuxReleaseInstallerJournal(journal));
  });
});
