/** Remote deployment target admission and platform-provider dispatch. */

import { Effect } from "effect";
import {
  DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL,
  LINUX_REMOTE_DEPLOY_DISABLED_DETAIL,
  RELEASE_CAPABILITIES,
} from "@shared/release-capabilities";
import { hostHasCapability, type RemoteHost } from "@shared/remote-hosts";
import type { SshTransportShape } from "../ssh";
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
import type { LinuxReleaseCacheSource } from "./linux-release-feed";

type Ssh = SshTransportShape;

export interface RemoteDeploymentProviderLoaders {
  readonly darwin: () => Promise<RemoteDeploymentProvider>;
  readonly linux: () => Promise<RemoteDeploymentProvider>;
}

export type RemoteDeploymentProviderSelector = (
  platform: NodeJS.Platform,
) => Promise<RemoteDeploymentProvider | undefined>;

const productionProviderLoaders: RemoteDeploymentProviderLoaders =
  Object.freeze({
    darwin: async () => {
      const { RELEASE_CAPABILITIES, DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL } =
        await import("@shared/release-capabilities");
      if (!RELEASE_CAPABILITIES.darwinRemoteDeploy) {
        throw new Error(DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL);
      }
      const { darwinRemoteDeploymentProvider } = await import(
        "./deploy-darwin"
      );
      return darwinRemoteDeploymentProvider;
    },
    linux: async () => {
      const { RELEASE_CAPABILITIES, LINUX_REMOTE_DEPLOY_DISABLED_DETAIL } =
        await import("@shared/release-capabilities");
      if (!RELEASE_CAPABILITIES.linuxRemoteDeploy) {
        throw new Error(LINUX_REMOTE_DEPLOY_DISABLED_DETAIL);
      }
      const { linuxRemoteDeploymentProvider } = await import("./deploy-linux");
      return linuxRemoteDeploymentProvider;
    },
  });

/** Select exactly one platform provider without evaluating the other branch. */
export const createRemoteDeploymentProviderSelector = (
  loaders: RemoteDeploymentProviderLoaders,
): RemoteDeploymentProviderSelector =>
  async (platform) => {
    const loader =
      platform === "darwin"
        ? loaders.darwin
        : platform === "linux"
          ? loaders.linux
          : undefined;
    if (!loader) return undefined;
    const provider = await loader();
    if (provider.platform !== platform) {
      throw new Error(
        `Remote deployment provider mismatch: expected ${platform}, received ${provider.platform}`,
      );
    }
    return provider;
  };

const selectProductionProvider = createRemoteDeploymentProviderSelector(
  productionProviderLoaders,
);

export const loadRemoteDeploymentProvider = (
  platform: NodeJS.Platform,
): Promise<RemoteDeploymentProvider | undefined> =>
  selectProductionProvider(platform);

export type RemoteDeploymentDispatcher = {
  readonly prepare: (
    ssh: Ssh,
    host: RemoteHost,
  ) => Effect.Effect<RemoteDeploymentPreparation, never>;
  readonly dispatch: (
    target: RemoteDeploymentTarget,
    ssh: Ssh,
    stationConfiguration: RemoteDeploymentStationConfiguration,
    artifactSource?: LinuxReleaseCacheSource,
  ) => Effect.Effect<DeployRemoteResult, never>;
  readonly deploy: (
    ssh: Ssh,
    host: RemoteHost,
    stationConfiguration: RemoteDeploymentStationConfiguration,
    artifactSource?: LinuxReleaseCacheSource,
  ) => Effect.Effect<DeployRemoteResult, never>;
};

const decodeLinuxArtifactSource = (
  value: unknown,
): LinuxReleaseCacheSource | undefined =>
  value === "stable-feed" ||
    value === "verified-cache" ||
    value === "qualification-candidate"
    ? value
    : undefined;

