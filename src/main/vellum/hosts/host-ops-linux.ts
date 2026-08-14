import { Effect } from "effect";
import type { Context } from "effect";
import type { HostWorkAttach } from "@shared/host-runtime";
import type {
  HostOpsActivate,
  HostOpsAttach,
  HostOpsCleanup,
  HostOpsConfigure,
  HostOpsCopy,
  HostOpsInspect,
} from "@shared/host-ops";
import type { RemoteHost } from "@shared/remote-hosts";
import { stationControlDir, stationDoorSocketPath } from "@shared/station-ssh-control";
import {
  workControlDir,
  workControlSocketPath,
  workControlTokenPath,
} from "@shared/work-control";
import { inspectSshTarget, type SshTarget } from "../ssh/domain";
import { homeDirectoryLookup } from "../ssh/program";
import { SshTransport } from "../ssh/service";
import {
  configureRemoteHost,
  type ConfigureRemoteOptions,
} from "./configure-remote";
import {
  activateLinuxRemoteRuntimeForTarget,
  observeLinuxUserlandPackage,
} from "./deploy-linux";
import type {
  DeployableRemoteHost,
  RemoteDeploymentTarget,
} from "./remote-deployment";
import {
  combineHostProcessPlanes,
  handshakeLinuxWorkControl,
  probeRemoteDoorSocket,
  readRemoteTextFile,
  withRemoteUnixForward,
  workAttachFromTokenFile,
} from "./host-runtime-platform";
import { decodeRemoteHomeDirectoryOutput } from "./remote-home";

const hostRecordFromTarget = (target: SshTarget): DeployableRemoteHost => {
  const details = inspectSshTarget(target);
  const endpoint = details.endpoint;
  const id = hostIdFromEndpoint(endpoint);
  return {
    id,
    label: id,
    kind: "remote",
    sshEndpoint: endpoint,
    capabilities: ["terminal"],
    ...(details.identityFile === undefined
      ? {}
      : { sshIdentityFile: details.identityFile }),
    ...(details.hostKeyPolicy === "system"
      ? {}
      : { sshHostKeyPolicy: details.hostKeyPolicy }),
  };
};

const hostIdFromEndpoint = (endpoint: string): string => {
  const cleaned = endpoint
    .replace(/[^A-Za-z0-9._-]/gu, "-")
    .replace(/^-+/u, "")
    .slice(0, 64);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(cleaned) ? cleaned : "remote";
};

const linuxDeploymentTarget = (target: SshTarget): RemoteDeploymentTarget => ({
  host: hostRecordFromTarget(target),
  endpoint: inspectSshTarget(target).endpoint,
  sshTarget: target,
  platform: { platform: "linux", kernelName: "Linux" },
  progress: [],
});

const inspectLinuxProcess = (
  ssh: Context.Service.Shape<typeof SshTransport>,
  target: SshTarget,
  home: string,
): Effect.Effect<HostOpsInspect["process"]> =>
  Effect.gen(function* () {
    const stationHome = stationControlDir(home);
    const enroll = yield* probeRemoteDoorSocket(
      ssh,
      target,
      stationDoorSocketPath(stationHome, "enroll"),
    );
    const peer = yield* probeRemoteDoorSocket(
      ssh,
      target,
      stationDoorSocketPath(stationHome, "peer"),
    );
    return combineHostProcessPlanes(enroll, peer);
  });

/** Ready is an NDJSON work-control handshake. Sock-on-disk is not Ready. */
const probeLinuxWorkAttach = (
  ssh: Context.Service.Shape<typeof SshTransport>,
  target: SshTarget,
  home: string,
): Effect.Effect<HostWorkAttach> =>
  Effect.gen(function* () {
    const workHome = workControlDir(home);
    const token = yield* readRemoteTextFile(
      ssh,
      target,
      workControlTokenPath(workHome),
    );
    const fromToken = workAttachFromTokenFile(token);
    if (fromToken !== undefined) return fromToken;
    if (token._tag !== "present") return "unknown";
    return yield* withRemoteUnixForward(
      ssh,
      target,
      workControlSocketPath(workHome),
      (localSocket) =>
        Effect.tryPromise({
          try: () => handshakeLinuxWorkControl(localSocket, token.text),
          catch: () => new Error("work-control handshake failed"),
        }).pipe(Effect.orElseSucceed(() => "unknown" as const)),
    );
  });

const attachReceipt = (
  workAttach: HostWorkAttach,
  observedAt: string,
  detail?: string,
): HostOpsAttach => ({
  ok: workAttach === "up",
  workAttach,
  detail:
    detail ??
    (workAttach === "up"
      ? "work attach connected"
      : `work attach ${workAttach}`),
  observedAt,
});

