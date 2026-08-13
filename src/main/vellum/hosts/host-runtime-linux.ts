/** Linux HostRuntime platform. Attach is work control, never a Darwin .app. */
import { Effect } from "effect";
import { stationControlDir, stationDoorSocketPath } from "@shared/station-ssh-control";
import { workControlDir, workControlSocketPath } from "@shared/work-control";
import type { SshTarget } from "../ssh/domain";
import { oneShot } from "../ssh/program";
import { remoteTestSocketExists } from "../ssh/read-commands";
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
    const workUp = yield* probeSocket(
      ssh,
      target,
      workControlSocketPath(workControlDir(home)),
    );
    return {
      package: "unknown" as const,
      process: enrollUp || peerUp ? ("up" as const) : ("down" as const),
      workAttach: workUp ? ("up" as const) : ("down" as const),
    };
  });

export const linuxHostRuntimePlatform: HostRuntimePlatformAdapter = {
  platform: "linux",
  observePlanes,
  apply: applyConfiguredRemoteGap,
};
