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
//    from receipt mail or task.show); the server validates it against
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
//  - A verdict counts at completion only while its reviewer, a seat distinct
//    from the author, is on the task's reviewer list, so a reviewer taken
//    off the list stops mattering. No edge grants review.
//  - A green verdict clears nothing by itself; the completion gate asks for
//    a qualifying latest green on the exact binding.
//  - Receipt mail is deduped exactly on (canvas, source, ref, reviewer):
//    the same task fact or the same checkout observation can never mail the
//    same reviewer twice for the same ref.

import {
  mailExtensionMetadata,
  type MailEvidenceRef,
  type ReviewVerdict,
} from "@shared/crew";
import { type RuleInForce } from "@shared/rules";
import { makeUserMessage } from "@shared/task";
import type { Message, Task } from "@shared/work-model";
import type { ActorSeatId } from "@shared/actor-seat";
import type { ActorRef } from "@shared/work-reference";
import type { Reviewer } from "@shared/task-model";

// ---------------------------------------------------------------------------
// Subject identity.

const normalizeSha = (sha: string): string => sha.trim().toLowerCase();

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

/** The live agent node one seat currently occupies. */
export const agentNodeForSeat = (
  actorRefs: ReadonlyArray<ActorRef>,
  seatId: ActorSeatId,
): ActorRef | undefined => actorRefs.find((actor) => actor.seatId === seatId);

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
    | "reviewer-removed";
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
 * reviewer is not the author, and that reviewer is still on the task's
 * reviewer list.
 */
export const evaluateReviewGate = (input: {
  readonly rulesInForce: ReadonlyArray<RuleInForce>;
  readonly projection: ReviewSubjectProjection;
  readonly verdicts: ReadonlyArray<ReviewVerdict>;
  readonly authorSeatId: ActorSeatId | undefined;
  readonly reviewerListed: (reviewerSeatId: ActorSeatId) => boolean;
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
        input.reviewerListed(verdict.reviewerSeatId),
      )
    ) {
      return { armed, satisfied: true, unsatisfied: [] };
    }
    reason = qualifying.length === 0 ? "no-qualifying-green" : "reviewer-removed";
  }
  return {
    armed,
    satisfied: false,
    unsatisfied: armed.map(({ ruleId }) => ({ ruleId, reason })),
  };
};

// ---------------------------------------------------------------------------
// Reviewers and receipt feed.

/**
 * The seats on a task's reviewer list, resolved through the live actor refs.
 * The operator is mailed no receipt, and a listed node with no live seat
 * contributes nothing. A seat listed twice (two live nodes of one stable
 * seat) keeps its FIRST entry in list order — downstream mail plans per seat
 * and a duplicate entry would double-send receipts.
 */
export const reviewerSeatsOf = (input: {
  readonly reviewers: ReadonlyArray<Reviewer>;
  readonly actorRefs: ReadonlyArray<ActorRef>;
}): ReadonlyArray<{
  readonly nodeId: string;
  readonly seatId: ActorSeatId;
}> => {
  const out: Array<{ nodeId: string; seatId: ActorSeatId }> = [];
  const seenSeats = new Set<ActorSeatId>();
  for (const reviewer of input.reviewers) {
    if (reviewer.kind !== "seat") continue;
    const seat = input.actorRefs.find((actor) => actor.nodeId === reviewer.seat);
    if (seat === undefined || seenSeats.has(seat.seatId)) continue;
    seenSeats.add(seat.seatId);
    out.push({ nodeId: seat.nodeId, seatId: seat.seatId });
  }
  return out;
};

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
 * from the committed fact's projection. A listed reviewer with no task-read
 * grant on the sink can post against this verbatim —
 * resolveTaskSubject CAS-checks it, and the target sink in the mail body
 * tells them where it lives.
 */
export type ReceiptSubject =
  | {
      readonly kind: "task";
      readonly taskId: string;
      readonly epoch: number;
      readonly subjectHash: string;
    }
  | {
      /**
       * A standalone commit subject observed on a watched checkout. Epoch is
       * always 0 and there is NO task hash: an observed commit may not be any
       * task's staged evidence yet, so the receipt never pretends a task
       * binding — the reviewer posts against {kind:"commit", sha} verbatim.
       */
      readonly kind: "commit";
      readonly sha: string;
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
 * Commit receipts from a watched checkout. One mail per (fresh commit,
 * reviewer): each mail is ONE actionable verdict subject, standalone
 * {kind:"commit", sha} — never a task hash, because an observed commit may
 * not be any task's staged evidence yet. Source is {kind:"checkout",
 * checkoutKey}; dedupe is the shared exact source/ref/reviewer coalesce.
 * The author stamp is server-resolved provenance (first author of the sha),
 * supplied by the caller — never the reviewer's payload.
 */
export const planCheckoutReceiptMail = (input: {
  readonly canvasName: string;
  readonly checkoutKey: string;
  readonly shas: ReadonlyArray<string>;
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
  readonly alreadySent: (dedupeKey: string) => boolean;
  readonly messageId: () => string;
}): ReceiptMailPlan => {
  const source: ReceiptSource = {
    kind: "checkout",
    checkoutKey: input.checkoutKey,
  };
  const shas = [
    ...new Set(
      input.shas.map(normalizeSha).filter((sha) => sha.length > 0),
    ),
  ];
  const mail: ReceiptMail[] = [];
  let coalesced = 0;
  for (const reviewer of input.reviewers) {
    for (const sha of shas) {
      const key = receiptDedupeKey({
        canvasName: input.canvasName,
        source,
        refSha: sha,
        reviewerSeatId: reviewer.seatId,
      });
      if (input.alreadySent(key)) {
        coalesced += 1;
        continue;
      }
      const receiptSubject: ReceiptSubject = { kind: "commit", sha };
      const subject = `receipt: commit ${sha} on ${input.checkoutKey}`;
      const body = [
        `${subject} (observed on checkout ${input.checkoutKey})`,
        `ref: ${sha}`,
        "review: read the commit, then post your verdict against subject {kind:commit, sha} — no task binding is implied",
      ].join("\n");
      const message: Message = makeUserMessage({
        messageId: input.messageId(),
        text: body,
        contextId: input.contextId,
        metadata: {
          ...mailExtensionMetadata({
            mailKind: "receipt",
            subject,
            refs: [{ kind: "commit", sha }],
            fromSeat: input.author.seatId,
            senderGeneration: input.author.generation,
            senderHarness: input.author.harness,
          }),
          reviewSubject: receiptSubject,
        },
      });
      mail.push({
        reviewerSeatId: reviewer.seatId,
        reviewerNodeId: reviewer.nodeId,
        message,
        subject: receiptSubject,
        dedupeKeys: [key],
      });
    }
  }
  return { mail, coalesced };
};
