/** Remote deployment target admission and platform-provider dispatch. */

import type { Context } from "effect";
import { Effect } from "effect";
import type { RemoteHost } from "@shared/remote-hosts";
import { SshTransport } from "../ssh";
import { darwinRemoteDeploymentProvider } from "./deploy-darwin";
import type {
  DeployRemoteResult,
  RemoteDeploymentPreparation,
  RemoteDeploymentProvider,
  RemoteDeploymentStationConfiguration,
  RemoteDeploymentTarget,
  RemoteTargetPlatform,
} from "./remote-deployment";
import {
  remoteDeploymentFailure,
  resolveRemoteDeploymentTarget,
  unsupportedRemoteTargetResult,
} from "./remote-platform";

type Ssh = Context.Tag.Service<typeof SshTransport>;

export type RemoteDeploymentDispatcher = {
  readonly prepare: (
    ssh: Ssh,
    host: RemoteHost,
  ) => Effect.Effect<RemoteDeploymentPreparation, never>;
  readonly dispatch: (
    target: RemoteDeploymentTarget,
    ssh: Ssh,
    stationConfiguration: RemoteDeploymentStationConfiguration,
  ) => Effect.Effect<DeployRemoteResult, never>;
  readonly deploy: (
    ssh: Ssh,
    host: RemoteHost,
    stationConfiguration: RemoteDeploymentStationConfiguration,
  ) => Effect.Effect<DeployRemoteResult, never>;
};

export const makeRemoteDeploymentDispatcher = (input: {
  readonly commandCenterPlatform: NodeJS.Platform;
  readonly providers: ReadonlyArray<RemoteDeploymentProvider>;
}): RemoteDeploymentDispatcher => {
  const providers = new Map<RemoteTargetPlatform, RemoteDeploymentProvider>();
  for (const provider of input.providers) {
    if (providers.has(provider.platform)) {
      throw new Error(
        `duplicate Remote deployment provider: ${provider.platform}`,
      );
    }
    providers.set(provider.platform, provider);
  }
  const admittedTargets = new WeakSet<RemoteDeploymentTarget>();

  const prepare: RemoteDeploymentDispatcher["prepare"] = (ssh, host) =>
    resolveRemoteDeploymentTarget(ssh, host, input.commandCenterPlatform).pipe(
      Effect.map((preparation) => {
        if (!preparation.ok) return preparation;
        const { target } = preparation;
        if (!providers.has(target.platform.platform)) {
          return {
            ok: false as const,
            result: unsupportedRemoteTargetResult(
              target.host,
              {
                kind: "unsupported-target",
                evidence: "unsupported",
                reportedKernel: target.platform.kernelName,
                platform: target.platform.platform,
              },
              target.progress,
            ),
          };
        }
        admittedTargets.add(target);
        return preparation;
      }),
    );

  const dispatch: RemoteDeploymentDispatcher["dispatch"] = (
    target,
    ssh,
    stationConfiguration,
  ) =>
    Effect.suspend(() => {
      if (!admittedTargets.has(target)) {
        return Effect.succeed(
          remoteDeploymentFailure(
            `${target.host.label}: Remote deployment target was not admitted by this dispatcher`,
            { code: "validation" },
          ),
        );
      }
      // An admission witnesses one execution attempt; it is not a replayable grant.
      admittedTargets.delete(target);
      const provider = providers.get(target.platform.platform);
      if (!provider || provider.platform !== target.platform.platform) {
        return Effect.succeed(
          unsupportedRemoteTargetResult(
            target.host,
            {
              kind: "unsupported-target",
              evidence: "unsupported",
              reportedKernel: target.platform.kernelName,
              platform: target.platform.platform,
            },
            target.progress,
          ),
        );
      }
      return provider
        .deploy({ ssh, target, stationConfiguration })
        .pipe(Effect.map((receipt) => receipt.result));
    });

  const deploy: RemoteDeploymentDispatcher["deploy"] = (
    ssh,
    host,
    stationConfiguration,
  ) =>
    prepare(ssh, host).pipe(
      Effect.flatMap((preparation) =>
        preparation.ok
          ? dispatch(preparation.target, ssh, stationConfiguration)
          : Effect.succeed(preparation.result),
      ),
    );

  return Object.freeze({ prepare, dispatch, deploy });
};

const remoteDeploymentDispatcher = makeRemoteDeploymentDispatcher({
  commandCenterPlatform: process.platform,
  providers: [darwinRemoteDeploymentProvider],
});

export const prepareRemoteDeployment = remoteDeploymentDispatcher.prepare;
export const dispatchRemoteDeployment = remoteDeploymentDispatcher.dispatch;

export const deployRemoteHost = (
  ssh: Ssh,
  host: RemoteHost,
): Effect.Effect<DeployRemoteResult, never> =>
  remoteDeploymentDispatcher.deploy(ssh, host, {
    state: "managed-externally",
  });

export type {
  DeployRemoteResult,
  RemoteDeploymentPreparation,
  RemoteDeploymentStationConfiguration,
  RemoteDeploymentTarget,
} from "./remote-deployment";
export { decodeRemotePlatformEvidence } from "./remote-platform";
