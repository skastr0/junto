import { Effect } from "effect";
import type { Context } from "effect";
import type { HostOpsInspect } from "@shared/host-ops";
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

