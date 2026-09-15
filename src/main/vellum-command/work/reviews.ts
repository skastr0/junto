// Review verdicts over the work plane: subject identity, author provenance,
// gate evaluation, and the receipt feed. This module is the decision core;
// the work service owns IO (repository facts, crew store, canvas reads) and
// composes these functions.
//
// Doctrine:
//
//  - Subject identity is server-derived. A task subject binds the full task
//    reference (installation, canvas, board node, task id), the current task
//    epoch, and `subjectHash` over the exact refs under review. A client
//    supplies only its expectation (task id + epoch + subjectHash as read
//    from receipt mail or tasks.show); the server validates it against
//    current state and refuses instead of binding an old judgment to new
//    refs. A commit subject binds a sha; the canonical hash is computed from
//    the lowercase sha.
//  - `subjectHash` inputs come from {@link verdictSubjectHashPayload} so every
//    plane hashes the same algorithm. Only commit SHAs normalize case
//    (git prints hex lowercase); every other reference encoding preserves
//    case exactly — distinct case-sensitive references must never collide
//    into one review subject.
//  - Author provenance comes from durable claim/receipt facts: the seat that
//    claimed the task in the current epoch, or the seat whose receipt first
//    introduced a commit sha. A client assertion never establishes either.
//  - Posting a verdict requires a current directed reviews edge from
//    reviewer to author and distinct stable seats — checked at post and
//    re-checked at completion, so a removed edge stops mattering.
//  - A green verdict clears nothing by itself; the completion gate asks for
//    a qualifying latest green on the exact binding. A blocking verdict is
//    stored and applied (rejected + defect + epoch bump) in one owner
//    transaction with the durable verdict row.
//  - Receipt mail is deduped exactly on (canvas, source, ref, reviewer):
//    the same task fact or the same checkout observation can never mail the
//    same reviewer twice for the same ref.

import type { CanvasDoc } from "@shared/canvas";
import {
  mailExtensionMetadata,
  type MailEvidenceRef,
  type ReviewVerdict,
  type VerdictKind,
  type VerdictSubject,
} from "@shared/crew";
import { taskEpoch, type RuleInForce } from "@shared/rules";
import { canTransitionTaskState, makeUserMessage } from "@shared/task";
import type { CompletionEvidence, Message, Task } from "@shared/work-model";
import type { ActorSeatId } from "@shared/actor-seat";
import type { ActorRef } from "@shared/work-reference";
import type { WorkErrorBody } from "@shared/work-control";
import type { WorkRecordId } from "@shared/work-protocol";
import { subjectHashOf } from "./review-subject-hash";

// ---------------------------------------------------------------------------
// Errors — WorkErrorType plus a machine `details.reason`, never a new type.

export const REVIEW_REASON_REVIEWER_IS_AUTHOR = "reviewer-is-author";
export const REVIEW_REASON_EDGE_MISSING = "reviews-edge-missing";
export const REVIEW_REASON_SUBJECT_NOT_FOUND = "subject-not-found";
export const REVIEW_REASON_STALE_SUBJECT = "stale-subject";
export const REVIEW_REASON_AUTHOR_UNRESOLVED = "author-unresolved";
export const REVIEW_REASON_MALFORMED = "malformed-verdict";
export const REVIEW_REASON_SUBJECT_SETTLED = "subject-settled";

const reviewError = (
  type: WorkErrorBody["type"],
  reason: string,
  message: string,
  details?: WorkErrorBody["details"],
): WorkErrorBody => ({
  type,
  message,
  details: { reason, ...(details ?? {}) },
});

export const reviewerIsAuthorError = (seatId: ActorSeatId): WorkErrorBody =>
  reviewError(
    "ReviewerIsAuthor",
    REVIEW_REASON_REVIEWER_IS_AUTHOR,
    "a verdict requires a reviewer seat distinct from the author seat",
    {
      retryable: false,
      next_step:
        "a different seat with a current reviews edge must post the verdict",
      holder: seatId,
    },
  );

// ---------------------------------------------------------------------------
// Subject identity.

/**
 * The canonical subject hash. One implementation lives in the pure hash
 * module so every plane hashes identical bytes; this alias keeps the
 * reviews vocabulary at the call sites.
 */
