/**
 * Operator review projection. Verdicts are immutable facts from p15/p1F;
 * this module only decodes the exported ReviewVerdict and Rule.kind.
 *
 * WorkService tasks.show exposes `reviewSubject` + `verdicts` as siblings
 * of `task`. The same overlay is what p1F must project onto CanvasDoc
 * ether items. `metadata.verdicts` is a legacy fallback only. Bare
 * `task.subjectHash` is not a store.
 */
import { Schema } from "effect";
import type { CanvasDoc } from "@shared/canvas";
import {
  ReviewVerdict as SharedReviewVerdict,
  type MailEvidenceRef,
  type ReviewVerdict as CanonicalReviewVerdict,
  type VerdictKind,
  type VerdictSubject,
} from "@shared/crew";
import type { Rule, Task, TasksContract } from "@shared/work-model";

/** WorkService tasks.show overlay. Also the CanvasDoc item extra keys. */
export type TaskReviewShow = {
  readonly reviewSubject?: unknown;
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

const decodeCanonicalVerdict = Schema.decodeUnknownOption(SharedReviewVerdict);

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;

export const reviewShowOf = (
  source: unknown,
  overlay?: TaskReviewShow,
): TaskReviewShow => {
  const record = recordOf(source);
  return {
    reviewSubject: overlay?.reviewSubject ?? record?.reviewSubject,
    verdicts: overlay?.verdicts ?? record?.verdicts,
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
  const canonical = decodeCanonicalVerdict(value);
  return canonical._tag === "Some" ? viewFromCanonical(canonical.value) : undefined;
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
  overlay?: TaskReviewShow,
): ReadonlyArray<ReviewVerdict> => {
  const show = reviewShowOf(task, overlay);
  if (Array.isArray(show.verdicts)) return parseReviewVerdicts(show.verdicts);
  return parseReviewVerdicts(task.metadata?.verdicts);
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
  overlay?: TaskReviewShow,
): ReviewSubjectProjectionView | undefined =>
  parseReviewSubjectProjection(reviewShowOf(task, overlay).reviewSubject);

export const currentReviewSubjectHash = (
  task: Task,
  overlay?: TaskReviewShow,
): string | undefined => currentReviewSubjectProjection(task, overlay)?.subjectHash;

export const currentReviewSubject = (
  task: Task,
  overlay?: TaskReviewShow,
): ReviewSubject | undefined => {
  const projection = currentReviewSubjectProjection(task, overlay);
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
    readonly show?: TaskReviewShow;
    readonly reviewerHasCurrentEdge?: (reviewerSeatId: string) => boolean;
  },
): ReviewGate => {
  const required = taskRequiresReview(task, contract);
  const projection = currentReviewSubjectProjection(task, options?.show);
  const currentEpoch = projection?.epoch ?? taskEpochOf(task);
  const currentSubject = currentReviewSubject(task, options?.show);
  const currentHash = projection?.subjectHash;
  const chain = verdictsOnTask(task, options?.show);
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
