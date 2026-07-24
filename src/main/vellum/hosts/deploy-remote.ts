/** Remote deployment target admission and platform-provider dispatch. */

import type { Context } from "effect";
import { Effect } from "effect";
import { hostHasCapability, type RemoteHost } from "@shared/remote-hosts";
import { SshTransport } from "../ssh";
import type {
  DeployRemoteResult,
  RemoteDeploymentAuthorization,
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
    authorization?: RemoteDeploymentAuthorization,
  ) => Effect.Effect<DeployRemoteResult, never>;
  readonly deploy: (
    ssh: Ssh,
    host: RemoteHost,
    stationConfiguration: RemoteDeploymentStationConfiguration,
    authorization?: RemoteDeploymentAuthorization,
  ) => Effect.Effect<DeployRemoteResult, never>;
};

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
      catch: () => undefined,
    }).pipe(
      Effect.match({
        onFailure: () =>
          ({ ok: false, reason: "unavailable" }) satisfies ProviderResolution,
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
        return resolveProvider(target.platform.platform).pipe(
          Effect.map((resolution) => {
            if (!resolution.ok) {
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
                        `${target.host.label}: ${target.platform.platform} deployment provider is unavailable`,
                        {
                          code: "validation",
                          message: "remote deployment provider unavailable",
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
    authorization,
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
      return provider
        .deploy({
          ssh,
          target,
          stationConfiguration,
          ...(provider.platform !== "linux" || authorization === undefined
            ? {}
            : { authorization }),
        })
        .pipe(Effect.map((receipt) => receipt.result));
    });

  const deploy: RemoteDeploymentDispatcher["deploy"] = (
    ssh,
    host,
    stationConfiguration,
    authorization,
  ) =>
    prepare(ssh, host).pipe(
      Effect.flatMap((preparation) =>
        preparation.ok
          ? dispatch(
              preparation.target,
              ssh,
              stationConfiguration,
              authorization,
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
  authorization?: RemoteDeploymentAuthorization,
): Effect.Effect<DeployRemoteResult, never> =>
  remoteDeploymentDispatcher.deploy(
    ssh,
    host,
    { state: "managed-externally" },
    authorization,
  );

export type {
  DeployRemoteResult,
  RemoteDeploymentAuthorization,
  RemoteDeploymentPreparation,
  RemoteDeploymentStationConfiguration,
  RemoteDeploymentTarget,
} from "./remote-deployment";
export { decodeRemotePlatformEvidence } from "./remote-platform";
