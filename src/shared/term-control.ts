// Local term control plane: NDJSON over Unix domain socket.
// Every Vellum Command station (CC or Remote) listens; CC reaches remote stations by
// SSH-forwarding this socket.

import { join } from "node:path";
import { remoteStationContractVersion } from "./remote-station-release";
import { resolveVellumCommandHome } from "./vellum-home";
import {
  decodeLinuxReleaseFence,
  type LinuxReleaseFence,
} from "./linux-release-fence";
import type { ManagedSpawnIntent } from "./managed-terminal-launch";
import type { TerminalLaunch, TerminalSessionSummary } from "./terminal";
import type { HostDirectorySnapshot } from "./host-directory";

/** Independent unreleased terminal-control contract. */
export const TERM_CONTROL_PROTOCOL = remoteStationContractVersion(
  "Remote terminal control",
  1,
);
export const TERM_MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const TERM_MAINTENANCE_OBSERVATION_BYTES = 8;
export const TERM_MAINTENANCE_MAX_ACTIVE_SESSIONS = 1_000_000;

export const termControlDir = (home = resolveVellumCommandHome()): string => join(home, ".vellum-command", "term");
export const termControlSocketPath = (home = resolveVellumCommandHome()): string =>
  join(termControlDir(home), "control.sock");
export const termControlTokenPath = (home = resolveVellumCommandHome()): string =>
  join(termControlDir(home), "token");
/** Relative to remote $HOME — used for SSH unix forward. */
export const TERM_REMOTE_SOCK_REL = ".vellum-command/term/control.sock";

type TermControlActorSeatBase = {
  readonly bindingId: string;
  readonly harness: string;
  readonly agentKey: string;
  readonly canvasName: string;
  readonly nodeId: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly label?: string;
};

export type TermControlActorSeatCommand = TermControlActorSeatBase &
  (
    | {
        readonly admission: "occupy";
        readonly spawnIntent: ManagedSpawnIntent;
      }
    | {
        readonly admission: "activate";
        readonly expectedEpoch: string;
      }
  );

export type TermControlActorSeatRequest = {
  readonly v: typeof TERM_CONTROL_PROTOCOL;
  readonly id: string;
  readonly op: "createAgentSeat";
} & TermControlActorSeatCommand;

export type TermControlRequest =
  | { readonly v: typeof TERM_CONTROL_PROTOCOL; readonly id: string; readonly op: "ping" }
  | {
      readonly v: typeof TERM_CONTROL_PROTOCOL;
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
  | TermControlActorSeatRequest
  | { readonly v: typeof TERM_CONTROL_PROTOCOL; readonly id: string; readonly op: "list" }
  | {
      readonly v: typeof TERM_CONTROL_PROTOCOL;
      readonly id: string;
      readonly op: "directory.read";
      readonly path?: string;
    }
  | {
      readonly v: typeof TERM_CONTROL_PROTOCOL;
      readonly id: string;
      readonly op: "get";
      readonly bindingId: string;
    }
  | {
      readonly v: typeof TERM_CONTROL_PROTOCOL;
      readonly id: string;
      readonly op: "kill";
      readonly bindingId: string;
    }
  | {
      readonly v: typeof TERM_CONTROL_PROTOCOL;
      readonly id: string;
      readonly op: "bindCanvas";
      readonly bindingId: string;
      readonly ref: { canvasName?: string; nodeId?: string } | null;
    }
  | {
      readonly v: typeof TERM_CONTROL_PROTOCOL;
      readonly id: string;
      readonly op: "attach";
      readonly bindingId: string;
      readonly mode: "control" | "observe";
      readonly takeover?: boolean;
    }
  | {
      readonly v: typeof TERM_CONTROL_PROTOCOL;
      readonly id: string;
      readonly op: "release";
      readonly leaseId: string;
    }
  | {
      readonly v: typeof TERM_CONTROL_PROTOCOL;
      readonly id: string;
      readonly op: "write";
      readonly leaseId: string;
      readonly data: string;
    }
  | {
      // Managed prompt delivery through the destination's drive (paste+CR
      // recipe, idle/composer gates, evidence). Lease-free: product
      // automation, not an external terminal controller. No cancellation
      // identity: a client timeout is an uncertain outcome and never
      // authorizes a repaste.
      readonly v: typeof TERM_CONTROL_PROTOCOL;
      readonly id: string;
      readonly op: "managedPrompt";
      readonly bindingId: string;
      readonly text: string;
      readonly queueIfBusy?: boolean;
    }
  | {
      readonly v: typeof TERM_CONTROL_PROTOCOL;
      readonly id: string;
      readonly op: "resize";
      readonly leaseId: string;
      readonly cols: number;
      readonly rows: number;
    }
  | { readonly v: typeof TERM_CONTROL_PROTOCOL; readonly id: string; readonly op: "maintenance.acquire" }
  | { readonly v: typeof TERM_CONTROL_PROTOCOL; readonly id: string; readonly op: "maintenance.fence" }
  | { readonly v: typeof TERM_CONTROL_PROTOCOL; readonly id: string; readonly op: "maintenance.release" }
  | { readonly v: typeof TERM_CONTROL_PROTOCOL; readonly id: string; readonly op: "shutdown" };

export type TermMaintenanceRequest = Extract<
  TermControlRequest,
  { readonly op: "maintenance.acquire" | "maintenance.fence" | "maintenance.release" }
>;

export type TermControlResponse =
  | {
      readonly v: typeof TERM_CONTROL_PROTOCOL;
      readonly id: string;
      readonly ok: true;
      readonly data?: unknown;
    }
  | {
      readonly v: typeof TERM_CONTROL_PROTOCOL;
      readonly id: string;
      readonly ok: false;
      readonly error: string;
    };

/** Server → client push (after attach). */
export type TermControlEventFrame = {
  readonly v: typeof TERM_CONTROL_PROTOCOL;
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

const hasOnlyKeys = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean => Object.keys(value).every((key) => allowed.has(key));

const optionalString = (value: unknown): boolean =>
  value === undefined || typeof value === "string";

const isTerminalLaunch = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, new Set(["kind", "argv", "cwd", "env"]))) {
    return false;
  }
  if (
    value.kind !== "shell" &&
    value.kind !== "command" &&
    value.kind !== "harness"
  ) {
    return false;
  }
  if (
    value.argv !== undefined &&
    (!Array.isArray(value.argv) ||
      !value.argv.every((part) => typeof part === "string"))
  ) {
    return false;
  }
  if (!optionalString(value.cwd)) return false;
  if (value.env !== undefined) {
    if (!isRecord(value.env)) return false;
    if (!Object.values(value.env).every((item) => typeof item === "string")) {
      return false;
    }
  }
  return true;
};

