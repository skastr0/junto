import { TASKS_ENABLED } from "./features";
import type {
  Check,
  CheckSide,
  CompletionEvidence,
  Rule,
  Task,
  TaskAdmission,
  TasksContract,
} from "./work-model";
import { resolveTaskAdmission } from "./work-model";
import type { Placed } from "./model/canvas";
import { asNodeId } from "./model/base";
import { nodeOf, regionName, regionStack, UNNAMED_REGION } from "./model/canvas";
import type { Region, RegionContract } from "./model/region";

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
type RuleFailure = {
  readonly missing: string;
  readonly message: string;
  readonly next_step: string;
  readonly ruleId?: string;
};

export const boardContractOf = (
  canvas: Placed,
  boardId: string,
): TasksContract | undefined => nodeOf(canvas, asNodeId(boardId), "task")?.contract;

/**
 * A rule's region as an agent is told it: the display name, with the node id
 * beside it when the region has no name, since an agent addresses a node by
 * id. The operator's screens show `provenance.label` alone.
 */
export const regionAddress = (provenance: { readonly regionId: string; readonly label: string }): string =>
  provenance.label === UNNAMED_REGION ? `${provenance.label} (id ${provenance.regionId})` : provenance.label;

/**
 * A region's contract (rules and pinned rulings) rides the Tasks gate. With
 * it off, a stored contract still decodes and round-trips untouched, but
 * nothing reads it: no rule stacks onto a board and no ruling reaches a seat.
 */
export const regionContractOf = (
  region: Region,
): RegionContract | undefined => (TASKS_ENABLED ? region.contract : undefined);

/**
 * Rules in force at a board: enclosing regions outer to inner, board rules,
 * then task rules addressed to this board. Authored entries are concatenated;
 * there is no override, precedence, or deduplication.
 */
export const rulesInForce = (
  canvas: Placed,
  boardId: string,
  task?: Task,
): ReadonlyArray<RuleInForce> => {
  const out: RuleInForce[] = [];
  for (const region of regionStack(canvas, asNodeId(boardId))) {
    for (const rule of regionContractOf(region)?.rules ?? []) {
      out.push({
        rule,
        provenance: {
          kind: "region",
          regionId: region.id,
          label: regionName(region),
        },
      });
    }
  }
  for (const rule of boardContractOf(canvas, boardId)?.rules ?? []) {
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
      return `region "${regionAddress(provenance)}"`;
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

export type RequiredCheck = {
  readonly check: Check;
  readonly side: CheckSide;
};

/** Current board outgoing checks followed by the next board incoming checks. */
export const requiredChecks = (
  canvas: Placed,
  fromBoardId: string,
  next: string,
): ReadonlyArray<RequiredCheck> => {
  const outgoing = boardContractOf(canvas, fromBoardId)?.outgoing?.checks ?? [];
  const incoming = boardContractOf(canvas, next)?.incoming?.checks ?? [];
  return [
    ...outgoing.map((check) => ({ check, side: "outgoing" as const })),
    ...incoming.map((check) => ({ check, side: "incoming" as const })),
  ];
};

type TaskAdmissionState =
  | "claimable"
  | "waiting"
  | "approval"
  | "operator";

/** Epoch-scoped operator approval marker. */
export const TASK_APPROVED_METADATA_KEY = "junto.tasks.approvedEpoch";

const taskApproved = (task: Task): boolean =>
  task.metadata?.[TASK_APPROVED_METADATA_KEY] === taskEpoch(task);

const ADMISSION_RANK: Readonly<Record<TaskAdmission, 0 | 1 | 2>> = {
  auto: 0,
  approval: 1,
  operator: 2,
};

const effectiveTaskAdmission = (
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

