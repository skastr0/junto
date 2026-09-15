import type { CanvasDoc, CanvasNode, GroupNode } from "./canvas";
import type {
  Check,
  CheckSide,
  CompletionEvidence,
  Rule,
  Task,
  TaskAdmission,
  TaskDefect,
  TasksContract,
  Visit,
} from "./work-model";
import { resolveTaskAdmission } from "./work-model";
import { regionStack } from "./graph";
import { reachableBoards } from "./flow-graph";
import { WAIT_FOR_MAX_MS } from "./work-control";

// Pure structural enforcement for task rules, claims, checks, and admission.
// The work service validates presence and shape. It never judges whether an
// agent's claim about the work is true.

export type RuleProvenance =
  | { readonly kind: "region"; readonly regionId: string; readonly label: string }
  | { readonly kind: "board"; readonly boardId: string }
  | { readonly kind: "task"; readonly board: string };

export type RuleInForce = {
  readonly rule: Rule;
  readonly provenance: RuleProvenance;
};

/** FinishCriteriaFailure-shaped so callers format one error family. */
export type RuleFailure = {
  readonly missing: string;
  readonly message: string;
  readonly next_step: string;
  readonly ruleId?: string;
};

const nodeById = (doc: CanvasDoc, nodeId: string): CanvasNode | undefined =>
  doc.nodes.find((node) => node.id === nodeId);

export const boardContractOf = (
  node: CanvasNode | undefined,
): TasksContract | undefined => node?.ether?.tasks?.contract;

const regionLabel = (group: GroupNode): string => group.label?.trim() || group.id;

/**
 * Rules in force at a board: enclosing regions outer to inner, board rules,
 * then task rules addressed to this board. Authored entries are concatenated;
 * there is no override, precedence, or deduplication.
 */
export const rulesInForce = (
  doc: CanvasDoc,
  boardId: string,
  task?: Task,
): ReadonlyArray<RuleInForce> => {
  const out: RuleInForce[] = [];
  for (const group of regionStack(doc, boardId)) {
    for (const rule of group.ether?.region?.contract?.rules ?? []) {
      out.push({
        rule,
        provenance: {
          kind: "region",
          regionId: group.id,
          label: regionLabel(group),
        },
      });
    }
  }
  for (const rule of boardContractOf(nodeById(doc, boardId))?.rules ?? []) {
    out.push({ rule, provenance: { kind: "board", boardId } });
  }
  for (const rule of task?.rules ?? []) {
    if (rule.board !== boardId) continue;
    out.push({ rule, provenance: { kind: "task", board: rule.board } });
  }
  return out;
};

const provenanceLabel = (provenance: RuleProvenance): string => {
  switch (provenance.kind) {
    case "region":
      return `region "${provenance.label}"`;
    case "board":
      return `board "${provenance.boardId}"`;
    case "task":
      return `task rule at board "${provenance.board}"`;
  }
};

/** Statement rules need claims; review rules are discharged by the verdict gate. */
export const evaluateRules = (params: {
  readonly rules: ReadonlyArray<RuleInForce>;
  readonly evidence: CompletionEvidence | undefined;
}): RuleFailure | undefined => {
  const claimed = new Set(
    (params.evidence?.claims ?? []).map((entry) => entry.ruleId),
  );
  for (let index = params.rules.length - 1; index >= 0; index -= 1) {
    const { rule, provenance } = params.rules[index]!;
    if (rule.kind === "requires-review") continue;
    if (claimed.has(rule.id)) continue;
    return {
      missing: "claims",
      ruleId: rule.id,
      message: `rule "${rule.text}" (${provenanceLabel(provenance)}) has no claim`,
      next_step: `make a claim for rule ${rule.id} via completionEvidence.claims`,
    };
  }
  return undefined;
};

export const taskEpoch = (task: Task): number => task.epoch ?? 0;

