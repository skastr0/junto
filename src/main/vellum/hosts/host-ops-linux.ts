import { Effect } from "effect";
import type { Context } from "effect";
import type { HostOpsCleanup, HostOpsCopy, HostOpsInspect } from "@shared/host-ops";
import { inspectSshTarget, type SshTarget } from "../ssh/domain";
import { homeDirectoryLookup } from "../ssh/program";
import { SshTransport } from "../ssh/service";
import { decodeRemoteHomeDirectoryOutput } from "./remote-home";

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
        observedAt,
      };
    }
    const homeResult = yield* ssh.run(homeDirectoryLookup(target)).pipe(Effect.result);
    const home =
      homeResult._tag === "Success"
        ? decodeRemoteHomeDirectoryOutput(homeResult.success.stdout)
        : null;
    return {
      endpoint,
      platform: "linux" as const,
      network: "up" as const,
      ...(home === null ? {} : { home }),
      package: "unknown" as const,
      deployLock: "absent" as const,
      incoming: "absent" as const,
      termSocket: "unknown" as const,
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

