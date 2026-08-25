import type { CanvasDoc, CanvasNode, GroupNode } from "./canvas";
import type {
  CheckDef,
  ClaimDef,
  CompletionEvidence,
  Passage,
  SinkAdmission,
  Task,
  TaskClaim,
  TaskDefect,
  TasksSinkContract,
  TicketSide,
} from "./work-model";
import { resolveSinkAdmission } from "./work-model";
import { regionStack } from "./graph";
import { reachableStations } from "./flow-graph";
import { HOLD_FOR_MAX_MS } from "./work-control";

// Pipeline claims enforcement — pure structural checks only. The work service
// verifies presence/shape of responses, waivers, and tickets; it never
// executes claim verification and never judges truth (claims are prompts
// checked by minds — seats or the operator).

/** Where an effective claim came from — retained for briefing and errors. */
export type ClaimProvenance =
  | { readonly kind: "region"; readonly regionId: string; readonly label: string }
  | { readonly kind: "sink"; readonly nodeId: string }
  | { readonly kind: "task"; readonly station: string };

export type EffectiveClaim = {
  readonly claim: ClaimDef;
  readonly provenance: ClaimProvenance;
};

/** FinishCriteriaFailure-shaped, so callers format one error family. */
export type ClaimCheckFailure = {
  readonly missing: string;
  readonly message: string;
  readonly next_step: string;
  readonly claimId?: string;
};

const nodeById = (doc: CanvasDoc, nodeId: string): CanvasNode | undefined =>
  doc.nodes.find((node) => node.id === nodeId);

export const sinkContractOf = (
  node: CanvasNode | undefined,
): TasksSinkContract | undefined => node?.ether?.tasks?.contract;

const regionLabel = (group: GroupNode): string =>
  group.label?.trim() || group.id;

/**
 * Effective claims stack for a task at sink S: region stack claims
 * (outer → inner) ++ S sink-contract claims ++ task claims addressed to S.
 * Provenance is retained on every entry. No dedupe: reuse is copy-on-reuse,
 * so each authored claim is its own law.
 */
export const effectiveClaimsStack = (
  doc: CanvasDoc,
  sinkNodeId: string,
  task?: Task,
): ReadonlyArray<EffectiveClaim> => {
  const out: EffectiveClaim[] = [];
  for (const group of regionStack(doc, sinkNodeId)) {
    for (const claim of group.ether?.region?.contract?.claims ?? []) {
      out.push({
        claim,
        provenance: {
          kind: "region",
          regionId: group.id,
          label: regionLabel(group),
        },
      });
    }
  }
  for (const claim of sinkContractOf(nodeById(doc, sinkNodeId))?.claims ?? []) {
    out.push({ claim, provenance: { kind: "sink", nodeId: sinkNodeId } });
  }
  for (const claim of task?.claims ?? []) {
    if (claim.station !== sinkNodeId) continue;
    out.push({ claim, provenance: { kind: "task", station: claim.station } });
  }
  return out;
};

const provenanceLabel = (provenance: ClaimProvenance): string => {
  switch (provenance.kind) {
    case "region":
      return `region "${provenance.label}"`;
    case "sink":
      return `sink "${provenance.nodeId}"`;
    case "task":
      return `task claim addressed to "${provenance.station}"`;
  }
};

/**
 * Structural completion check: every effective HARD claim needs a response;
 * every SOFT claim needs a response or a waiver. Names the innermost unmet
 * claim (the stack is outer → inner, so the scan runs inner → outer).
 */
export const evaluateClaimCompletion = (params: {
  readonly stack: ReadonlyArray<EffectiveClaim>;
  readonly evidence: CompletionEvidence | undefined;
}): ClaimCheckFailure | undefined => {
  const responded = new Set(
    (params.evidence?.responses ?? []).map((entry) => entry.claimId),
  );
  const waived = new Set(
    (params.evidence?.claimWaivers ?? []).map((entry) => entry.claimId),
  );
  for (let index = params.stack.length - 1; index >= 0; index -= 1) {
    const { claim, provenance } = params.stack[index]!;
    if (responded.has(claim.id)) continue;
    if (claim.severity === "soft" && waived.has(claim.id)) continue;
    const where = provenanceLabel(provenance);
    return {
      missing: "claims",
      claimId: claim.id,
      message:
        claim.severity === "hard"
          ? `hard claim "${claim.text}" (${where}) has no response`
          : `soft claim "${claim.text}" (${where}) has no response or waiver`,
      next_step:
        claim.severity === "hard"
          ? `answer claim ${claim.id} via completionEvidence.responses`
          : `answer claim ${claim.id} via completionEvidence.responses, or waive it with completionEvidence.claimWaivers (non-empty reason)`,
    };
  }
  return undefined;
};

