/**
 * Operator review projection. Verdicts are immutable facts from p15/p1F;
 * this module only decodes the exported ReviewVerdict and Rule.kind.
 */
import { Schema } from "effect";
import {
  ReviewVerdict as SharedReviewVerdict,
  VerdictSubject as SharedVerdictSubject,
  type MailEvidenceRef,
  type ReviewVerdict as CanonicalReviewVerdict,
  type VerdictKind,
  type VerdictSubject,
} from "@shared/crew";
import type { Rule, Task, TasksContract } from "@shared/work-model";

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
const decodeVerdictSubject = Schema.decodeUnknownOption(SharedVerdictSubject);

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
  return verdicts;
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

export const verdictsOnTask = (task: Task): ReadonlyArray<ReviewVerdict> => {
  const fromField = parseReviewVerdicts(
    (task as Task & { readonly verdicts?: unknown }).verdicts,
  );
  if (fromField.length > 0) return fromField;
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

export const currentReviewSubject = (
  task: Task,
): ReviewSubject | undefined => {
  const decoded = decodeVerdictSubject(task.metadata?.reviewSubject);
  return decoded._tag === "Some" ? flattenSubject(decoded.value) : undefined;
};

export const currentReviewSubjectHash = (task: Task): string | undefined =>
  nonempty(task.metadata?.reviewSubjectHash) ??
  currentReviewSubject(task)?.subjectHash;

/**
 * Green must come from a distinct seat on the current epoch and subject hash.
 * No hash, no satisfy — a bare task id is not an identity.
 */
export const reviewGateOf = (
  task: Task,
  contract: TasksContract | undefined,
  authorSeatId: string | undefined,
): ReviewGate => {
  const required = taskRequiresReview(task, contract);
  const currentEpoch = taskEpochOf(task);
  const currentSubject = currentReviewSubject(task);
  const currentHash = currentReviewSubjectHash(task);
  const chain = verdictsOnTask(task);
  const current = chain.filter((verdict) =>
    subjectMatches(verdict, currentEpoch, currentHash),
  );
  const latestGreen = [...current]
    .reverse()
    .find((verdict) => verdict.kind === "green");
  const blocking = [...current]
    .reverse()
    .find((verdict) => verdict.kind === "blocking");
  const satisfied =
    latestGreen !== undefined &&
    (authorSeatId === undefined || latestGreen.reviewerSeatId !== authorSeatId);
  return {
    required,
    currentEpoch,
    currentSubject,
    satisfied,
    blocking,
    latestGreen: satisfied ? latestGreen : undefined,
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