export const reviewSubjectHash = subjectHashOf;

const normalizeSha = (sha: string): string => sha.trim().toLowerCase();

/** Commit refs a completion carries, canonicalized (lowercase, deduped). */
export const completionCommitRefs = (
  task: Task,
): ReadonlyArray<MailEvidenceRef> => {
  const commits = task.completionEvidence?.git?.commits ?? [];
  const seen = new Set<string>();
  const refs: MailEvidenceRef[] = [];
  for (const raw of commits) {
    const sha = normalizeSha(raw);
    if (sha.length === 0 || seen.has(sha)) continue;
    seen.add(sha);
    refs.push({ kind: "commit", sha });
  }
  return refs;
};

/**
 * The seat whose work is under review: the current-epoch claimant. Falls
 * back to the open visit's claimant for rows that released the column copy
 * but still live an open visit.
 */
export const reviewAuthorSeat = (task: Task): ActorSeatId | undefined =>
  task.claimedBy ??
  [...(task.visits ?? [])]
    .reverse()
    .find(
      (visit) => visit.epoch === taskEpoch(task) && visit.exit === undefined,
    )?.claimedBy;

/** The review-facing projection of a task's current review subject. */
export type ReviewSubjectProjection = {
  readonly installationId: string;
  readonly canvasName: string;
  readonly nodeId: string;
  readonly taskId: string;
  readonly state: Task["state"];
  readonly epoch: number;
  readonly subjectHash: string;
  readonly refs: ReadonlyArray<MailEvidenceRef>;
  readonly authorSeatId?: ActorSeatId;
};

/**
 * Derive the current review subject of a live task row. The same projection
 * backs verdict posting, the completion gate, tasks.show, receipt mail, and
 * the digest — one derivation, five consumers, no drift.
 */
export const reviewSubjectProjection = (input: {
  readonly installationId: string;
  readonly canvasName: string;
  readonly nodeId: string;
  readonly task: Task;
  /**
   * Evidence this projection hashes instead of the stored row's — the
   * completion gate projects the subject as it will exist once the
   * in-flight completion lands, so a green on those exact refs satisfies
   * it. Everything else (epoch, author) still comes from the live row.
   */
  readonly evidenceOverride?: CompletionEvidence;
}): ReviewSubjectProjection => {
  const { installationId, canvasName, nodeId, task } = input;
  const epoch = taskEpoch(task);
  const authorSeatId = reviewAuthorSeat(task);
  const evidence = input.evidenceOverride ?? task.completionEvidence;
  const commitShas = (evidence?.git?.commits ?? [])
    .map(normalizeSha)
    .filter((sha) => sha.length > 0);
  const artifactRefs = (evidence?.artifacts ?? []).map((artifact) => ({
    nodeId: artifact.nodeId,
    artifactId: artifact.artifactId,
  }));
  const claimRefs = (evidence?.claims ?? []).flatMap((claim) =>
    (claim.refs ?? []).map((ref) => ref.trim()),
  );
  return {
    installationId,
    canvasName,
    nodeId,
    taskId: task.id,
    state: task.state,
    epoch,
    subjectHash: reviewSubjectHash({
      kind: "task",
      installationId,
      canvasName,
      nodeId,
      taskId: task.id,
      epoch,
      commitShas,
      artifactRefs,
      claimRefs,
    }),
    refs: completionCommitRefs(
      input.evidenceOverride !== undefined
        ? { ...task, completionEvidence: input.evidenceOverride }
        : task,
    ),
    ...(authorSeatId !== undefined ? { authorSeatId } : {}),
  };
};

/** The live agent node one seat currently occupies, for edge checks. */
export const agentNodeForSeat = (
  actorRefs: ReadonlyArray<ActorRef>,
  seatId: ActorSeatId,
): ActorRef | undefined => actorRefs.find((actor) => actor.seatId === seatId);

// ---------------------------------------------------------------------------
// Verdict posting.

/** What the caller asserts about a task subject; the server validates it. */
export type VerdictPostInput =
  | {
      readonly kind: "task";
      readonly taskId: string;
      readonly epoch: number;
      readonly subjectHash: string;
    }
  | { readonly kind: "commit"; readonly sha: string };

