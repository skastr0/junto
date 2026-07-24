/**
 * Command Center projection delivery lane (beta ship slice).
 *
 * Compiles full-canvas-set frames from live canvas documents, tracks per-host
 * delivery status (pending → applied | rejected | unreachable), and applies
 * locally via the Station projection store for same-machine / unit-test
 * targets.
 *
 * Remote push: inject `createProjectionDeliveryTransport(ssh)` so enrolled
 * remotes receive frames via SshTransport + `compileProjectionFrameDeliver`
 * (stdin atomic write to `~/.vellum/projections/incoming.frame`). Without a
 * transport, remote targets record honest `unreachable`.
 *
 * Residual: auto-tick on Command Center canvas writes; Remote interval poll
 * (boot apply is wired). canvas-pull remains fallback for operators.
 */

import type { CanvasDoc } from "@shared/canvas";
import { serializeCanvas } from "@shared/canvas";
import {
  projectionRecordFromResult,
  type StationProjectionDeliveryStatus,
  type StationProjectionRecord,
} from "@shared/station-status";
import {
  compileStationProjection,
  type CompiledStationProjection,
  type CompileStationProjectionInput,
} from "./compiler";
import {
  applyStationProjectionGeneration,
  type ApplyStationProjectionResult,
} from "./station-store";
import { recordStationProjection } from "../station-status-store";

// ---------------------------------------------------------------------------
// Pure status machine
// ---------------------------------------------------------------------------

export type ProjectionDeliveryEvent =
  | { readonly type: "schedule" }
  | { readonly type: "applied"; readonly detail?: string }
  | { readonly type: "staged"; readonly detail?: string }
  | { readonly type: "rejected"; readonly detail: string }
  | { readonly type: "unreachable"; readonly detail: string };

export type ProjectionDeliveryTransition =
  | {
      readonly ok: true;
      readonly status: StationProjectionDeliveryStatus;
      readonly terminal: boolean;
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly status: StationProjectionDeliveryStatus | undefined;
      readonly error: string;
    };

const DEFAULT_DETAILS: Record<ProjectionDeliveryEvent["type"], string> = {
  schedule: "projection delivery scheduled",
  applied: "projection applied",
  staged: "projection frame staged (awaiting remote apply)",
  rejected: "projection rejected",
  unreachable: "projection target unreachable",
};

/**
 * Pure delivery status machine.
 *
 * schedule  → pending (always; starts a new attempt)
 * pending   + applied|staged|rejected|unreachable → that status
 * terminal  + schedule → pending (new attempt)
 * terminal  + outcome event → refused (illegal transition)
 *
 * `staged` = SSH drop succeeded; Remote has not applied yet (honest CC receipt).
 * `applied` = local store install or Remote ack (cut 5).
 */
export const reduceProjectionDelivery = (
  current: StationProjectionDeliveryStatus | undefined,
  event: ProjectionDeliveryEvent,
): ProjectionDeliveryTransition => {
  if (event.type === "schedule") {
    return {
      ok: true,
      status: "pending",
      terminal: false,
      detail: DEFAULT_DETAILS.schedule,
    };
  }

  if (current !== "pending") {
    return {
      ok: false,
      status: current,
      error: `cannot apply event ${event.type} while status is ${current ?? "unset"}`,
    };
  }

  switch (event.type) {
    case "applied":
      return {
        ok: true,
        status: "applied",
        terminal: true,
        detail: event.detail ?? DEFAULT_DETAILS.applied,
      };
    case "staged":
      return {
        ok: true,
        status: "staged",
        terminal: true,
        detail: event.detail ?? DEFAULT_DETAILS.staged,
      };
    case "rejected":
      return {
        ok: true,
        status: "rejected",
        terminal: true,
        detail: event.detail,
      };
    case "unreachable":
      return {
        ok: true,
        status: "unreachable",
        terminal: true,
        detail: event.detail,
      };
  }
};

// ---------------------------------------------------------------------------
// Compile from live canvases
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

/** Serialize live canvas docs into the document map the compiler expects. */
export const documentsFromCanvasDocs = (
  docs: ReadonlyArray<{ readonly name: string; readonly doc: CanvasDoc }>,
): Map<string, Uint8Array> => {
  const map = new Map<string, Uint8Array>();
  for (const entry of docs) {
    map.set(entry.name, textEncoder.encode(serializeCanvas(entry.doc)));
  }
  return map;
};