export const taskEpoch = (task: Task): number => task.epoch ?? 0;

/**
 * Re-attach trimmed claim responses/waivers onto normalized completion
 * evidence. The legacy normalizer predates the claims layer and rebuilds only
 * artifacts/git; receipts must survive normalization because they live in the
 * completed row (the passage record) for later-epoch accounting.
 */
export const carryClaimEvidence = (
  normalized: CompletionEvidence | undefined,
  raw: CompletionEvidence | undefined,
): CompletionEvidence | undefined => {
  if (raw === undefined) return normalized;
  const responses = (raw.responses ?? [])
    .map((entry) => {
      const refs = (entry.refs ?? [])
        .map((ref) => ref.trim())
        .filter((ref) => ref.length > 0);
      return {
        claimId: entry.claimId.trim(),
        response: entry.response.trim(),
        ...(refs.length > 0 ? { refs } : {}),
      };
    })
    .filter((entry) => entry.claimId.length > 0 && entry.response.length > 0);
  const claimWaivers = (raw.claimWaivers ?? [])
    .map((entry) => ({
      claimId: entry.claimId.trim(),
      reason: entry.reason.trim(),
    }))
    .filter((entry) => entry.claimId.length > 0 && entry.reason.length > 0);
  if (responses.length === 0 && claimWaivers.length === 0) return normalized;
  return {
    ...(normalized ?? { artifacts: [] }),
    ...(responses.length > 0 ? { responses } : {}),
    ...(claimWaivers.length > 0 ? { claimWaivers } : {}),
  };
};

/** Append-only defect log accessor. */
export const taskDefects = (task: Task): ReadonlyArray<TaskDefect> =>
  task.defects ?? [];

/**
 * Line position of a station: its first-visit index in the journey. A defect
 * target is always a visited station, so a missing station (corrupt record)
 * resolves to -1, which shadows everything — the conservative reading.
 */
const stationOrder = (
  journey: ReadonlyArray<Passage>,
  station: string,
): number => journey.findIndex((passage) => passage.nodeId === station);

/**
 * Derived receipt liveness. A receipt earned when `passage` completed is live
 * iff no later defect shadows it: a defect aimed at station S shadows the
 * receipts of every station at or downstream of S in journey order. Epochs
 * that pre-date the defect log (historical rows) have no target on record and
 * shadow globally, exactly as the old epoch-global rule read them. Liveness
 * is computed, never stored — no defect re-stamps or erases a receipt.
 */
const receiptLive = (
  task: Task,
  journey: ReadonlyArray<Passage>,
  passage: Passage,
): boolean => {
  const defects = taskDefects(task);
  const recorded = new Set(defects.map((defect) => defect.epoch));
  for (let epoch = passage.epoch + 1; epoch <= taskEpoch(task); epoch += 1) {
    if (!recorded.has(epoch)) return false;
  }
  const order = stationOrder(journey, passage.nodeId);
  return !defects.some(
    (defect) =>
      defect.epoch > passage.epoch &&
      stationOrder(journey, defect.target) <= order,
  );
};

/** A waiver never survives any later defect — the route re-decides from the target. */
const waiverLive = (task: Task, passage: Passage): boolean => {
  const later = taskEpoch(task) > passage.epoch;
  return !later;
};