/** Reattach trimmed claims and waivers after base evidence normalization. */
export const normalizeRuleEvidence = (
  normalized: CompletionEvidence | undefined,
  raw: CompletionEvidence | undefined,
): CompletionEvidence | undefined => {
  if (raw === undefined) return normalized;
  const claims = (raw.claims ?? [])
    .map((entry) => {
      const refs = (entry.refs ?? [])
        .map((ref) => ref.trim())
        .filter((ref) => ref.length > 0);
      return {
        ruleId: entry.ruleId.trim(),
        text: entry.text.trim(),
        ...(refs.length > 0 ? { refs } : {}),
      };
    })
    .filter((entry) => entry.ruleId.length > 0 && entry.text.length > 0);
  const waivers = (raw.waivers ?? [])
    .map((entry) => ({
      ruleId: entry.ruleId.trim(),
      reason: entry.reason.trim(),
    }))
    .filter((entry) => entry.ruleId.length > 0 && entry.reason.length > 0);
  if (claims.length === 0 && waivers.length === 0) return normalized;
  return {
    ...(normalized ?? { artifacts: [] }),
    ...(claims.length > 0 ? { claims } : {}),
    ...(waivers.length > 0 ? { waivers } : {}),
  };
};

export const taskDefects = (task: Task): ReadonlyArray<TaskDefect> =>
  task.defects ?? [];

const boardOrder = (visits: ReadonlyArray<Visit>, board: string): number =>
  visits.findIndex((visit) => visit.board === board);

/** A claim remains live unless a later defect targeted its board or earlier. */
export const claimIsLive = (
  task: Task,
  visits: ReadonlyArray<Visit>,
  visit: Visit,
): boolean => {
  const defects = taskDefects(task);
  const recorded = new Set(defects.map((defect) => defect.epoch));
  for (let epoch = visit.epoch + 1; epoch <= taskEpoch(task); epoch += 1) {
    if (!recorded.has(epoch)) return false;
  }
  const order = boardOrder(visits, visit.board);
  return !defects.some(
    (defect) =>
      defect.epoch > visit.epoch && boardOrder(visits, defect.target) <= order,
  );
};

/** A waiver never survives a later defect. */
export const waiverIsLive = (task: Task, visit: Visit): boolean =>
  taskEpoch(task) === visit.epoch;

/** Latest completed visit represented by each board's material task row. */
export const latestCompletedVisits = (
  visits: ReadonlyArray<Visit>,
): ReadonlyMap<string, Visit> => {
  const latest = new Map<string, Visit>();
  for (const visit of visits) {
    if (visit.exit !== "sent-on" && visit.exit !== "completed") continue;
    latest.set(visit.board, visit);
  }
  return latest;
};

export type RecordedClaims = {
  readonly claimed: ReadonlyMap<string, ReadonlySet<string>>;
  readonly waived: ReadonlySet<string>;
};

/** Claims and waivers recorded by completed board visits. */
export const claimsRecorded = (
  doc: CanvasDoc,
  task: Task,
): RecordedClaims => {
  const visits = task.visits ?? [];
  const claimed = new Map<string, Set<string>>();
  const waived = new Set<string>();
  for (const [board, visit] of latestCompletedVisits(visits)) {
    const row = nodeById(doc, board)?.ether?.tasks?.items.find(
      (item) => item.id === task.id,
    );
    if (row?.completionEvidence === undefined) continue;
    if (claimIsLive(task, visits, visit)) {
      for (const entry of row.completionEvidence.claims ?? []) {
        const boards = claimed.get(entry.ruleId) ?? new Set<string>();
        boards.add(board);
        claimed.set(entry.ruleId, boards);
      }
    }
    if (waiverIsLive(task, visit)) {
      for (const entry of row.completionEvidence.waivers ?? []) {
        waived.add(entry.ruleId);
      }
    }
  }
  return { claimed, waived };
};