export type ResolvedReviewSubject =
  | { readonly kind: "task"; readonly projection: ReviewSubjectProjection }
  | {
      readonly kind: "commit";
      readonly sha: string;
      readonly authorSeatId?: ActorSeatId;
    };

export type ResolveTaskSubjectResult =
  | { readonly ok: true; readonly subject: ResolvedReviewSubject }
  | { readonly ok: false; readonly error: WorkErrorBody };

/**
 * Validate a task-subject expectation against its live projection. Never
 * re-binds silently: a moved epoch or refs hash is a stale refusal carrying
 * both values so the caller can re-read and repost.
 */
export const resolveTaskSubject = (input: {
  readonly projection: ReviewSubjectProjection;
  readonly expected: { readonly epoch: number; readonly subjectHash: string };
}): ResolveTaskSubjectResult => {
  const { projection, expected } = input;
  if (
    projection.epoch !== expected.epoch ||
    projection.subjectHash !== expected.subjectHash
  ) {
    return {
      ok: false,
      error: reviewError(
        "InputError",
        REVIEW_REASON_STALE_SUBJECT,
        `review subject moved since it was read — expected epoch ${expected.epoch} hash ${expected.subjectHash.slice(0, 12)}, current epoch ${projection.epoch} hash ${projection.subjectHash.slice(0, 12)}`,
        {
          retryable: true,
          expected: {
            epoch: expected.epoch,
            subjectHash: expected.subjectHash,
          },
          received: {
            epoch: projection.epoch,
            subjectHash: projection.subjectHash,
          },
          next_step:
            "re-read the review subject (msg read or tasks.show) and post again",
        },
      ),
    };
  }
  return { ok: true, subject: { kind: "task", projection } };
};

export type VerdictPostEffect =
  | { readonly kind: "green" }
  | {
      readonly kind: "blocking";
      readonly defect: {
        readonly summary: string;
        readonly refs: ReadonlyArray<string>;
      };
    }
  | {
      /**
       * Stored verdict with no work-side consequence: a blocking verdict on a
       * standalone commit subject (a sha may belong to many tasks, so there
       * is nothing honest to send back; task rejection requires an explicit
       * task subject CAS).
       */
      readonly kind: "none";
    };

export type VerdictPostPlan =
  | {
      readonly ok: true;
      readonly verdict: ReviewVerdict;
      readonly effect: VerdictPostEffect;
    }
  | { readonly ok: false; readonly error: WorkErrorBody };

/**
 * Plan one verdict posting. Pure: the caller supplies the admitted reviewer
 * (process-bound), the resolved current subject, whether a current directed
 * reviews edge reviewer→author exists right now, and the minted id/clock.
 * The returned `effect` tells the service whether the same owner transaction
 * must also run the send-back writers (blocking) or store the verdict alone
 * (green).
 */
