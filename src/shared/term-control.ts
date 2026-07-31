// Local term control plane: NDJSON over Unix domain socket.
// Every Vellum Command station (CC or Remote) listens; CC reaches remote stations by
// SSH-forwarding this socket (same pattern as herdr mirror forward).

import { join } from "node:path";
import { resolveVellumHome } from "./vellum-home";
import {
  decodeLinuxReleaseFence,
  type LinuxReleaseFence,
} from "./linux-release-fence";
import type { TerminalLaunch, TerminalSessionSummary } from "./terminal";
import type { HostDirectorySnapshot } from "./host-directory";

export const TERM_CONTROL_PROTOCOL = 1 as const;
export const TERM_MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const TERM_MAINTENANCE_OBSERVATION_BYTES = 8;
export const TERM_MAINTENANCE_MAX_ACTIVE_SESSIONS = 1_000_000;

export const termControlDir = (home = resolveVellumHome()): string => join(home, ".vellum", "term");
export const termControlSocketPath = (home = resolveVellumHome()): string =>
  join(termControlDir(home), "control.sock");
export const termControlTokenPath = (home = resolveVellumHome()): string =>
  join(termControlDir(home), "token");
/** Relative to remote $HOME — used for SSH unix forward. */
export const TERM_REMOTE_SOCK_REL = ".vellum/term/control.sock";

export type TermControlRequest =
  | { readonly v: 1; readonly id: string; readonly op: "ping" }
  | {
      readonly v: 1;
      readonly id: string;
      readonly op: "create";
      readonly bindingId: string;
      readonly launch?: TerminalLaunch;
      readonly cols?: number;
      readonly rows?: number;
      readonly canvasName?: string;
      readonly nodeId?: string;
      readonly label?: string;
    }
  | { readonly v: 1; readonly id: string; readonly op: "list" }
  | {
      readonly v: 1;
      readonly id: string;
      readonly op: "directory.read";
      readonly path?: string;
    }
  | { readonly v: 1; readonly id: string; readonly op: "get"; readonly bindingId: string }
  | { readonly v: 1; readonly id: string; readonly op: "kill"; readonly bindingId: string }
  | {
      readonly v: 1;
      readonly id: string;
      readonly op: "bindCanvas";
      readonly bindingId: string;
      readonly ref: { canvasName?: string; nodeId?: string } | null;
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly op: "attach";
      readonly bindingId: string;
      readonly mode: "control" | "observe";
      readonly takeover?: boolean;
    }
  | { readonly v: 1; readonly id: string; readonly op: "release"; readonly leaseId: string }
  | {
      readonly v: 1;
      readonly id: string;
      readonly op: "write";
      readonly leaseId: string;
      readonly data: string;
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly op: "resize";
      readonly leaseId: string;
      readonly cols: number;
      readonly rows: number;
    }
  | { readonly v: 1; readonly id: string; readonly op: "maintenance.acquire" }
  | { readonly v: 1; readonly id: string; readonly op: "maintenance.fence" }
  | { readonly v: 1; readonly id: string; readonly op: "maintenance.release" }
  | { readonly v: 1; readonly id: string; readonly op: "shutdown" };

export type TermMaintenanceRequest = Extract<
  TermControlRequest,
  { readonly op: "maintenance.acquire" | "maintenance.fence" | "maintenance.release" }
>;

export type TermControlResponse =
  | {
      readonly v: 1;
      readonly id: string;
      readonly ok: true;
      readonly data?: unknown;
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly ok: false;
      readonly error: string;
    };

/** Server → client push (after attach). */
export type TermControlEventFrame = {
  readonly v: 1;
  readonly type: "event";
  readonly payload: unknown;
};

export type TermAttachPayload = {
  readonly leaseId: string;
  readonly bindingId: string;
  readonly epoch: string;
  readonly mode: "control" | "observe";
  readonly cols: number;
  readonly rows: number;
  readonly status: string;
  readonly pid?: number;
  readonly journal: readonly unknown[];
};

export type TermListPayload = {
  readonly sessions: readonly TerminalSessionSummary[];
};

export type TermDirectoryPayload = HostDirectorySnapshot;

export type TermMaintenanceEvidence = {
  readonly activeTerminalSessions: number;
  readonly observationId: string;
};

export type TermMaintenanceQuiescenceEvidence = {
  readonly activeTerminalSessions: 0;
  readonly observationId: string;
};