export const makeRemoteDeploymentDispatcher = (input: {
  readonly commandCenterPlatform: NodeJS.Platform;
  readonly providers?: ReadonlyArray<RemoteDeploymentProvider>;
  readonly loadProvider?: RemoteDeploymentProviderSelector;
}): RemoteDeploymentDispatcher => {
  const providers = new Map<RemoteTargetPlatform, RemoteDeploymentProvider>();
  for (const provider of input.providers ?? []) {
    if (providers.has(provider.platform)) {
      throw new Error(
        `duplicate Remote deployment provider: ${provider.platform}`,
      );
    }
    providers.set(provider.platform, provider);
  }
  const admittedProviders = new WeakMap<
    RemoteDeploymentTarget,
    RemoteDeploymentProvider
  >();

  type ProviderResolution =
    | {
        readonly ok: true;
        readonly provider: RemoteDeploymentProvider;
      }
    | {
        readonly ok: false;
        readonly reason: "missing" | "unavailable";
        /** Loader/release denial text when the provider path refuses. */
        readonly detail?: string;
      };

  const resolveProvider = (
    platform: RemoteTargetPlatform,
  ): Effect.Effect<ProviderResolution, never> => {
    const registered = providers.get(platform);
    if (registered) {
      return Effect.succeed({ ok: true, provider: registered });
    }
    if (!input.loadProvider) {
      return Effect.succeed({ ok: false, reason: "missing" });
    }
    return Effect.tryPromise({
      try: () => input.loadProvider!(platform),
      catch: (cause) =>
        cause instanceof Error ? cause.message : String(cause),
    }).pipe(
      Effect.match({
        onFailure: (detail) =>
          ({
            ok: false,
            reason: "unavailable",
            detail,
          }) satisfies ProviderResolution,
        onSuccess: (provider) =>
          provider?.platform === platform
            ? ({ ok: true, provider }) satisfies ProviderResolution
            : ({
                ok: false,
                reason: provider ? "unavailable" : "missing",
              }) satisfies ProviderResolution,
      }),
    );
  };

  const prepare: RemoteDeploymentDispatcher["prepare"] = (ssh, host) =>
    resolveRemoteDeploymentTarget(ssh, host, input.commandCenterPlatform).pipe(
      Effect.flatMap((preparation) => {
        if (!preparation.ok) return Effect.succeed(preparation);
        const { target } = preparation;
        // Release surface gate with stable product copy before provider body.
        // Loader also freezes, but prepare must not degrade the denial text.
        if (
          target.platform.platform === "linux" &&
          !RELEASE_CAPABILITIES.linuxRemoteDeploy
        ) {
          return Effect.succeed({
            ok: false as const,
            result: remoteDeploymentFailure(
              `${target.host.label}: ${LINUX_REMOTE_DEPLOY_DISABLED_DETAIL}`,
              {
                code: "validation",
                message: LINUX_REMOTE_DEPLOY_DISABLED_DETAIL,
                stages: target.progress,
              },
            ),
          });
        }
        if (
          target.platform.platform === "darwin" &&
          !RELEASE_CAPABILITIES.darwinRemoteDeploy
        ) {
          return Effect.succeed({
            ok: false as const,
            result: remoteDeploymentFailure(
              `${target.host.label}: ${DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL}`,
              {
                code: "validation",
                message: DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL,
                stages: target.progress,
              },
            ),
          });
        }
        return resolveProvider(target.platform.platform).pipe(
          Effect.map((resolution) => {
            if (!resolution.ok) {
              const unavailableDetail =
                resolution.detail !== undefined &&
                resolution.detail.trim().length > 0
                  ? resolution.detail
                  : `${target.platform.platform} deployment provider is unavailable`;
              return {
                ok: false as const,
                result:
                  resolution.reason === "missing"
                    ? unsupportedRemoteTargetResult(
                        target.host,
                        {
                          kind: "unsupported-target",
                          evidence: "unsupported",
                          reportedKernel: target.platform.kernelName,
                          platform: target.platform.platform,
                        },
                        target.progress,
                      )
                    : remoteDeploymentFailure(
                        `${target.host.label}: ${unavailableDetail}`,
                        {
                          code: "validation",
                          message: unavailableDetail,
                          stages: target.progress,
                        },
                      ),
              };
            }
            const { provider } = resolution;
            if (
              hostHasCapability(target.host, "browser") &&
              !provider.supportsBrowser
            ) {
              return {
                ok: false as const,
                result: remoteDeploymentFailure(
                  `${target.host.label}: deployment provider cannot satisfy the declared browser capability`,
                  {
                    code: "validation",
                    message:
                      "remote browser capability unsupported by deployment provider",
                    stages: target.progress,
                  },
                ),
              };
            }
            admittedProviders.set(target, provider);
            return preparation;
          }),
        );
      }),
    );

  const dispatch: RemoteDeploymentDispatcher["dispatch"] = (
    target,
    ssh,
    stationConfiguration,
    artifactSource,
  ) =>
    Effect.suspend(() => {
      const provider = admittedProviders.get(target);
      if (!provider) {
        return Effect.succeed(
          remoteDeploymentFailure(
            `${target.host.label}: Remote deployment target was not admitted by this dispatcher`,
            { code: "validation" },
          ),
        );
      }
      // An admission witnesses one execution attempt; it is not a replayable grant.
      admittedProviders.delete(target);
      const selectedArtifactSource = decodeLinuxArtifactSource(
        artifactSource ?? "stable-feed",
      );
      if (selectedArtifactSource === undefined) {
        return Effect.succeed(
          remoteDeploymentFailure(
            `${target.host.label}: Linux release source is invalid`,
            {
              code: "validation",
              message: "invalid Linux release source",
              stages: target.progress,
            },
          ),
        );
      }
      if (provider.platform !== "linux" && artifactSource !== undefined) {
        return Effect.succeed(
          remoteDeploymentFailure(
            `${target.host.label}: Linux release source cannot select a ${provider.platform} deployment`,
            {
              code: "validation",
              message: "Linux release source requires a Linux target",
              stages: target.progress,
            },
          ),
        );
      }
      if (provider.platform !== target.platform.platform) {
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
      return provider.deploy({
        ssh,
        target,
        stationConfiguration,
        artifactSource: selectedArtifactSource,
      });
    });

  const deploy: RemoteDeploymentDispatcher["deploy"] = (
    ssh,
    host,
    stationConfiguration,
    artifactSource,
  ) =>
    prepare(ssh, host).pipe(
      Effect.flatMap((preparation) =>
        preparation.ok
          ? dispatch(
              preparation.target,
              ssh,
              stationConfiguration,
              artifactSource,
            )
          : Effect.succeed(preparation.result),
      ),
    );

  return Object.freeze({ prepare, dispatch, deploy });
};

const remoteDeploymentDispatcher = makeRemoteDeploymentDispatcher({
  commandCenterPlatform: process.platform,
  loadProvider: loadRemoteDeploymentProvider,
});

export const prepareRemoteDeployment = remoteDeploymentDispatcher.prepare;
export const dispatchRemoteDeployment = remoteDeploymentDispatcher.dispatch;

export const deployRemoteHost = (
  ssh: Ssh,
  host: RemoteHost,
): Effect.Effect<DeployRemoteResult, never> =>
  remoteDeploymentDispatcher.deploy(
    ssh,
    host,
    { state: "managed-externally" },
  );

export type {
  DeployRemoteResult,
  RemoteDeploymentPreparation,
  RemoteDeploymentStationConfiguration,
  RemoteDeploymentTarget,
} from "./remote-deployment";
export { decodeRemotePlatformEvidence } from "./remote-platform";