export const planVerdictPost = (input: {
  readonly caller: { readonly seatId: ActorSeatId; readonly nodeId: string };
  readonly subject: ResolvedReviewSubject;
  readonly kind: VerdictKind;
  readonly findings: ReadonlyArray<string>;
  readonly refs: ReadonlyArray<MailEvidenceRef>;
  readonly reviewsEdgeCurrent: boolean;
  readonly verdictId: string;
  readonly postedAtMs: number;
}): VerdictPostPlan => {
  const { caller, subject, kind, findings, refs } = input;
  const cleanFindings = findings
    .map((finding) => finding.trim())
    .filter((finding) => finding.length > 0);

  // Author identity first (root ruling): self-review refuses as
  // ReviewerIsAuthor even when the reviewer also lacks an edge — the self-
  // review is the more specific defect, and an author must never be told to
  // ask for an edge to themselves. An unresolved author precedes both: the
  // self-review question is unanswerable without one. The p15 writer re-check
  // mirrors this exact precedence after a live claim flip.
  const authorSeatId =
    subject.kind === "task"
      ? subject.projection.authorSeatId
      : subject.authorSeatId;
  if (authorSeatId === undefined) {
    return {
      ok: false,
      error: reviewError(
        "InputError",
        REVIEW_REASON_AUTHOR_UNRESOLVED,
        "the review subject has no author provenance yet — no current-epoch claim or receipt names an author seat",
        {
          retryable: true,
          next_step:
            "post the verdict after the author claims the task or a receipt carries the ref",
        },
      ),
    };
  }
  if (authorSeatId === caller.seatId) {
    return { ok: false, error: reviewerIsAuthorError(caller.seatId) };
  }
  if (!input.reviewsEdgeCurrent) {
    return {
      ok: false,
      error: reviewError(
        "ScopeError",
        REVIEW_REASON_EDGE_MISSING,
        "no current reviews edge from your seat to the author seat",
        {
          retryable: false,
          next_step:
            "ask the operator to draw a reviews edge from your seat to the author",
        },
      ),
    };
  }
  if (kind === "blocking" && cleanFindings.length === 0) {
    return {
      ok: false,
      error: reviewError(
        "InputError",
        REVIEW_REASON_MALFORMED,
        "a blocking verdict requires at least one finding",
        {
          retryable: false,
          next_step: "supply findings describing the defect",
        },
      ),
    };
  }

  let epoch: number;
  let subjectHash: string;
  let subjectRef: VerdictSubject;
  if (subject.kind === "task") {
    const { projection } = subject;
    if (
      projection.state !== "working" &&
      projection.state !== "submitted" &&
      projection.state !== "input-required" &&
      projection.state !== "completed"
    ) {
      return {
        ok: false,
        error: reviewError(
          "InputError",
          REVIEW_REASON_SUBJECT_SETTLED,
          `task "${projection.taskId}" is ${projection.state} — no live review subject remains`,
          { retryable: false },
        ),
      };
    }
    if (
      kind === "blocking" &&
      !canTransitionTaskState(projection.state, "rejected")
    ) {
      return {
        ok: false,
        error: reviewError(
          "InputError",
          REVIEW_REASON_SUBJECT_SETTLED,
          `task "${projection.taskId}" cannot be sent back from ${projection.state}`,
          {
            retryable: false,
            next_step:
              "the task left the working state; re-read tasks.show for the current subject",
          },
        ),
      };
    }
    epoch = projection.epoch;
    subjectHash = projection.subjectHash;
    subjectRef = {
      kind: "task",
      installationId: projection.installationId,
      canvasName: projection.canvasName,
      nodeId: projection.nodeId,
      taskId: projection.taskId,
      epoch: projection.epoch,
      subjectHash,
    };
  } else {
    epoch = 0;
    const sha = normalizeSha(subject.sha);
    subjectHash = reviewSubjectHash({ kind: "commit", sha });
    subjectRef = { kind: "commit", sha, subjectHash };
  }

  const verdict: ReviewVerdict = {
    verdictId: input.verdictId,
    kind,
    reviewerSeatId: caller.seatId,
    reviewerNodeId: caller.nodeId,
    authorSeatId,
    subject: subjectRef,
    subjectHash,
    epoch,
    findings: cleanFindings,
    refs: refs.slice(),
    postedAtMs: input.postedAtMs,
  };

  if (kind === "green") {
    return { ok: true, verdict, effect: { kind: "green" } };
  }
  if (subject.kind === "commit") {
    return { ok: true, verdict, effect: { kind: "none" } };
  }
  return {
    ok: true,
    verdict,
    effect: {
      kind: "blocking",
      defect: {
        summary:
          cleanFindings.length === 1
            ? cleanFindings[0]!
            : cleanFindings
                .map((finding, index) => `${index + 1}. ${finding}`)
                .join("\n"),
        refs: refs
          .map((ref) => (ref.kind === "commit" ? ref.sha : undefined))
          .filter((sha): sha is string => sha !== undefined),
      },
    },
  };
};

// ---------------------------------------------------------------------------
// Completion gate.

export type ReviewGateRule = {
  readonly ruleId: string;
  readonly text: string;
};

export type ReviewGateUnsatisfied = {
  readonly ruleId: string;
  readonly reason:
    | "no-green-current-epoch"
    | "stale-refs"
    | "no-qualifying-green"
    | "edge-removed";
};

export type ReviewGateResult = {
  /** requires-review rules in force with board or task provenance. */
  readonly armed: ReadonlyArray<ReviewGateRule>;
  /** True when nothing is armed, or a qualifying green exists. */
  readonly satisfied: boolean;
  readonly unsatisfied: ReadonlyArray<ReviewGateUnsatisfied>;
};