export const claimedAtBoard = (
  claimed: ReadonlyMap<string, ReadonlySet<string>>,
  board: string,
  ruleId: string,
): boolean => claimed.get(ruleId)?.has(board) ?? false;

/**
 * A task rule may be waived only when the selected path no longer reaches its
 * board. Review rules belong to the independent verdict gate, never a waiver.
 */
export const evaluateForkWaivers = (params: {
  readonly doc: CanvasDoc;
  readonly boardId: string;
  readonly task: Task;
  readonly next: string;
  readonly evidence: CompletionEvidence | undefined;
}): RuleFailure | undefined => {
  const rules = params.task.rules ?? [];
  if (rules.length === 0) return undefined;
  const reachable = reachableBoards(params.doc, params.next);
  const recorded = claimsRecorded(params.doc, params.task);
  const localClaims = new Set(
    (params.evidence?.claims ?? []).map((entry) => entry.ruleId),
  );
  const waived = new Set([
    ...recorded.waived,
    ...(params.evidence?.waivers ?? []).map((entry) => entry.ruleId),
  ]);
  for (const rule of rules) {
    if (rule.kind === "requires-review") continue;
    if (reachable.has(rule.board)) continue;
    const answered =
      claimedAtBoard(recorded.claimed, rule.board, rule.id) ||
      (rule.board === params.boardId && localClaims.has(rule.id));
    if (answered || waived.has(rule.id)) continue;
    return {
      missing: "waivers",
      ruleId: rule.id,
      message: `sending this task to "${params.next}" leaves board "${rule.board}" without a claim for rule "${rule.text}"`,
      next_step: `waive rule ${rule.id} with completionEvidence.waivers, or choose a path that reaches "${rule.board}"`,
    };
  }
  return undefined;
};

/** Every statement task rule needs a claim at its board or a live fork waiver. */
export const evaluateTerminalClose = (params: {
  readonly doc: CanvasDoc;
  readonly boardId: string;
  readonly task: Task;
  readonly evidence: CompletionEvidence | undefined;
}): RuleFailure | undefined => {
  const rules = params.task.rules ?? [];
  if (rules.length === 0) return undefined;
  const recorded = claimsRecorded(params.doc, params.task);
  const localClaims = new Set(
    (params.evidence?.claims ?? []).map((entry) => entry.ruleId),
  );
  const waived = new Set([
    ...recorded.waived,
    ...(params.evidence?.waivers ?? []).map((entry) => entry.ruleId),
  ]);
  for (const rule of rules) {
    if (rule.kind === "requires-review") continue;
    const answered =
      claimedAtBoard(recorded.claimed, rule.board, rule.id) ||
      (rule.board === params.boardId && localClaims.has(rule.id));
    if (answered || waived.has(rule.id)) continue;
    return {
      missing: "claims",
      ruleId: rule.id,
      message: `cannot complete: rule "${rule.text}" at board "${rule.board}" has no claim in epoch ${taskEpoch(params.task)}`,
      next_step: `make a claim for rule ${rule.id} at board "${rule.board}"`,
    };
  }
  return undefined;
};

export type RequiredCheck = {
  readonly check: Check;
  readonly side: CheckSide;
};

/** Current board outgoing checks followed by the next board incoming checks. */
export const requiredChecks = (
  doc: CanvasDoc,
  fromBoardId: string,
  next: string,
): ReadonlyArray<RequiredCheck> => {
  const outgoing =
    boardContractOf(nodeById(doc, fromBoardId))?.outgoing?.checks ?? [];
  const incoming = boardContractOf(nodeById(doc, next))?.incoming?.checks ?? [];
  return [
    ...outgoing.map((check) => ({ check, side: "outgoing" as const })),
    ...incoming.map((check) => ({ check, side: "incoming" as const })),
  ];
};

