/**
 * Operator review projection. Verdicts are immutable facts from p15/p1F;
 * this module only decodes the exported ReviewVerdict and Rule.kind.
 *
 * Canvas / loadTaskMap projection is `task.verdicts` + `task.subjectHash`.
 * Those are schema fields on Task, never metadata.reviewSubject,
 * metadata.verdicts, or a WorkTaskShow overlay.
 */
import type { CanvasDoc } from "@shared/canvas";
import {
  readReviewVerdict,
  type MailEvidenceRef,
  type ReviewVerdict as CanonicalReviewVerdict,
  type VerdictKind,
  type VerdictSubject,
} from "@shared/crew";
import type { Rule, Task, TasksContract } from "@shared/work-model";

/** Exact fields the batched task projection must stamp. */
export type TaskReviewProjection = {
  readonly subjectHash?: string;
  readonly verdicts?: unknown;
};

export type ReviewSubjectProjectionView = {
  readonly epoch: number;
  readonly subjectHash: string;
  readonly taskId: string | undefined;
  readonly authorSeatId: string | undefined;
};

export type ReviewVerdictKind = VerdictKind;

export type ReviewSubject =
  | {
      readonly kind: "task";
      readonly taskId: string;
      readonly epoch: number;
      readonly subjectHash: string;
    }
  | { readonly kind: "commit"; readonly sha: string; readonly subjectHash: string };

export type ReviewVerdict = {
  readonly verdictId: string;
  readonly kind: ReviewVerdictKind;
  readonly reviewerSeatId: string;
  readonly reviewerNodeId: string | undefined;
  readonly reviewerLabel: string;
  readonly authorSeatId: string;
  readonly subject: ReviewSubject;
  readonly subjectHash: string;
  readonly epoch: number;
  readonly findings: ReadonlyArray<string>;
  readonly refs: ReadonlyArray<MailEvidenceRef>;
  readonly postedAtMs: number;
};

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;

const canvasTaskReviewOf = (task: Task): TaskReviewProjection => {
  const record = recordOf(task);
  return {
    verdicts: record?.verdicts,
    subjectHash: nonempty(record?.subjectHash),
  };
};

export type ReviewGate = {
  readonly required: boolean;
  readonly currentEpoch: number;
  readonly currentSubject: ReviewSubject | undefined;
  readonly satisfied: boolean;
  readonly blocking: ReviewVerdict | undefined;
  readonly latestGreen: ReviewVerdict | undefined;
};

const nonempty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const flattenSubject = (subject: VerdictSubject): ReviewSubject =>
  subject.kind === "task"
    ? {
        kind: "task",
        taskId: subject.taskId,
        epoch: subject.epoch,
        subjectHash: subject.subjectHash,
      }
    : { kind: "commit", sha: subject.sha, subjectHash: subject.subjectHash };

const viewFromCanonical = (
  verdict: CanonicalReviewVerdict,
): ReviewVerdict => ({
  verdictId: verdict.verdictId,
  kind: verdict.kind,
  reviewerSeatId: verdict.reviewerSeatId,
  reviewerNodeId: verdict.reviewerNodeId,
  reviewerLabel: verdict.reviewerNodeId ?? verdict.reviewerSeatId,
  authorSeatId: verdict.authorSeatId,
  subject: flattenSubject(verdict.subject),
  subjectHash: verdict.subjectHash,
  epoch: verdict.epoch,
  findings: verdict.findings,
  refs: verdict.refs,
  postedAtMs: verdict.postedAtMs,
});

/** Projection only. Compact or guessed shapes are dropped. */
export const parseReviewVerdict = (
  value: unknown,
): ReviewVerdict | undefined => {
  const canonical = readReviewVerdict(value);
  return canonical === undefined ? undefined : viewFromCanonical(canonical);
};

export const parseReviewVerdicts = (
  value: unknown,
): ReadonlyArray<ReviewVerdict> => {
  if (!Array.isArray(value)) return [];
  const verdicts: ReviewVerdict[] = [];
  for (const entry of value) {
    const parsed = parseReviewVerdict(entry);
    if (parsed !== undefined) verdicts.push(parsed);
  }
  return [...verdicts].sort((left, right) => left.postedAtMs - right.postedAtMs);
};

export const isRequiresReviewRule = (rule: Rule): boolean =>
  rule.kind === "requires-review";

export const contractRequiresReview = (
  contract: TasksContract | undefined,
): boolean => (contract?.rules ?? []).some(isRequiresReviewRule);

export const withRequiresReviewRule = (
  rules: ReadonlyArray<Rule>,
  required: boolean,
  mintId: () => string,
): ReadonlyArray<Rule> => {
  if (required) {
    if (rules.some(isRequiresReviewRule)) return rules;
    return [
      ...rules,
      {
        id: mintId(),
        text: "A distinct reviewer must record green on the current epoch.",
        kind: "requires-review",
      },
    ];
  }
  return rules.filter((rule) => !isRequiresReviewRule(rule));
};

export const taskRequiresReview = (
  task: Task,
  contract: TasksContract | undefined,
): boolean => {
  if ((task.rules ?? []).some(isRequiresReviewRule)) return true;
  return contractRequiresReview(contract);
};

export const taskEpochOf = (task: Task): number => task.epoch ?? 0;