/**
 * The gate: a requires-review rule arms completion on a distinct reviewer's
 * green verdict. A green qualifies only when it is that reviewer's LATEST
 * verdict on the exact binding (current epoch + current subjectHash), the
 * reviewer is not the author, and a current directed reviews edge still
 * runs from that reviewer to the author.
 */
export const evaluateReviewGate = (input: {
  readonly rulesInForce: ReadonlyArray<RuleInForce>;
  readonly projection: ReviewSubjectProjection;
  readonly verdicts: ReadonlyArray<ReviewVerdict>;
  readonly authorSeatId: ActorSeatId | undefined;
  readonly reviewerHasCurrentEdge: (reviewerSeatId: ActorSeatId) => boolean;
}): ReviewGateResult => {
  const armed: ReadonlyArray<ReviewGateRule> = input.rulesInForce
    .filter(
      ({ rule, provenance }) =>
        rule.kind === "requires-review" && provenance.kind !== "region",
    )
    .map(({ rule }) => ({ ruleId: rule.id, text: rule.text }));
  if (armed.length === 0) {
    return { armed, satisfied: true, unsatisfied: [] };
  }

  const matchesEpoch = input.verdicts.filter(
    (verdict) =>
      verdict.subject.kind === "task" &&
      verdict.subject.taskId === input.projection.taskId &&
      verdict.epoch === input.projection.epoch,
  );
  const matchesBinding = matchesEpoch.filter(
    (verdict) => verdict.subjectHash === input.projection.subjectHash,
  );

  let reason: ReviewGateUnsatisfied["reason"];
  if (matchesEpoch.length === 0) {
    reason = "no-green-current-epoch";
  } else if (matchesBinding.length === 0) {
    reason = "stale-refs";
  } else {
    // Latest verdict per reviewer on the exact binding wins.
    const latestByReviewer = new Map<ActorSeatId, ReviewVerdict>();
    for (const verdict of matchesBinding) {
      const prior = latestByReviewer.get(verdict.reviewerSeatId);
      // Same reviewer, exact-subject tie on postedAtMs: BLOCKING WINS,
      // independent of array order; verdictId breaks ties only within one kind.
      if (
        prior === undefined ||
        verdict.postedAtMs > prior.postedAtMs ||
        (verdict.postedAtMs === prior.postedAtMs &&
          ((prior.kind === "green" && verdict.kind === "blocking") ||
            (prior.kind === verdict.kind &&
              verdict.verdictId > prior.verdictId)))
      ) {
        latestByReviewer.set(verdict.reviewerSeatId, verdict);
      }
    }
    const qualifying = [...latestByReviewer.values()].filter(
      (verdict) =>
        verdict.kind === "green" &&
        (input.authorSeatId === undefined ||
          verdict.reviewerSeatId !== input.authorSeatId),
    );
    if (
      qualifying.some((verdict) =>
        input.reviewerHasCurrentEdge(verdict.reviewerSeatId),
      )
    ) {
      return { armed, satisfied: true, unsatisfied: [] };
    }
    reason = qualifying.length === 0 ? "no-qualifying-green" : "edge-removed";
  }
  return {
    armed,
    satisfied: false,
    unsatisfied: armed.map(({ ruleId }) => ({ ruleId, reason })),
  };
};

// ---------------------------------------------------------------------------
// Reviews edges and receipt feed.

/**
 * A reviews edge counts only while it holds a live `verdict.post` grant:
 * the verb is authored `reviews`, and the operator mask (when present)
 * still names the port. Missing mask is the full compiled grant; an empty
 * mask is no grant at all.
 */
const edgeHoldsVerdictPost = (
  edge: CanvasDoc["edges"][number],
): boolean =>
  edge.ether?.verb === "reviews" &&
  (edge.ether.mask === undefined || edge.ether.mask.includes("verdict.post"));

/**
 * Reviewers currently holding a `verdict.post` grant toward `authorNodeId`:
 * edge source is the reviewer, target the author (the edge is directed).
 * Seats resolve through the live actor refs; an edge whose reviewer node
 * has no live seat contributes nothing.
 */