/** Every required check needs a passing current-epoch result for its command. */
export const evaluateChecks = (params: {
  readonly task: Task;
  readonly checks: ReadonlyArray<RequiredCheck>;
}): RuleFailure | undefined => {
  const epoch = taskEpoch(params.task);
  const results = (params.task.checkResults ?? []).filter(
    (result) => result.epoch === epoch,
  );
  for (const { check, side } of params.checks) {
    const result = results.find(
      (candidate) => candidate.checkId === check.id && candidate.side === side,
    );
    if (result === undefined) {
      return {
        missing: "checks",
        message: `${side} check "${check.label}" has no result for epoch ${epoch}`,
        next_step: `run tasks check for check ${check.id}`,
      };
    }
    if (result.command !== check.command) {
      return {
        missing: "checks.stale",
        message: `${side} check "${check.label}" is stale because its command changed`,
        next_step: `run tasks check again for check ${check.id}`,
      };
    }
    if (result.exitCode !== 0) {
      return {
        missing: "checks.failed",
        message: `${side} check "${check.label}" failed with exit ${result.exitCode}`,
        next_step: `fix the failure and run tasks check again for check ${check.id}`,
      };
    }
  }
  return undefined;
};

export type TaskAdmissionState =
  | "claimable"
  | "waiting"
  | "approval"
  | "operator";

/** Epoch-scoped operator approval marker. */
export const TASK_APPROVED_METADATA_KEY = "vellum.tasks.approvedEpoch";

export const taskApproved = (task: Task): boolean =>
  task.metadata?.[TASK_APPROVED_METADATA_KEY] === taskEpoch(task);

const ADMISSION_RANK: Readonly<Record<TaskAdmission, 0 | 1 | 2>> = {
  auto: 0,
  approval: 1,
  operator: 2,
};

/** A requester may only tighten the board's admission floor. */
export const clampRequestedAdmission = (input: {
  readonly floor: TaskAdmission;
  readonly requested: TaskAdmission | undefined;
  readonly omitted: "approval" | "inherit";
}):
  | { readonly ok: true; readonly stamp: TaskAdmission | undefined }
  | { readonly ok: false; readonly message: string } => {
  const floor = input.floor;
  if (input.requested !== undefined) {
    if (ADMISSION_RANK[input.requested] < ADMISSION_RANK[floor]) {
      return {
        ok: false,
        message: `admission "${input.requested}" loosens board floor "${floor}"; requester may only tighten`,
      };
    }
    return { ok: true, stamp: input.requested };
  }
  if (input.omitted === "inherit") return { ok: true, stamp: undefined };
  return {
    ok: true,
    stamp: ADMISSION_RANK.approval < ADMISSION_RANK[floor] ? floor : "approval",
  };
};

export const effectiveTaskAdmission = (
  task: Pick<Task, "admission">,
  contract: TasksContract | undefined,
): TaskAdmission => {
  const floor = resolveTaskAdmission(contract);
  const requested = task.admission;
  if (requested === undefined) return floor;
  return ADMISSION_RANK[requested] >= ADMISSION_RANK[floor] ? requested : floor;
};

export const taskAdmissionState = (
  task: Task,
  contract: TasksContract | undefined,
  nowMs: number,
): TaskAdmissionState => {
  const admission = effectiveTaskAdmission(task, contract);
  if (admission === "operator") return "operator";
  if (admission === "approval" && !taskApproved(task)) return "approval";
  const waitUntil = task.waitUntil === undefined ? NaN : Date.parse(task.waitUntil);
  if (Number.isFinite(waitUntil) && waitUntil > nowMs) return "waiting";
  return "claimable";
};

/** Explicit task wait wins over the destination board's default wait. */
export const computeWaitUntil = (
  nowMs: number,
  waitMs: number | undefined,
  waitForMs: number | undefined,
): string | undefined => {
  const delay = waitForMs ?? waitMs;
  if (delay === undefined || delay <= 0) return undefined;
  return new Date(nowMs + Math.min(delay, WAIT_FOR_MAX_MS)).toISOString();
};