export const parseReviewSubjectProjection = (
  value: unknown,
): ReviewSubjectProjectionView | undefined => {
  const record = recordOf(value);
  if (record === undefined) return undefined;
  const subjectHash = nonempty(record.subjectHash);
  const epoch =
    typeof record.epoch === "number" &&
    Number.isInteger(record.epoch) &&
    record.epoch >= 0
      ? record.epoch
      : undefined;
  if (subjectHash === undefined || epoch === undefined) return undefined;
  return {
    epoch,
    subjectHash,
    taskId: nonempty(record.taskId),
    authorSeatId: nonempty(record.authorSeatId),
  };
};

export const verdictsOnTask = (
  task: Task,
): ReadonlyArray<ReviewVerdict> => {
  const canvas = canvasTaskReviewOf(task).verdicts;
  return Array.isArray(canvas) ? parseReviewVerdicts(canvas) : [];
};

const subjectMatches = (
  verdict: ReviewVerdict,
  epoch: number,
  subjectHash: string | undefined,
): boolean => {
  if (verdict.epoch !== epoch) return false;
  if (subjectHash === undefined) return false;
  return verdict.subjectHash === subjectHash;
};

export const currentReviewSubjectProjection = (
  task: Task,
): ReviewSubjectProjectionView | undefined => {
  const subjectHash = canvasTaskReviewOf(task).subjectHash;
  if (subjectHash === undefined) return undefined;
  return {
    epoch: taskEpochOf(task),
    subjectHash,
    taskId: task.id,
    authorSeatId: task.claimedBy,
  };
};

export const currentReviewSubjectHash = (
  task: Task,
): string | undefined => currentReviewSubjectProjection(task)?.subjectHash;

export const currentReviewSubject = (
  task: Task,
): ReviewSubject | undefined => {
  const projection = currentReviewSubjectProjection(task);
  if (projection === undefined) return undefined;
  return {
    kind: "task",
    taskId: projection.taskId ?? task.id,
    epoch: projection.epoch,
    subjectHash: projection.subjectHash,
  };
};

/** Latest verdict per reviewer on one binding. Blocking wins a postedAtMs tie. */
const latestByReviewer = (
  current: ReadonlyArray<ReviewVerdict>,
): ReadonlyMap<string, ReviewVerdict> => {
  const map = new Map<string, ReviewVerdict>();
  for (const verdict of current) {
    const prior = map.get(verdict.reviewerSeatId);
    if (
      prior === undefined ||
      verdict.postedAtMs > prior.postedAtMs ||
      (verdict.postedAtMs === prior.postedAtMs &&
        ((prior.kind === "green" && verdict.kind === "blocking") ||
          (prior.kind === verdict.kind &&
            verdict.verdictId > prior.verdictId)))
    ) {
      map.set(verdict.reviewerSeatId, verdict);
    }
  }
  return map;
};

/** reviews edge holds verdict.post: omitted mask is full compile, [] is none. */
export const reviewsEdgeHoldsVerdictPost = (
  edge: CanvasDoc["edges"][number],
): boolean =>
  edge.ether?.verb === "reviews" &&
  (edge.ether.mask === undefined || edge.ether.mask.includes("verdict.post"));

/**
 * Green must come from a distinct seat on the current epoch and subject hash,
 * and a current reviews edge must still hold verdict.post — same as
 * evaluateReviewGate. No hash, no satisfy.
 */
export const reviewGateOf = (
  task: Task,
  contract: TasksContract | undefined,
  authorSeatId: string | undefined,
  options?: {
    readonly reviewerHasCurrentEdge?: (reviewerSeatId: string) => boolean;
  },
): ReviewGate => {
  const required = taskRequiresReview(task, contract);
  const projection = currentReviewSubjectProjection(task);
  const currentEpoch = projection?.epoch ?? taskEpochOf(task);
  const currentSubject = currentReviewSubject(task);
  const currentHash = projection?.subjectHash;
  const chain = verdictsOnTask(task);
  const current = chain.filter((verdict) =>
    subjectMatches(verdict, currentEpoch, currentHash),
  );
  const latest = latestByReviewer(current);
  const latestGreen = [...latest.values()].find(
    (verdict) =>
      verdict.kind === "green" &&
      (authorSeatId === undefined || verdict.reviewerSeatId !== authorSeatId) &&
      (options?.reviewerHasCurrentEdge === undefined ||
        options.reviewerHasCurrentEdge(verdict.reviewerSeatId)),
  );
  const blocking = [...latest.values()].find(
    (verdict) => verdict.kind === "blocking",
  );
  return {
    required,
    currentEpoch,
    currentSubject,
    satisfied: latestGreen !== undefined,
    blocking,
    latestGreen,
  };
};

export const boardReviewGate = (
  contract: TasksContract | undefined,
): ReviewGate => ({
  required: contractRequiresReview(contract),
  currentEpoch: 0,
  currentSubject: undefined,
  satisfied: false,
  blocking: undefined,
  latestGreen: undefined,
});

export const reviewVerdictLabel = (kind: ReviewVerdictKind): string =>
  kind === "green" ? "green" : "blocking";

export const reviewSubjectLabel = (subject: ReviewSubject): string =>
  subject.kind === "task"
    ? `epoch ${subject.epoch}`
    : subject.sha.length > 12
      ? subject.sha.slice(0, 12)
      : subject.sha;
