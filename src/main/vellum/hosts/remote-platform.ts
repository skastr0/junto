import { Effect } from "effect";
import type { RemoteHost } from "@shared/remote-hosts";
import { inspectSshTarget, parseHostSshRoute } from "../ssh/domain";
import { formatSshFailure } from "../ssh/format";
import { oneShot } from "../ssh/program";
import { remoteUname } from "../ssh/read-commands";
import type { SshTransportShape } from "../ssh/service";
import type {
  DeployableRemoteHost,
  DeployRemoteResult,
  RemoteDeploymentPreparation,
  RemotePlatformDescriptor,
  UnsupportedRemoteTarget,
} from "./remote-deployment";

type Ssh = SshTransportShape;

export type RemotePlatformEvidence =
  | { readonly ok: true; readonly platform: RemotePlatformDescriptor }
  | {
      readonly ok: false;
      readonly unsupportedTarget: UnsupportedRemoteTarget;
    };

const PLATFORM_TOKEN = /^[A-Za-z][A-Za-z0-9._-]{0,31}$/u;

/** Accept exactly one bounded uname record with exactly one LF terminator. */
export const decodeRemotePlatformEvidence = (
  output: string,
): RemotePlatformEvidence => {
  if (!output.endsWith("\n")) {
    return {
      ok: false,
      unsupportedTarget: {
        kind: "unsupported-target",
        evidence: "malformed",
      },
    };
  }
  const kernelName = output.slice(0, -1);
  if (
    kernelName.includes("\n") ||
    kernelName.trim() !== kernelName ||
    !PLATFORM_TOKEN.test(kernelName)
  ) {
    return {
      ok: false,
      unsupportedTarget: {
        kind: "unsupported-target",
        evidence: "malformed",
      },
    };
  }
  if (kernelName === "Darwin") {
    return {
      ok: true,
      platform: { platform: "darwin", kernelName: "Darwin" },
    };
  }
  if (kernelName === "Linux") {
    return {
      ok: true,
      platform: { platform: "linux", kernelName: "Linux" },
    };
  }
  return {
    ok: false,
    unsupportedTarget: {
      kind: "unsupported-target",
      evidence: "unsupported",
      reportedKernel: kernelName,
    },
  };
};

export const remoteDeploymentFailure = (
  detail: string,
  input: {
    readonly code: NonNullable<DeployRemoteResult["code"]>;
    readonly stages?: readonly string[];
    readonly message?: string;
    readonly unsupportedTarget?: UnsupportedRemoteTarget;
  },
): DeployRemoteResult => ({
  ok: false,
  detail,
  code: input.code,
  ...(input.message ? { message: input.message } : {}),
  stages: input.stages ?? [],
  disposition: "not-started",
  ...(input.unsupportedTarget
    ? { unsupportedTarget: input.unsupportedTarget }
    : {}),
});

export const unsupportedRemoteTargetResult = (
  host: DeployableRemoteHost,
  issue: UnsupportedRemoteTarget,
  stages: readonly string[],
): DeployRemoteResult => {
  const reported = issue.reportedKernel ?? "unknown";
  return remoteDeploymentFailure(
    issue.evidence === "malformed"
      ? `${host.label}: remote OS evidence is malformed — Deploy Remote refused the target`
      : `${host.label}: remote OS is ${reported} — full-app Deploy is macOS-only`,
    {
      code: "validation",
      message:
        issue.evidence === "malformed"
          ? "remote platform evidence malformed"
          : "remote not Darwin",
      stages,
      unsupportedTarget: issue,
    },
  );
};

/** Read-only admission. No artifact lookup, transfer, or station write occurs here. */
export const resolveRemoteDeploymentTarget = (
  ssh: Ssh,
  host: RemoteHost,
  commandCenterPlatform: NodeJS.Platform,
): Effect.Effect<RemoteDeploymentPreparation, never> =>
  Effect.gen(function* () {
    if (commandCenterPlatform !== "darwin") {
      return {
        ok: false,
        result: remoteDeploymentFailure(
          "Deploy Remote must run from a macOS Command Center (local .app source)",
          { code: "validation" },
        ),
      };
    }
    if (host.kind !== "remote" || !host.sshEndpoint) {
      return {
        ok: false,
        result: remoteDeploymentFailure(
          `host ${host.id} is not a remote SSH endpoint`,
          { code: "validation" },
        ),
      };
    }
    const remoteHost = host as DeployableRemoteHost;

    const sshTarget = yield* parseHostSshRoute(host).pipe(Effect.result);
    if (sshTarget._tag === "Failure") {
      return {
        ok: false,
        result: remoteDeploymentFailure(
          `Invalid endpoint: ${sshTarget.failure.message}`,
          {
            code: "validation",
          },
        ),
      };
    }
    const stages: string[] = ["endpoint ok"];

    const warm = yield* ssh.warm(sshTarget.success).pipe(Effect.result);
    if (warm._tag === "Failure") {
      return {
        ok: false,
        result: remoteDeploymentFailure(
          `${host.label}: SSH connection failed — ${formatSshFailure(warm.failure)}`,
          { code: "io", stages },
        ),
      };
    }
    stages.push("ssh warm ok");

    const unameCommand = yield* remoteUname().pipe(
      Effect.result,
    );
    if (unameCommand._tag === "Failure") {
      return {
        ok: false,
        result: remoteDeploymentFailure(
          `${host.label}: could not construct the remote OS probe`,
          { code: "validation", stages },
        ),
      };
    }
    const uname = yield* ssh
      .run(oneShot(sshTarget.success, unameCommand.success, { budget: "short" }))
      .pipe(Effect.result);
    if (uname._tag === "Failure") {
      return {
        ok: false,
        result: remoteDeploymentFailure(
          `${host.label}: remote OS probe failed`,
          {
            code: "io",
            stages,
          },
        ),
      };
    }

    const evidence = decodeRemotePlatformEvidence(uname.success.stdout);
    if (!evidence.ok) {
      if (evidence.unsupportedTarget.reportedKernel) {
        stages.push(
          `remote uname ${evidence.unsupportedTarget.reportedKernel}`,
        );
      }
      return {
        ok: false,
        result: unsupportedRemoteTargetResult(
          remoteHost,
          evidence.unsupportedTarget,
          stages,
        ),
      };
    }
    stages.push(`remote uname ${evidence.platform.kernelName}`);

    return {
      ok: true,
      target: Object.freeze({
        host: remoteHost,
        endpoint: inspectSshTarget(sshTarget.success).endpoint,
        sshTarget: sshTarget.success,
        platform: evidence.platform,
        progress: Object.freeze([...stages]),
      }),
    };
  });
