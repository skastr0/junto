/** Darwin HostRuntime platform. Package is the signed .app. Attach is term. */
import { Effect } from "effect";
import { join } from "node:path";
import { stationControlDir, stationDoorSocketPath } from "@shared/station-ssh-control";
import { TERM_REMOTE_SOCK_REL } from "@shared/term-control";
import { SshExitError, type SshTarget } from "../ssh/domain";
import { oneShot } from "../ssh/program";
import {
  remoteDarwinPackageExists,
  remoteTestSocketExists,
} from "../ssh/read-commands";
import type { SshTransportShape } from "../ssh/service";
import { applyConfiguredRemoteGap } from "./host-runtime-apply";
import type {
  HostRuntimePlatformAdapter,
  HostRuntimePlanes,
} from "./host-runtime-platform";

const probeSocket = (
  ssh: SshTransportShape,
  target: SshTarget,
  path: string,
): Effect.Effect<boolean> =>
  remoteTestSocketExists(path).pipe(
    Effect.flatMap((command) =>
      ssh.run(oneShot(target, command, { budget: "short" })),
    ),
    Effect.map(() => true),
    Effect.catch(() => Effect.succeed(false)),
  );

const observePlanes = (
  ssh: SshTransportShape,
  target: SshTarget,
  home: string,
): Effect.Effect<HostRuntimePlanes> =>
  Effect.gen(function* () {
    const installedCmd = yield* remoteDarwinPackageExists().pipe(Effect.result);
    let pkg: HostRuntimePlanes["package"] = "unknown";
    if (installedCmd._tag === "Success") {
      const installed = yield* ssh
        .run(oneShot(target, installedCmd.success, { budget: "short" }))
        .pipe(Effect.result);
      if (installed._tag === "Success") pkg = "present";
      else if (
        installed.failure instanceof SshExitError &&
        installed.failure.code === 1
      ) {
        pkg = "absent";
      }
    }
    const stationHome = stationControlDir(home);
    const enrollUp = yield* probeSocket(
      ssh,
      target,
      stationDoorSocketPath(stationHome, "enroll"),
    );
    const peerUp = yield* probeSocket(
      ssh,
      target,
      stationDoorSocketPath(stationHome, "peer"),
    );
    const termUp = yield* probeSocket(
      ssh,
      target,
      join(home, TERM_REMOTE_SOCK_REL),
    );
    return {
      package: pkg,
      process: enrollUp || peerUp ? ("up" as const) : ("down" as const),
      workAttach: termUp ? ("up" as const) : ("down" as const),
    };
  });

export const darwinHostRuntimePlatform: HostRuntimePlatformAdapter = {
  platform: "darwin",
  observePlanes,
  apply: applyConfiguredRemoteGap,
};