/**
 * Receipts recorded at stations along the journey, with liveness DERIVED
 * from the append-only defect log. A response/waiver lives in the station
 * row's completionEvidence at that station (the passage record); a defect
 * aimed at station S shadows receipts at and downstream of S for closure
 * accounting (upstream receipts stay live), while history stays retained.
 *
 * `responded` maps claimId -> the set of stations that recorded a response
 * for it. Region/sink (ambient) claims are read "answered anywhere" — the
 * same law is in force at every station it covers, so one response settles
 * it for the whole journey. Task claims are station-addressed and must be
 * read with `respondedAtStation`, which checks the claim's OWN station only
 * — a response recorded at station A must never be read as satisfying a
 * task claim addressed to a different station Z (see evaluateForkWaivers /
 * evaluateTerminalClose). `waived` stays flat/journey-wide: a fork-waiver is
 * exercised at whichever forwarding station's choice abandons the claim's
 * station — rarely the claim's own station, that is the point of waiving it.
 */
export const stationReceipts = (
  doc: CanvasDoc,
  task: Task,
): {
  readonly responded: ReadonlyMap<string, ReadonlySet<string>>;
  readonly waived: ReadonlySet<string>;
} => {
  const journey = task.journey ?? [];
  const responded = new Map<string, Set<string>>();
  const waived = new Set<string>();
  // A station's row holds the evidence of its LATEST completion there —
  // re-homing replaces the row — so each station is read once, against the
  // last passage that completed at it (exit forwarded or closed).
  const latestCompleted = new Map<string, Passage>();
  for (const passage of journey) {
    if (passage.exit !== "forwarded" && passage.exit !== "closed") continue;
    latestCompleted.set(passage.nodeId, passage);
  }
  for (const [station, passage] of latestCompleted) {
    const row = nodeById(doc, station)?.ether?.tasks?.items.find(
      (item) => item.id === task.id,
    );
    if (row?.completionEvidence === undefined) continue;
    if (receiptLive(task, journey, passage)) {
      for (const entry of row.completionEvidence.responses ?? []) {
        const stations = responded.get(entry.claimId) ?? new Set<string>();
        stations.add(station);
        responded.set(entry.claimId, stations);
      }
    }
    if (waiverLive(task, passage)) {
      for (const entry of row.completionEvidence.claimWaivers ?? []) {
        waived.add(entry.claimId);
      }
    }
  }
  return { responded, waived };
};

/** True only when `claimId` was answered exactly at `station` — never elsewhere. */
export const respondedAtStation = (
  responded: ReadonlyMap<string, ReadonlySet<string>>,
  station: string,
  claimId: string,
): boolean => responded.get(claimId)?.has(station) ?? false;

/**
 * Fork-waiver rule at forward time: forwarding is choose-one, so any task
 * station-addressed claim whose station falls off the chosen branch
 * (not in reachableStations from `next`) must be already checked in the
 * current epoch or explicitly waived now.
 */
export const evaluateForkWaivers = (params: {
  readonly doc: CanvasDoc;
  readonly sinkNodeId: string;
  readonly task: Task;
  readonly next: string;
  readonly evidence: CompletionEvidence | undefined;
}): ClaimCheckFailure | undefined => {
  const claims = params.task.claims ?? [];
  if (claims.length === 0) return undefined;
  const reachable = reachableStations(params.doc, params.next);
  const receipts = stationReceipts(params.doc, params.task);
  const localResponded = new Set(
    (params.evidence?.responses ?? []).map((entry) => entry.claimId),
  );
  const waived = new Set([
    ...receipts.waived,
    ...(params.evidence?.claimWaivers ?? []).map((entry) => entry.claimId),
  ]);
  for (const claim of claims) {
    if (reachable.has(claim.station)) continue;
    const respondedAtOwnStation =
      respondedAtStation(receipts.responded, claim.station, claim.id) ||
      (claim.station === params.sinkNodeId && localResponded.has(claim.id));
    if (respondedAtOwnStation || waived.has(claim.id)) continue;
    return {
      missing: "claims.forkWaiver",
      claimId: claim.id,
      message: `forwarding to "${params.next}" abandons station "${claim.station}" with unchecked claim "${claim.text}"`,
      next_step: `waive claim ${claim.id} with completionEvidence.claimWaivers (non-empty reason), or forward along a branch that reaches "${claim.station}"`,
    };
  }
  return undefined;
};

