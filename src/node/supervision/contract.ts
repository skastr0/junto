export const SUPERVISOR_DIAGNOSTIC_MAX_CHARACTERS = 512;

export type StationSupervisorProvider =
  | "launchd"
  | "systemd-user"
  | "standalone";

export type StationSupervisorFailureKind =
  | "unsupported"
  | "target-unavailable"
  | "admission-refused"
  | "spawn-failed"
  | "process-error"
  | "output-overflow"
  | "deadline"
  | "command-failed"
  | "close-unconfirmed"
  | "invalid-output"
  | "service-degraded";

export interface StationSupervisorFailure {
  readonly kind: StationSupervisorFailureKind;
  /** Bounded, sanitized text for logs and recovery UI. Never lifecycle evidence. */
  readonly diagnostic: string;
}

export interface StationSupervisorMetadata {
  readonly provider: StationSupervisorProvider;
  readonly displayName: string;
  /** Fixed product identity for display only; never accepted back as authority. */
  readonly serviceLabel?: string;
  readonly recovery: {
    readonly title: string;
    readonly detail: string;
  };
}

export type StationSupervisorObservation =
  | {
    readonly provider: "launchd" | "systemd-user";
    readonly state: "active";
    readonly ownership: "current" | "other";
  }
  | {
    readonly provider: "launchd" | "systemd-user";
    readonly state: "inactive" | "absent";
    readonly ownership: "none";
  }
  | {
    readonly provider: "launchd" | "systemd-user";
    readonly state: "degraded";
    readonly ownership: "none" | "unknown";
    readonly failure: StationSupervisorFailure;
  }
  | {
    readonly provider: "launchd" | "systemd-user";
    readonly state: "unknown";
    readonly ownership: "unknown";
    readonly failure: StationSupervisorFailure;
  }
  | {
    readonly provider: "standalone";
    readonly state: "unsupported";
    readonly ownership: "none";
    readonly failure: StationSupervisorFailure;
  };

export type StationSupervisorHandoff =
  | {
    readonly provider: StationSupervisorProvider;
    /** The provider accepted the request; eventual activation is not implied. */
    readonly accepted: true;
  }
  | {
    readonly provider: StationSupervisorProvider;
    readonly accepted: false;
    readonly failure: StationSupervisorFailure;
  };

export interface StationSupervisor {
  readonly metadata: StationSupervisorMetadata;
  readonly observe: () => Promise<StationSupervisorObservation>;
  readonly requestHandoff: () => Promise<StationSupervisorHandoff>;
}

const sanitizeDiagnostic = (value: string): string =>
  value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�")
    .slice(0, SUPERVISOR_DIAGNOSTIC_MAX_CHARACTERS);

export const stationSupervisorFailure = (
  kind: StationSupervisorFailureKind,
  diagnostic: string,
): StationSupervisorFailure => Object.freeze({
  kind,
  diagnostic: sanitizeDiagnostic(diagnostic),
});
