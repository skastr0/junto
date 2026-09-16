import type { HostsDeployRemoteRecoveryAction } from "@shared/ipc";
import type { RemoteHost } from "@shared/remote-hosts";
import type { SshEndpoint, SshTarget } from "../ssh";

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

