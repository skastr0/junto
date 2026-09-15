/**
 * Operator review projection — requires-review authoring and the verdict
 * chain. Verdicts are immutable facts; this module only reads them.
 */
import { Schema } from "effect";
import {
  ReviewVerdict as SharedReviewVerdict,
  type ReviewVerdict as CanonicalReviewVerdict,
  type VerdictSubject,
} from "@shared/crew";
import type { Rule, Task, TasksContract } from "@shared/work-model";
import {
  parseMailEvidenceRefs,
  type MailEvidenceRef,
} from "./crew-mail-view";

export const REVIEW_VERDICT_KINDS = ["green", "blocking"] as const;
export type ReviewVerdictKind = (typeof REVIEW_VERDICT_KINDS)[number];

export type ReviewSubject =
  | { readonly kind: "task"; readonly taskId: string; readonly epoch: number }
  | { readonly kind: "commit"; readonly sha: string };

export type ReviewVerdict = {
  readonly verdictId: string;
  readonly kind: ReviewVerdictKind;
  readonly reviewerSeatId: string;
  readonly reviewerNodeId: string | undefined;
  readonly reviewerLabel: string;
  readonly authorSeatId: string | undefined;
  readonly subject: ReviewSubject;
  readonly subjectHash: string | undefined;
  readonly epoch: number;
  readonly findings: ReadonlyArray<string>;
  readonly refs: ReadonlyArray<MailEvidenceRef>;
  readonly postedAtMs: number | undefined;
};

const decodeCanonicalVerdict = Schema.decodeUnknownOption(SharedReviewVerdict);

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

const finiteInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;

const isVerdictKind = (value: unknown): value is ReviewVerdictKind =>
  value === "green" || value === "blocking";

const flattenSubject = (subject: VerdictSubject): ReviewSubject =>
  subject.kind === "task"
    ? { kind: "task", taskId: subject.task.itemId, epoch: subject.epoch }
    : { kind: "commit", sha: subject.sha };

const parseSubject = (value: unknown): ReviewSubject | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === "task") {
    const nested = record.task;
    const nestedId =
      nested !== null && typeof nested === "object"
        ? nonempty((nested as { readonly itemId?: unknown }).itemId)
        : undefined;
    const taskId = nestedId ?? nonempty(record.taskId);
    const epoch = finiteInt(record.epoch);
    if (taskId === undefined || epoch === undefined || epoch < 0) {
      return undefined;
    }
    return { kind: "task", taskId, epoch };
  }
  if (record.kind === "commit") {
    const sha = nonempty(record.sha);
    return sha === undefined ? undefined : { kind: "commit", sha };
  }
  return undefined;
};

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

const parseFindings = (value: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => nonempty(entry))
    .filter((entry): entry is string => entry !== undefined);
};

export const parseReviewVerdict = (
  value: unknown,
): ReviewVerdict | undefined => {
  const canonical = decodeCanonicalVerdict(value);
  if (canonical._tag === "Some") return viewFromCanonical(canonical.value);
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const verdictId = nonempty(record.verdictId);
  const reviewerSeatId = nonempty(record.reviewerSeatId);
  const subject = parseSubject(record.subject);
  const epoch = finiteInt(record.epoch);
  if (
    verdictId === undefined ||
    !isVerdictKind(record.kind) ||
    reviewerSeatId === undefined ||
    subject === undefined ||
    epoch === undefined ||
    epoch < 0
  ) {
    return undefined;
  }
  return {
    verdictId,
    kind: record.kind,
    reviewerSeatId,
    reviewerNodeId: nonempty(record.reviewerNodeId),
    reviewerLabel: nonempty(record.reviewerLabel) ?? reviewerSeatId,
    authorSeatId: nonempty(record.authorSeatId),
    subject,
    subjectHash: nonempty(record.subjectHash),
    epoch,
    findings: parseFindings(record.findings),
    refs: parseMailEvidenceRefs(record.refs),
    postedAtMs: finiteInt(record.postedAtMs),
  };
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

export const isRequiresReviewRule = (rule: Rule): boolean => {
  if (rule.kind === "requires-review") return true;
  return (
    (rule as Rule & { readonly requiresReview?: unknown }).requiresReview ===
    true
  );
};

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
  if (task.metadata?.requiresReview === true) return true;
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
  subject: ReviewSubject | undefined,
  epoch: number,
  subjectHash: string | undefined,
): boolean => {
  if (verdict.epoch !== epoch) return false;
  if (
    subjectHash !== undefined &&
    verdict.subjectHash !== undefined &&
    verdict.subjectHash !== subjectHash
  ) {
    return false;
  }
  if (subject === undefined) return verdict.subject.kind === "task";
  if (subject.kind === "task") {
    return (
      verdict.subject.kind === "task" &&
      verdict.subject.taskId === subject.taskId &&
      verdict.subject.epoch === subject.epoch
    );
  }
  return (
    verdict.subject.kind === "commit" && verdict.subject.sha === subject.sha
  );
};

export const currentReviewSubject = (
  task: Task,
): ReviewSubject | undefined => {
  const fromMeta = parseSubject(task.metadata?.reviewSubject);
  if (fromMeta !== undefined) return fromMeta;
  return { kind: "task", taskId: task.id, epoch: taskEpochOf(task) };
};

export const currentReviewSubjectHash = (task: Task): string | undefined =>
  nonempty(task.metadata?.reviewSubjectHash);

/**
 * Green must come from a distinct seat on the current epoch and subject.
 * An older green cannot bless newly submitted commit refs. When both sides
 * carry a subject hash, that hash is the binding — not a bare task id.
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
    subjectMatches(verdict, currentSubject, currentEpoch, currentHash),
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