export type TermMaintenanceDenialReason =
  | "active_sessions"
  | "maintenance_held"
  | "shutting_down";

export type TermMaintenanceAcquirePayload =
  | {
      readonly acquired: true;
      readonly evidence: TermMaintenanceQuiescenceEvidence;
    }
  | {
      readonly acquired: false;
      readonly evidence: TermMaintenanceEvidence;
      readonly reason: TermMaintenanceDenialReason;
    };

export type TermMaintenanceReleasePayload = {
  readonly released: boolean;
};

export type TermMaintenanceFencePayload = {
  readonly acknowledged: true;
  readonly evidence: TermMaintenanceQuiescenceEvidence;
  readonly fence: LinuxReleaseFence;
};

const TERM_MAINTENANCE_OBSERVATION_PATTERN = /^tm_[0-9a-f]{16}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};

export const isTermMaintenanceObservationId = (value: unknown): value is string =>
  typeof value === "string" && TERM_MAINTENANCE_OBSERVATION_PATTERN.test(value);

export const decodeTermMaintenanceRequest = (
  value: unknown,
): TermMaintenanceRequest | undefined => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["v", "id", "op"]) ||
    value.v !== TERM_CONTROL_PROTOCOL ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 128 ||
    (value.op !== "maintenance.acquire" &&
      value.op !== "maintenance.fence" &&
      value.op !== "maintenance.release")
  ) {
    return undefined;
  }
  return value as TermMaintenanceRequest;
};

const decodeTermMaintenanceEvidence = (
  value: unknown,
): TermMaintenanceEvidence | undefined => {
  if (!isRecord(value) || !hasExactKeys(value, ["activeTerminalSessions", "observationId"])) {
    return undefined;
  }
  if (
    typeof value.activeTerminalSessions !== "number" ||
    !Number.isSafeInteger(value.activeTerminalSessions) ||
    value.activeTerminalSessions < 0 ||
    value.activeTerminalSessions > TERM_MAINTENANCE_MAX_ACTIVE_SESSIONS ||
    !isTermMaintenanceObservationId(value.observationId)
  ) {
    return undefined;
  }
  return {
    activeTerminalSessions: value.activeTerminalSessions,
    observationId: value.observationId,
  };
};

export const decodeTermMaintenanceAcquirePayload = (
  value: unknown,
): TermMaintenanceAcquirePayload | undefined => {
  if (!isRecord(value) || typeof value.acquired !== "boolean") return undefined;
  if (value.acquired) {
    if (!hasExactKeys(value, ["acquired", "evidence"])) return undefined;
    const evidence = decodeTermMaintenanceEvidence(value.evidence);
    if (evidence?.activeTerminalSessions !== 0) return undefined;
    return {
      acquired: true,
      evidence: {
        activeTerminalSessions: 0,
        observationId: evidence.observationId,
      },
    };
  }
  if (!hasExactKeys(value, ["acquired", "evidence", "reason"])) return undefined;
  const evidence = decodeTermMaintenanceEvidence(value.evidence);
  if (
    evidence === undefined ||
    (value.reason !== "active_sessions" &&
      value.reason !== "maintenance_held" &&
      value.reason !== "shutting_down") ||
    (value.reason === "active_sessions" && evidence.activeTerminalSessions === 0)
  ) {
    return undefined;
  }
  return {
    acquired: false,
    evidence,
    reason: value.reason,
  };
};

export const decodeTermMaintenanceReleasePayload = (
  value: unknown,
): TermMaintenanceReleasePayload | undefined => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["released"]) ||
    typeof value.released !== "boolean"
  ) {
    return undefined;
  }
  return { released: value.released };
};

export const decodeTermMaintenanceFencePayload = (
  value: unknown,
): TermMaintenanceFencePayload | undefined => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["acknowledged", "evidence", "fence"]) ||
    value.acknowledged !== true
  ) {
    return undefined;
  }
  const evidence = decodeTermMaintenanceEvidence(value.evidence);
  const fence = decodeLinuxReleaseFence(value.fence);
  if (evidence?.activeTerminalSessions !== 0 || fence === undefined) {
    return undefined;
  }
  return {
    acknowledged: true,
    evidence: {
      activeTerminalSessions: 0,
      observationId: evidence.observationId,
    },
    fence,
  };
};
