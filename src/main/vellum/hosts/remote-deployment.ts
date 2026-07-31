import type { Context } from "effect";
import type { Effect } from "effect";
import type {
  HostsDeployRemoteAuthorizationRequest,
  HostsDeployRemoteRecoveryAction,
} from "@shared/ipc";
import type { RemoteHost } from "@shared/remote-hosts";
import type { SshEndpoint, SshTarget } from "../ssh";
import type { SshTransport } from "../ssh";
import type { LinuxAdministratorCredential } from "./linux-administrator-credential";

export type RemoteDeploymentProgress = readonly string[];

export type RemoteDeploymentDisposition =
  | "not-started"
  /**
   * The exact package is present and its enrollment control plane can be
   * configured, but full work-control readiness requires that configuration.
   */
  | "configuration-required"
  | "ready"
  | "indeterminate";

export type RemoteTargetPlatform = "darwin" | "linux";

export type RemotePlatformDescriptor =
  | {
      readonly platform: "darwin";
      readonly kernelName: "Darwin";
    }
  | {
      readonly platform: "linux";
      readonly kernelName: "Linux";
    };

export type UnsupportedRemoteTarget = {
  readonly kind: "unsupported-target";
  readonly evidence: "unsupported" | "malformed";
  readonly reportedKernel?: string;
  readonly platform?: RemoteTargetPlatform;
};

export type RemoteDeploymentRecoveryAction =
  HostsDeployRemoteRecoveryAction;

/** Canonical result returned by admission, providers, dispatch, and IPC. */
export type DeployRemoteResult = {
  readonly ok: boolean;
  readonly detail: string;
  readonly code?:
    | "io"
    | "validation"
    | "not_found"
    | "conflict"
    | "auth_required";
  readonly message?: string;
  readonly stages: RemoteDeploymentProgress;
  /** Remote package transaction disposition for every deployment attempt. */
  readonly disposition: RemoteDeploymentDisposition;
  /** Exact admitted artifact version pushed by this operation. */
  readonly version?: string;
  /** Present only when platform admission refuses the target. */
  readonly unsupportedTarget?: UnsupportedRemoteTarget;
  /** Fixed, bounded operator recovery for a fail-closed deployment gate. */
  readonly recoveryAction?: RemoteDeploymentRecoveryAction;
  /** Public binding facts for a fresh, one-attempt OS authorization ceremony. */
  readonly authorizationRequest?: HostsDeployRemoteAuthorizationRequest;
};

export type RemoteDeploymentStationConfiguration =
  | { readonly state: "managed-externally" }
  | {
      readonly state: "applied";
      readonly remoteHostId: string;
    };

export type DeployableRemoteHost = RemoteHost & {
  readonly kind: "remote";
  readonly sshEndpoint: string;
};

export type RemoteDeploymentTarget = {
  readonly host: DeployableRemoteHost;
  readonly endpoint: SshEndpoint;
  readonly sshTarget: SshTarget;
  readonly platform: RemotePlatformDescriptor;
  /** Buffered so providers can preserve their established progress ordering. */
  readonly progress: RemoteDeploymentProgress;
};

export type RemoteDeploymentPreparation =
  | { readonly ok: true; readonly target: RemoteDeploymentTarget }
  | { readonly ok: false; readonly result: DeployRemoteResult };

/**
 * Main-process-only authority threaded to exactly one admitted provider.
 * The renderer can serialize an authorization request and password, never this
 * opaque capability.
 */
export type RemoteDeploymentAuthorization = {
  readonly kind: "linux-administrator-password";
  readonly credential: LinuxAdministratorCredential;
};

export type RemoteDeploymentProviderInput = {
  readonly ssh: Context.Tag.Service<typeof SshTransport>;
  readonly target: RemoteDeploymentTarget;
  readonly stationConfiguration: RemoteDeploymentStationConfiguration;
  readonly authorization?: RemoteDeploymentAuthorization;
};

export type RemoteDeploymentProvider = {
  readonly platform: RemoteTargetPlatform;
  /** Provider can produce the station-local Chromium composition/control plane. */
  readonly supportsBrowser: boolean;
  readonly deploy: (
    input: RemoteDeploymentProviderInput,
  ) => Effect.Effect<DeployRemoteResult, never>;
};
