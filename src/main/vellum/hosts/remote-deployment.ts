import type { Context } from "effect";
import type { Effect } from "effect";
import type {
  HostsDeployRemoteAuthorizationRequest,
  HostsDeployRemoteRecoveryAction,
} from "@shared/ipc";
import type { RemoteHost } from "@shared/remote-hosts";
import type { SshEndpoint } from "../ssh";
import type { SshTransport } from "../ssh";
import type { LinuxAdministratorCredential } from "./linux-administrator-credential";

export type RemoteDeploymentProgress = readonly string[];

export type RemoteDeploymentDisposition =
  "not-started" | "ready" | "rolled-back" | "indeterminate";

export type RemoteDeploymentReadiness =
  "not-started" | "ready" | "not-ready" | "indeterminate";

export type RemoteDeploymentRollback =
  "not-required" | "restored" | "failed" | "indeterminate";

export type RemoteDeploymentAuthorizationRequirement = "none" | "operator";

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

/** Stable Settings/IPC result. Provider-only metadata is kept off this object. */
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
  /** Remote package transaction disposition; absent only on legacy test doubles. */
  readonly disposition?: RemoteDeploymentDisposition;
  /** Exact admitted artifact version pushed by this operation. */
  readonly version?: string;
  /** Present only when platform admission refuses the target. */
  readonly unsupportedTarget?: UnsupportedRemoteTarget;
  /** Fixed, bounded operator recovery for a fail-closed deployment gate. */
  readonly recoveryAction?: RemoteDeploymentRecoveryAction;
  /** Public binding facts for a fresh, one-attempt OS authorization ceremony. */
  readonly authorizationRequest?: HostsDeployRemoteAuthorizationRequest;
};

export type RemoteDeploymentArtifact = {
  /** Product identity, never an executable or installation path. */
  readonly identity: string;
  readonly version: string;
  readonly source: "command-center";
};

export type RemoteDeploymentStationConfiguration =
  | { readonly state: "managed-externally" }
  | {
      readonly state: "applied";
      readonly remoteHostId: string;
      readonly commandCenterRef: string;
    };

export type DeployableRemoteHost = RemoteHost & {
  readonly kind: "remote";
  readonly endpoint: string;
};

export type RemoteDeploymentTarget = {
  readonly host: DeployableRemoteHost;
  readonly endpoint: SshEndpoint;
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

/**
 * Provider receipt used by the dispatcher and future platform implementations.
 * `result` is the compatibility projection; the remaining fields are typed
 * product facts and deliberately never leak OS-specific paths or service names.
 */
export type RemoteDeploymentProviderReceipt = {
  readonly result: DeployRemoteResult;
  readonly targetPlatform: RemoteTargetPlatform;
  readonly artifact?: RemoteDeploymentArtifact;
  readonly stationConfiguration: RemoteDeploymentStationConfiguration;
  readonly authorizationRequirement: RemoteDeploymentAuthorizationRequirement;
  readonly readiness: RemoteDeploymentReadiness;
  readonly rollback: RemoteDeploymentRollback;
};

export type RemoteDeploymentProvider = {
  readonly platform: RemoteTargetPlatform;
  /** Provider can produce the station-local Chromium composition/control plane. */
  readonly supportsBrowser: boolean;
  readonly deploy: (
    input: RemoteDeploymentProviderInput,
  ) => Effect.Effect<RemoteDeploymentProviderReceipt, never>;
};

export const readinessFromDisposition = (
  disposition: RemoteDeploymentDisposition | undefined,
): RemoteDeploymentReadiness => {
  switch (disposition) {
    case "ready":
      return "ready";
    case "rolled-back":
      return "not-ready";
    case "indeterminate":
      return "indeterminate";
    case "not-started":
    case undefined:
      return "not-started";
  }
};

export const rollbackFromDisposition = (
  disposition: RemoteDeploymentDisposition | undefined,
): RemoteDeploymentRollback => {
  switch (disposition) {
    case "rolled-back":
      return "restored";
    case "indeterminate":
      return "indeterminate";
    case "ready":
    case "not-started":
    case undefined:
      return "not-required";
  }
};
