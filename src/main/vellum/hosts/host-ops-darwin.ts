import { join } from "node:path";
import { Effect } from "effect";
import type { Context } from "effect";
import type { HostOpsInspect, HostOpsPresence } from "@shared/host-ops";
import { TERM_REMOTE_SOCK_REL } from "@shared/term-control";
import { inspectSshTarget, SshExitError, type SshTarget } from "../ssh/domain";
import { homeDirectoryLookup, oneShot } from "../ssh/program";
import {
  remoteDarwinDeployLockExists,
  remoteDarwinIncomingExists,
  remoteDarwinPackageExists,
  remoteTestSocketExists,
} from "../ssh/read-commands";
import { SshTransport } from "../ssh/service";
import { decodeRemoteHomeDirectoryOutput } from "./remote-home";

const presenceFromTest = (
  result:
    | { readonly _tag: "Success" }
    | { readonly _tag: "Failure"; readonly failure: unknown },
): HostOpsPresence => {
  if (result._tag === "Success") return "present";
  if (
    result._tag === "Failure" &&
    result.failure instanceof SshExitError &&
    result.failure.code === 1
  ) {
    return "absent";
  }
  return "unknown";
};

export const inspectDarwinHost = (
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
        platform: "darwin" as const,
        network: "down" as const,
        package: "unknown" as const,
        deployLock: "unknown" as const,
        incoming: "unknown" as const,
        termSocket: "unknown" as const,
        observedAt,
      };
    }

    const homeResult = yield* ssh.run(homeDirectoryLookup(target)).pipe(Effect.result);
    const home =
      homeResult._tag === "Success"
        ? decodeRemoteHomeDirectoryOutput(homeResult.success.stdout)
        : null;

    const pkgCmd = yield* remoteDarwinPackageExists();
    const lockCmd = yield* remoteDarwinDeployLockExists();
    const incomingCmd = yield* remoteDarwinIncomingExists();
    const pkg = yield* ssh
      .run(oneShot(target, pkgCmd, { budget: "short" }))
      .pipe(Effect.result);
    const lock = yield* ssh
      .run(oneShot(target, lockCmd, { budget: "short" }))
      .pipe(Effect.result);
    const incoming = yield* ssh
      .run(oneShot(target, incomingCmd, { budget: "short" }))
      .pipe(Effect.result);

    let termSocket: HostOpsPresence = "unknown";
    if (home !== null) {
      const sockCmd = yield* remoteTestSocketExists(
        join(home, TERM_REMOTE_SOCK_REL),
      );
      const sock = yield* ssh
        .run(oneShot(target, sockCmd, { budget: "short" }))
        .pipe(Effect.result);
      termSocket = presenceFromTest(sock);
    }

    return {
      endpoint,
      platform: "darwin" as const,
      network: "up" as const,
      ...(home === null ? {} : { home }),
      package: presenceFromTest(pkg),
      deployLock: presenceFromTest(lock),
      incoming: presenceFromTest(incoming),
      termSocket,
      observedAt,
    };
  });