export const inspectLinuxHost = (
  ssh: Context.Service.Shape<typeof SshTransport>,
  target: SshTarget,
): Effect.Effect<HostOpsInspect> =>
  Effect.gen(function* () {
    const observedAt = new Date().toISOString();
    const endpoint = inspectSshTarget(target).endpoint;
    const warm = yield* ssh.warm(target).pipe(Effect.result);
    if (warm._tag === "Failure") {
      return {
        endpoint,
        platform: "linux" as const,
        network: "down" as const,
        package: "unknown" as const,
        deployLock: "absent" as const,
        incoming: "absent" as const,
        termSocket: "unknown" as const,
        process: "unknown" as const,
        workAttach: "unknown" as const,
        observedAt,
      };
    }
    const homeResult = yield* ssh.run(homeDirectoryLookup(target)).pipe(Effect.result);
    const home =
      homeResult._tag === "Success"
        ? decodeRemoteHomeDirectoryOutput(homeResult.success.stdout)
        : null;
    const pkg = yield* observeLinuxUserlandPackage(ssh, target);
    let processPlane: HostOpsInspect["process"] = "unknown";
    let workAttach: HostOpsInspect["workAttach"] = "unknown";
    if (home !== null) {
      processPlane = yield* inspectLinuxProcess(ssh, target, home);
      workAttach = yield* probeLinuxWorkAttach(ssh, target, home);
    }
    return {
      endpoint,
      platform: "linux" as const,
      network: "up" as const,
      ...(home === null ? {} : { home }),
      package: pkg,
      deployLock: "absent" as const,
      incoming: "absent" as const,
      termSocket: "unknown" as const,
      process: processPlane,
      workAttach,
      observedAt,
    };
  });

export const copyLinuxHost = (
  _ssh: Context.Service.Shape<typeof SshTransport>,
  _target: SshTarget,
): Effect.Effect<HostOpsCopy> =>
  Effect.succeed({
    ok: false,
    exit: null,
    stdout: "",
    stderr: "Linux Remote Deploy is not enabled",
    tag: "LINUX_REMOTE_DEPLOY_OFF",
    expectedPackage: "unknown",
    after: {
      package: "unknown",
      deployLock: "absent",
      incoming: "absent",
      termSocket: "unknown",
    },
    elapsedMs: 0,
    observedAt: new Date().toISOString(),
  });

export const cleanupLinuxHost = (
  _ssh: Context.Service.Shape<typeof SshTransport>,
  _target: SshTarget,
): Effect.Effect<HostOpsCleanup> =>
  Effect.succeed({
    ok: true,
    removed: [],
    stderr: "",
    observedAt: new Date().toISOString(),
  });

export const configureLinuxHost = (
  ssh: Context.Service.Shape<typeof SshTransport>,
  target: SshTarget,
  facts: ConfigureRemoteOptions,
): Effect.Effect<HostOpsConfigure> =>
  Effect.gen(function* () {
    const observedAt = new Date().toISOString();
    const host: RemoteHost = hostRecordFromTarget(target);
    const result = yield* configureRemoteHost(ssh, host, facts).pipe(
      Effect.result,
    );
    if (result._tag === "Failure") {
      return {
        ok: false,
        detail: result.failure.message,
        code: result.failure.code,
        observedAt,
      };
    }
    return {
      ok: result.success.ok,
      detail: result.success.detail,
      ...(result.success.stationInstallationId === undefined
        ? {}
        : { stationInstallationId: result.success.stationInstallationId }),
      ...(result.success.configuredAt === undefined
        ? {}
        : { configuredAt: result.success.configuredAt }),
      ...(result.success.code === undefined ? {} : { code: result.success.code }),
      observedAt,
    };
  });

export const activateLinuxHost = (
  ssh: Context.Service.Shape<typeof SshTransport>,
  target: SshTarget,
): Effect.Effect<HostOpsActivate> =>
  Effect.gen(function* () {
    const observedAt = new Date().toISOString();
    const result = yield* activateLinuxRemoteRuntimeForTarget(
      ssh,
      linuxDeploymentTarget(target),
    );
    return {
      ok: result.ok,
      detail: result.detail,
      stages: [...result.stages],
      ...(result.disposition === undefined
        ? {}
        : { disposition: result.disposition }),
      ...(result.code === undefined ? {} : { code: result.code }),
      observedAt,
    };
  });

export const attachLinuxHost = (
  ssh: Context.Service.Shape<typeof SshTransport>,
  target: SshTarget,
): Effect.Effect<HostOpsAttach> =>
  Effect.gen(function* () {
    const observedAt = new Date().toISOString();
    const homeResult = yield* ssh
      .run(homeDirectoryLookup(target))
      .pipe(Effect.result);
    if (homeResult._tag === "Failure") {
      return attachReceipt("unknown", observedAt, "remote home lookup failed");
    }
    const home = decodeRemoteHomeDirectoryOutput(homeResult.success.stdout);
    if (home === null) {
      return attachReceipt(
        "unknown",
        observedAt,
        "remote home is not a canonical absolute path",
      );
    }
    return attachReceipt(
      yield* probeLinuxWorkAttach(ssh, target, home),
      observedAt,
    );
  });