const isInjectionContext = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(
      value,
      new Set([
        "seatBound",
        "connected",
        "seatRef",
        "connectedTargets",
        "regionInstruction",
      ]),
    ) ||
    typeof value.seatBound !== "boolean" ||
    typeof value.connected !== "boolean" ||
    !optionalString(value.seatRef) ||
    !optionalString(value.regionInstruction)
  ) {
    return false;
  }
  if (value.connectedTargets === undefined) return true;
  if (!Array.isArray(value.connectedTargets)) return false;
  return value.connectedTargets.every((target) => {
    if (!isRecord(target)) return false;
    return (
      hasOnlyKeys(target, new Set(["id", "kind", "summary"])) &&
      typeof target.id === "string" &&
      optionalString(target.kind) &&
      optionalString(target.summary)
    );
  });
};

/** Strict decoder for the actor-only host-finalized spawn payload. */
export const decodeManagedSpawnIntent = (
  value: unknown,
): ManagedSpawnIntent | undefined => {
  if (!isRecord(value)) return undefined;
  if (
    !hasOnlyKeys(
      value,
      new Set([
        "documentLaunch",
        "sessionId",
        "resumeRequested",
        "injection",
        "profile",
        "model",
        "effort",
        "permissionMode",
        "cwd",
      ]),
    ) ||
    typeof value.resumeRequested !== "boolean" ||
    !isInjectionContext(value.injection) ||
    !optionalString(value.sessionId) ||
    !optionalString(value.profile) ||
    !optionalString(value.model) ||
    !optionalString(value.effort) ||
    !optionalString(value.permissionMode) ||
    !optionalString(value.cwd) ||
    (value.documentLaunch !== undefined &&
      !isTerminalLaunch(value.documentLaunch))
  ) {
    return undefined;
  }
  return value as ManagedSpawnIntent;
};

const TERM_ACTOR_COMMON_KEYS = [
  "v",
  "id",
  "op",
  "admission",
  "bindingId",
  "harness",
  "agentKey",
  "canvasName",
  "nodeId",
  "cols",
  "rows",
  "label",
] as const;

const optionalPositiveInteger = (value: unknown): boolean =>
  value === undefined ||
  (typeof value === "number" && Number.isSafeInteger(value) && value > 0);

/** Exact decoder for the sole actor term-control verb and its admission mode. */
export const decodeTermControlActorSeatRequest = (
  value: unknown,
): TermControlActorSeatRequest | undefined => {
  if (
    !isRecord(value) ||
    value.v !== TERM_CONTROL_PROTOCOL ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 128 ||
    value.op !== "createAgentSeat" ||
    typeof value.bindingId !== "string" ||
    typeof value.harness !== "string" ||
    typeof value.agentKey !== "string" ||
    typeof value.canvasName !== "string" ||
    typeof value.nodeId !== "string" ||
    !optionalPositiveInteger(value.cols) ||
    !optionalPositiveInteger(value.rows) ||
    !optionalString(value.label)
  ) {
    return undefined;
  }
  if (value.admission === "occupy") {
    if (
      !hasOnlyKeys(value, new Set([...TERM_ACTOR_COMMON_KEYS, "spawnIntent"])) ||
      decodeManagedSpawnIntent(value.spawnIntent) === undefined
    ) {
      return undefined;
    }
    return value as TermControlActorSeatRequest;
  }
  if (value.admission === "activate") {
    if (
      !hasOnlyKeys(value, new Set([...TERM_ACTOR_COMMON_KEYS, "expectedEpoch"])) ||
      typeof value.expectedEpoch !== "string" ||
      value.expectedEpoch.trim() === ""
    ) {
      return undefined;
    }
    return value as TermControlActorSeatRequest;
  }
  return undefined;
};

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