export const reviewersOfAuthor = (input: {
  readonly doc: CanvasDoc;
  readonly authorNodeId: string;
  readonly actorRefs: ReadonlyArray<ActorRef>;
}): ReadonlyArray<{
  readonly nodeId: string;
  readonly seatId: ActorSeatId;
}> => {
  const { doc, authorNodeId, actorRefs } = input;
  const out: Array<{ nodeId: string; seatId: ActorSeatId }> = [];
  for (const edge of doc.edges) {
    if (!edgeHoldsVerdictPost(edge) || edge.toNode !== authorNodeId) continue;
    const seat = actorRefs.find((actor) => actor.nodeId === edge.fromNode);
    if (seat === undefined) continue;
    out.push({ nodeId: edge.fromNode, seatId: seat.seatId });
  }
  return out;
};

/**
 * True when a current directed reviews edge runs reviewer → author and still
 * holds `verdict.post` (mask respected). This mirrors the physics admission
 * for the same grant; the kernel is authoritative, this recheck keeps
 * service-level calls honest when they did not pass through it.
 */
export const reviewsEdgeExists = (
  doc: CanvasDoc,
  reviewerNodeId: string,
  authorNodeId: string,
): boolean =>
  doc.edges.some(
    (edge) =>
      edgeHoldsVerdictPost(edge) &&
      edge.fromNode === reviewerNodeId &&
      edge.toNode === authorNodeId,
  );

/**
 * Durable source identity a receipt mail is deduped against. A task-fact
 * source is the committed WorkRecord id verbatim — event home, entity home,
 * logical sequence (a string; never a parsed number) — so route aliases can
 * never collide or split one fact into two sources.
 */
export type ReceiptSource =
  | {
      readonly kind: "task-fact";
      readonly eventHome: string;
      readonly entityHome: string;
      readonly seq: string;
    }
  | { readonly kind: "checkout"; readonly checkoutKey: string };

/** The only spelling of a task-fact source: read it off the record itself. */
export const receiptSourceForRecord = (record: {
  readonly id: WorkRecordId;
}): ReceiptSource => ({
  kind: "task-fact",
  eventHome: record.id.route.eventHome,
  entityHome: record.id.route.entityHome,
  seq: record.id.seq,
});

/**
 * The serialized source identity stored in ReviewReceiptInput.sourceId.
 * receiptDedupeKey builds on this, so the dedupe key and the persisted
 * source can never drift apart.
 */
export const receiptSourceId = (source: ReceiptSource): string =>
  source.kind === "task-fact"
    ? `${source.eventHome}/${source.entityHome}/${source.seq}`
    : source.checkoutKey;

export const receiptDedupeKey = (input: {
  readonly canvasName: string;
  readonly source: ReceiptSource;
  readonly refSha: string;
  readonly reviewerSeatId: ActorSeatId;
}): string => {
  const sourceId = receiptSourceId(input.source);
  return [
    input.canvasName,
    input.source.kind,
    sourceId,
    normalizeSha(input.refSha),
    input.reviewerSeatId,
  ].join("|");
};

/**
 * The exact verdict subject a receipt hands the reviewer, server-derived
 * from the committed fact's projection. A reviewer holding only a reviews
 * edge (no task-read grant on the sink) can post against this verbatim —
 * resolveTaskSubject CAS-checks it, and the target sink in the mail body
 * tells them where it lives.
 */
export type ReceiptSubject = {
  readonly kind: "task";
  readonly taskId: string;
  readonly epoch: number;
  readonly subjectHash: string;
};

export type ReceiptMail = {
  readonly reviewerSeatId: ActorSeatId;
  readonly reviewerNodeId: string;
  readonly message: Message;
  /** Server-derived CAS subject the reviewer can post against verbatim. */
  readonly subject: ReceiptSubject;
  /** One key per (source, ref, reviewer) this mail covers. */
  readonly dedupeKeys: ReadonlyArray<string>;
};

export type ReceiptMailPlan = {
  readonly mail: ReadonlyArray<ReceiptMail>;
  /** Observations suppressed because an exact (source, ref, reviewer) row exists. */
  readonly coalesced: number;
};

