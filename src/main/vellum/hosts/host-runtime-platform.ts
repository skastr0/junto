/**
 * Platform adapter behind HostRuntime. Darwin and Linux implement this.
 * The coordinator never imports these modules.
 */
import type { Effect } from "effect";
import type {
  HostRuntimeGap,
  HostRuntimeObservation,
  HostRuntimePlatform,
} from "@shared/host-runtime";
import type { RemoteHost } from "@shared/remote-hosts";
import type { InstallationId } from "@shared/installation-id";
import type { SshTarget } from "../ssh/domain";
import type { SshTransportShape } from "../ssh/service";
import type { ConfigureRemoteOptions } from "./configure-remote";
import type { ConfiguredRemoteDeployResult } from "./deploy-configured-remote";
import type { LinuxReleaseCacheSource } from "./linux-release-feed";
import type { RemoteHostsError } from "@shared/remote-hosts";

export type HostRuntimePlanes = Pick<
  HostRuntimeObservation,
  "package" | "process" | "workAttach"
>;

export type HostRuntimeApplyContext = {
  readonly ssh: SshTransportShape;
  readonly host: RemoteHost;
  readonly gap: HostRuntimeGap;
  readonly priorInstallationId?: InstallationId;
  readonly configure: ConfigureRemoteOptions;
  readonly artifactSource?: LinuxReleaseCacheSource;
  readonly onAdmitted?: (
    host: RemoteHost,
  ) => Effect.Effect<void, RemoteHostsError>;
  readonly onCompleted?: (
    host: RemoteHost,
    result: ConfiguredRemoteDeployResult,
  ) => Effect.Effect<void, RemoteHostsError>;
};

export type HostRuntimePlatformAdapter = {
  readonly platform: Exclude<HostRuntimePlatform, "unknown">;
  readonly observePlanes: (
    ssh: SshTransportShape,
    target: SshTarget,
    home: string,
  ) => Effect.Effect<HostRuntimePlanes>;
  readonly apply: (
    context: HostRuntimeApplyContext,
  ) => Effect.Effect<ConfiguredRemoteDeployResult>;
};