/**
 * Terminal-close check (completed at a sink with no flow destinations):
 * every task station-addressed claim was checked at its station in the
 * current epoch — receipts live in passage records — or waived.
 */
export const evaluateTerminalClose = (params: {
  readonly doc: CanvasDoc;
  readonly sinkNodeId: string;
  readonly task: Task;
  readonly evidence: CompletionEvidence | undefined;
}): ClaimCheckFailure | undefined => {
  const claims = params.task.claims ?? [];
  if (claims.length === 0) return undefined;
  const receipts = stationReceipts(params.doc, params.task);
  const localResponded = new Set(
    (params.evidence?.responses ?? []).map((entry) => entry.claimId),
  );
  const waived = new Set([
    ...receipts.waived,
    ...(params.evidence?.claimWaivers ?? []).map((entry) => entry.claimId),
  ]);
  for (const claim of claims) {
    const respondedAtOwnStation =
      respondedAtStation(receipts.responded, claim.station, claim.id) ||
      (claim.station === params.sinkNodeId && localResponded.has(claim.id));
    if (respondedAtOwnStation || waived.has(claim.id)) continue;
    return {
      missing: "claims.terminal",
      claimId: claim.id,
      message: `cannot close: claim "${claim.text}" addressed to station "${claim.station}" was never checked in epoch ${taskEpoch(params.task)}`,
      next_step: `answer claim ${claim.id} at station "${claim.station}", or waive it with completionEvidence.claimWaivers`,
    };
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Boarding checks (tickets are system-stamped by the tasks.board op handler;
// checklist EXECUTION is the seat CLI's job — never the kernel's).

export type RequiredBoardingCheck = {
  readonly check: CheckDef;
  readonly side: TicketSide;
};

/** S.outbound checks + chosen destination's inbound checks, in that order. */
export const requiredBoardingChecks = (
  doc: CanvasDoc,
  fromNodeId: string,
  next: string,
): ReadonlyArray<RequiredBoardingCheck> => {
  const outbound =
    sinkContractOf(nodeById(doc, fromNodeId))?.outbound?.checklist ?? [];
  const inbound =
    sinkContractOf(nodeById(doc, next))?.inbound?.checklist ?? [];
  return [
    ...outbound.map((check) => ({ check, side: "outbound" as const })),
    ...inbound.map((check) => ({ check, side: "inbound" as const })),
  ];
};

/**
 * Every required check needs a green (exit 0) current-epoch ticket stamped
 * against the check's CURRENT authored command. A ticket carries the command
 * it ran (see Ticket.command); if the operator edits the check afterward, the
 * ticket no longer speaks to what the check now demands and is stale — a red,
 * missing, or stale ticket names the first blocked check.
 */
export const evaluateBoarding = (params: {
  readonly task: Task;
  readonly checks: ReadonlyArray<RequiredBoardingCheck>;
}): ClaimCheckFailure | undefined => {
  const epoch = taskEpoch(params.task);
  const tickets = (params.task.boarding ?? []).filter(
    (ticket) => ticket.epoch === epoch,
  );
  for (const { check, side } of params.checks) {
    const ticket = tickets.find(
      (candidate) => candidate.checkId === check.id && candidate.side === side,
    );
    if (ticket === undefined) {
      return {
        missing: "boarding",
        message: `${side} boarding check "${check.label}" has no ticket for epoch ${epoch}`,
        next_step: `run the boarding checks (tasks board) so the work service can stamp a green ticket for check ${check.id}`,
      };
    }
    if (ticket.command !== check.command) {
      return {
        missing: "boarding.stale",
        message: `${side} boarding check "${check.label}" ticket is stale — the authored command changed since it was stamped`,
        next_step: `re-run the boarding checks (tasks board) so the work service can stamp a fresh ticket for check ${check.id}`,
      };
    }
    if (ticket.exitCode !== 0) {
      return {
        missing: "boarding.red",
        message: `${side} boarding check "${check.label}" is red (exit ${ticket.exitCode})`,
        next_step: `fix the failure and re-run the boarding checks (tasks board) for check ${check.id}`,
      };
    }
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Admission (kernel auto-claim + seat claim gate).

export type TaskAdmissionState =
  | "claimable"
  | "held"
  | "operator-gated"
  | "operator-owned";

/**
 * Operator promotion marker for operator-gated arrivals. Lives in the task
 * metadata bag (epoch-scoped) because Passage is a closed schema and the
 * marker must stay additive; only the operator promote op writes it.
 */
export const PIPELINE_ADMITTED_METADATA_KEY = "vellum.pipeline.admittedEpoch";

export const taskPromoted = (task: Task): boolean =>
  task.metadata?.[PIPELINE_ADMITTED_METADATA_KEY] === taskEpoch(task);

const ADMISSION_RANK: Readonly<Record<SinkAdmission, 0 | 1 | 2>> = {
  auto: 0,
  "operator-gated": 1,
  "operator-owned": 2,
};

/**
 * Requester overlay vs sink floor. The sink is the floor — a requester may
 * only tighten. Agent wire omit defaults to operator-gated (persisted);
 * operator create omit inherits the sink (no stamp).
 */
export const clampRequestedAdmission = (input: {
  readonly floor: SinkAdmission;
  readonly requested: SinkAdmission | undefined;
  readonly omitted: "operator-gated" | "inherit";
}):
  | { readonly ok: true; readonly stamp: SinkAdmission | undefined }
  | { readonly ok: false; readonly message: string } => {
  const floor = input.floor;
  if (input.requested !== undefined) {
    if (ADMISSION_RANK[input.requested] < ADMISSION_RANK[floor]) {
      return {
        ok: false,
        message:
          `admission "${input.requested}" loosens sink floor "${floor}"; requester may only tighten`,
      };
    }
    return { ok: true, stamp: input.requested };
  }
  if (input.omitted === "inherit") return { ok: true, stamp: undefined };
  if (ADMISSION_RANK["operator-gated"] < ADMISSION_RANK[floor]) {
    return { ok: true, stamp: floor };
  }
  return { ok: true, stamp: "operator-gated" };
};

/**
 * Effective admission of a stored task. Omitted Task.admission inherits the
 * sink floor (historical rows). A stored overlay that is somehow looser than
 * the floor is ignored — the floor wins.
 */
export const effectiveTaskAdmission = (
  task: Pick<Task, "admission">,
  contract: TasksSinkContract | undefined,
): SinkAdmission => {
  const floor = resolveSinkAdmission(contract);
  const requested = task.admission;
  if (requested === undefined) return floor;
  return ADMISSION_RANK[requested] >= ADMISSION_RANK[floor] ? requested : floor;
};

/**
 * Admission state of a submitted arrival at a sink. Operator-owned dominates
 * (no seat claim ever); then bake hold; then the operator gate.
 * Effective admission is max(sink floor, per-task overlay).
 */
export const taskAdmissionState = (
  task: Task,
  contract: TasksSinkContract | undefined,
  nowMs: number,
): TaskAdmissionState => {
  const admission = effectiveTaskAdmission(task, contract);
  if (admission === "operator-owned") return "operator-owned";
  const holdUntil = task.holdUntil === undefined ? NaN : Date.parse(task.holdUntil);
  if (Number.isFinite(holdUntil) && holdUntil > nowMs) return "held";
  if (admission === "operator-gated" && !taskPromoted(task)) {
    return "operator-gated";
  }
  return "claimable";
};

/**
 * holdUntil stamped at arrival: an explicit per-task holdFor stamp wins over
 * the station's claimableAfterMs default. Undefined when neither applies.
 * Clamped to HOLD_FOR_MAX_MS regardless of source — a stale or unvalidated
 * station default must never park a task past the same outer bound the wire
 * schema enforces on holdForMs.
 */
export const computeHoldUntil = (
  nowMs: number,
  claimableAfterMs: number | undefined,
  holdForMs: number | undefined,
): string | undefined => {
  const delay = holdForMs ?? claimableAfterMs;
  if (delay === undefined || delay <= 0) return undefined;
  return new Date(nowMs + Math.min(delay, HOLD_FOR_MAX_MS)).toISOString();
};