export type CompileProjectionSnapshotInput = {
  readonly generation: string;
  readonly createdAt?: string;
  readonly commandCenterWitness: string;
  readonly targetWitness: string;
  readonly documents:
    | ReadonlyMap<string, Uint8Array>
    | ReadonlyArray<{ readonly name: string; readonly doc: CanvasDoc }>;
};

/**
 * Compile a complete full-canvas-set generation from live (or staged) docs.
 * Uses serializeCanvas for CanvasDoc inputs so wire bytes match product form.
 */
export const compileProjectionSnapshot = (
  input: CompileProjectionSnapshotInput,
): CompiledStationProjection => {
  const documents: ReadonlyMap<string, Uint8Array> = Array.isArray(
    input.documents,
  )
    ? documentsFromCanvasDocs(input.documents)
    : (input.documents as ReadonlyMap<string, Uint8Array>);

  const compileInput: CompileStationProjectionInput = {
    generation: input.generation,
    createdAt: input.createdAt ?? new Date().toISOString(),
    commandCenterWitness: input.commandCenterWitness,
    targetWitness: input.targetWitness,
    documents,
  };
  return compileStationProjection(compileInput);
};

// ---------------------------------------------------------------------------
// Local apply (test / same-machine)
// ---------------------------------------------------------------------------

export type LocalProjectionApplyResult = {
  readonly status: "applied" | "rejected";
  readonly generation: string;
  readonly manifestSha256: string;
  readonly frameSha256: string;
  readonly detail: string;
  readonly apply?: ApplyStationProjectionResult;
};

/**
 * Apply a compiled projection into a Station projection store root.
 * Used by unit tests and local/test targets — never mutates canvas authority.
 */