/**
 * Compose receipt mail to the author's current reviewers for refs that
 * arrived on one durable source. One mail per reviewer carrying every still-
 * fresh ref; exact (source, ref, reviewer) duplicates coalesce. The sender
 * stamp is the author's seat — supplied by the service from the author's
 * admitted context, never claimed in the payload.
 */
export const planReceiptMail = (input: {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly task: Task;
  readonly refs: ReadonlyArray<MailEvidenceRef>;
  readonly source: ReceiptSource;
  readonly reviewers: ReadonlyArray<{
    readonly nodeId: string;
    readonly seatId: ActorSeatId;
  }>;
  readonly author: {
    readonly seatId: ActorSeatId;
    readonly generation: string;
    readonly harness: string;
  };
  readonly contextId: string;
  /**
   * Server-derived projection of the committed fact's task — the ONLY
   * source of the subject CAS handed to the reviewer (root: no task-read
   * grant widening; the receipt itself carries epoch + subjectHash + the
   * target sink so a reviews-edge-only reviewer can post verbatim).
   */
  readonly projection: ReviewSubjectProjection;
  readonly alreadySent: (dedupeKey: string) => boolean;
  readonly messageId: () => string;
}): ReceiptMailPlan => {
  const commitRefs = input.refs.filter(
    (ref): ref is Extract<MailEvidenceRef, { kind: "commit" }> =>
      ref.kind === "commit",
  );
  const mail: ReceiptMail[] = [];
  let coalesced = 0;
  for (const reviewer of input.reviewers) {
    const fresh: typeof commitRefs = [];
    for (const ref of commitRefs) {
      const key = receiptDedupeKey({
        canvasName: input.canvasName,
        source: input.source,
        refSha: ref.sha,
        reviewerSeatId: reviewer.seatId,
      });
      if (input.alreadySent(key)) {
        coalesced += 1;
      } else if (!fresh.some((kept) => kept.sha === ref.sha)) {
        fresh.push(ref);
      }
    }
    if (fresh.length === 0) continue;
    const title =
      input.task.history[0]?.parts
        .filter((part) => part.kind === "text")
        .map((part) => ("text" in part ? part.text : ""))
        .join(" ")
        .trim() || input.task.id;
    const subject = `receipt: ${title} — ${fresh.length} commit ref${fresh.length === 1 ? "" : "s"}`;
    // Actionable verbatim: exact CAS subject plus the target sink, derived
    // from the committed fact's projection — never guessed from a sha (a
    // commit may belong to many tasks).
    const receiptSubject: ReceiptSubject = {
      kind: "task",
      taskId: input.projection.taskId,
      epoch: input.projection.epoch,
      subjectHash: input.projection.subjectHash,
    };
    const body = [
      `${subject} (task ${input.projection.taskId} at ${input.projection.nodeId}, epoch ${input.projection.epoch})`,
      ...fresh.map((ref) => `ref: ${ref.sha}`),
      `subject: ${input.projection.subjectHash}`,
      `review: read the refs, then post your verdict against this subject at ${input.projection.nodeId}`,
    ].join("\n");
    const refs: ReadonlyArray<MailEvidenceRef> = [
      { kind: "task", taskId: input.task.id },
      ...fresh,
    ];
    // Foreign arrival in the reviewer's mailbox: user-role with the author's
    // seat stamp in metadata (server-attributed by the caller, never claimed
    // by any sender payload).
    const message: Message = makeUserMessage({
      messageId: input.messageId(),
      text: body,
      contextId: input.contextId,
      taskId: input.task.id,
      metadata: {
        ...mailExtensionMetadata({
          mailKind: "receipt",
          subject,
          refs,
          fromSeat: input.author.seatId,
          senderGeneration: input.author.generation,
          senderHarness: input.author.harness,
        }),
        reviewSubject: receiptSubject,
        referenceTaskIds: [input.task.id],
      },
    });
    mail.push({
      reviewerSeatId: reviewer.seatId,
      reviewerNodeId: reviewer.nodeId,
      message,
      subject: receiptSubject,
      dedupeKeys: fresh.map((ref) =>
        receiptDedupeKey({
          canvasName: input.canvasName,
          source: input.source,
          refSha: ref.sha,
          reviewerSeatId: reviewer.seatId,
        }),
      ),
    });
  }
  return { mail, coalesced };
};