export const applyLocalProjectionForTest = async (
  compiled: CompiledStationProjection,
  root?: string,
): Promise<LocalProjectionApplyResult> => {
  try {
    const apply = await applyStationProjectionGeneration(
      { kind: "compiled", compiled },
      root,
    );
    return {
      status: "applied",
      generation: compiled.manifest.generation,
      manifestSha256: compiled.manifestSha256,
      frameSha256: compiled.frameSha256,
      detail:
        apply.status === "idempotent"
          ? `idempotent re-apply of generation ${apply.generation}`
          : `installed generation ${apply.generation}`,
      apply,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    return {
      status: "rejected",
      generation: compiled.manifest.generation,
      manifestSha256: compiled.manifestSha256,
      frameSha256: compiled.frameSha256,
      detail: message.slice(0, 4_096),
    };
  }
};

// ---------------------------------------------------------------------------
// Host sync schedule
// ---------------------------------------------------------------------------

export type ProjectionHostTarget = {
  readonly hostId: string;
  /** Remote endpoint when enrolled; omit for local/test apply. */
  readonly endpoint?: string;
  /**
   * `local` — apply via station projection store on this machine.
   * `record-only` — exercise status machine without I/O (tests).
   * `remote` — Remote push; requires transport or records residual unreachable.
   */
  readonly mode: "local" | "record-only" | "remote";
};

export type ProjectionDeliveryTransport = {
  /**
   * Optional remote bridge. When absent, remote-mode targets become unreachable
   * with an honest residual detail string.
   */
  readonly deliver?: (input: {
    readonly hostId: string;
    readonly endpoint: string;
    readonly compiled: CompiledStationProjection;
  }) => Promise<
    | { readonly ok: true; readonly detail?: string }
    | {
        readonly ok: false;
        readonly status: "rejected" | "unreachable";
        readonly detail: string;
      }
  >;
};

export type ScheduleHostSyncDeps = {
  readonly record?: (record: StationProjectionRecord) => Promise<void>;
  readonly applyLocal?: (
    compiled: CompiledStationProjection,
    root?: string,
  ) => Promise<LocalProjectionApplyResult>;
  readonly transport?: ProjectionDeliveryTransport;
  readonly now?: () => string;
  /** Station projection store root for local mode (tests inject temp dirs). */
  readonly localStoreRoot?: string;
};

export type HostSyncOutcome = {
  readonly hostId: string;
  readonly record: StationProjectionRecord;
};

export type ScheduleHostSyncResult = {
  readonly generation: string;
  readonly manifestSha256: string;
  readonly frameSha256: string;
  readonly outcomes: ReadonlyArray<HostSyncOutcome>;
};

const REMOTE_BRIDGE_RESIDUAL =
  "Remote projection transport not injected — frame not delivered; inject createProjectionDeliveryTransport or use canvas-pull fallback";

/**
 * For each enrolled host target: record pending, then resolve to applied /
 * rejected / unreachable and persist the receipt.
 *
 * Pure status transitions go through `reduceProjectionDelivery` so unit tests
 * can assert the machine without transport.
 */
export const scheduleHostSync = async (
  compiled: CompiledStationProjection,
  targets: ReadonlyArray<ProjectionHostTarget>,
  deps: ScheduleHostSyncDeps = {},
): Promise<ScheduleHostSyncResult> => {
  const recordStatus = deps.record ?? recordStationProjection;
  const applyLocal = deps.applyLocal ?? applyLocalProjectionForTest;
  const now = deps.now ?? (() => new Date().toISOString());
  const outcomes: HostSyncOutcome[] = [];

  for (const target of targets) {
    const base = {
      hostId: target.hostId,
      endpoint: target.endpoint,
      generation: compiled.manifest.generation,
      manifestSha256: compiled.manifestSha256,
      frameSha256: compiled.frameSha256,
    };

    const scheduled = reduceProjectionDelivery(undefined, { type: "schedule" });
    if (!scheduled.ok) {
      // Unreachable: schedule always succeeds from undefined.
      continue;
    }

    const pending = projectionRecordFromResult({
      ...base,
      status: scheduled.status,
      detail: scheduled.detail,
      at: now(),
    });
    await recordStatus(pending);

    let finalEvent: ProjectionDeliveryEvent;
    if (target.mode === "local") {
      const applied = await applyLocal(compiled, deps.localStoreRoot);
      finalEvent =
        applied.status === "applied"
          ? { type: "applied", detail: applied.detail }
          : { type: "rejected", detail: applied.detail };
    } else if (target.mode === "record-only") {
      // Tests drive the outcome via transport or leave pending by injecting
      // a no-op apply path. Default: applied (receipt-only success).
      finalEvent = {
        type: "applied",
        detail: "record-only delivery marked applied",
      };
    } else {
      // remote push residual
      const endpoint = target.endpoint?.trim() ?? "";
      if (!endpoint) {
        finalEvent = {
          type: "rejected",
          detail: "remote projection target missing endpoint",
        };
      } else if (deps.transport?.deliver) {
        const result = await deps.transport.deliver({
          hostId: target.hostId,
          endpoint,
          compiled,
        });
        if (result.ok) {
          // SSH stage only — do not claim applied until Remote install/ack.
          finalEvent = {
            type: "staged",
            detail: result.detail ?? `frame staged at ${endpoint}`,
          };
        } else {
          finalEvent = {
            type: result.status,
            detail: result.detail,
          };
        }
      } else {
        finalEvent = {
          type: "unreachable",
          detail: REMOTE_BRIDGE_RESIDUAL,
        };
      }
    }

    const reduced = reduceProjectionDelivery("pending", finalEvent);
    const finalRecord = projectionRecordFromResult({
      ...base,
      status: reduced.ok
        ? reduced.status
        : finalEvent.type === "schedule"
          ? "pending"
          : finalEvent.type === "applied"
            ? "applied"
            : finalEvent.type === "staged"
              ? "staged"
              : finalEvent.type === "rejected"
                ? "rejected"
                : "unreachable",
      detail: reduced.ok
        ? reduced.detail
        : "detail" in finalEvent
          ? (finalEvent.detail ?? reduced.error)
          : reduced.error,
      at: now(),
    });
    await recordStatus(finalRecord);
    outcomes.push({ hostId: target.hostId, record: finalRecord });
  }

  return {
    generation: compiled.manifest.generation,
    manifestSha256: compiled.manifestSha256,
    frameSha256: compiled.frameSha256,
    outcomes,
  };
};

/**
 * Convenience: compile from documents then schedule sync for enrolled remotes.
 * Callers (Command Center IPC / future kernel tick) own when this runs.
 *
 * Product remote push: pass `transport: createProjectionDeliveryTransport(ssh)`.
 */
export const deliverProjectionToHosts = async (
  input: CompileProjectionSnapshotInput & {
    readonly targets: ReadonlyArray<ProjectionHostTarget>;
  },
  deps: ScheduleHostSyncDeps = {},
): Promise<ScheduleHostSyncResult> => {
  const compiled = compileProjectionSnapshot(input);
  return scheduleHostSync(compiled, input.targets, deps);
};

export const REMOTE_PROJECTION_BRIDGE_RESIDUAL_DETAIL = REMOTE_BRIDGE_RESIDUAL;
