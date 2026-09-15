import { describe, expect, it } from "vitest";
import type { ActorSeatId } from "../src/shared/actor-seat";
import type { MailEvidenceRef, ReviewVerdict, VerdictSubject } from "../src/shared/crew";
import type { CanvasDoc } from "../src/shared/canvas";
import type { RuleInForce } from "../src/shared/rules";
import type { Task } from "../src/shared/work-model";
import {
  evaluateReviewGate,
  planReceiptMail,
  planVerdictPost,
  resolveTaskSubject,
  reviewersOfAuthor,
  reviewsEdgeExists,
  reviewSubjectHash,
  type ResolvedReviewSubject,
  type ReviewSubjectProjection,
} from "../src/main/vellum-command/work/reviews";

// Independent adversarial seam tests for the review-verdict decision core
// (docs/crew-contract.md): subject resolution, verdict posting, the
// completion gate, reviews-edge lookup, and receipt mail. All pure — the
// work service composes these, so a wrong ruling here is a wrong ruling
// everywhere.

const REVIEWER = "seat-reviewer-1" as ActorSeatId;
const AUTHOR = "seat-author-1" as ActorSeatId;
const OTHER = "seat-other-1" as ActorSeatId;

const projection = (
  over: Partial<ReviewSubjectProjection> = {},
): ReviewSubjectProjection => ({
  installationId: "inst-1",
  canvasName: "c",
  nodeId: "board",
  taskId: "t1",
  state: "working",
  epoch: 2,
  subjectHash: reviewSubjectHash({
    kind: "task",
    installationId: "inst-1",
    canvasName: "c",
    nodeId: "board",
    taskId: "t1",
    epoch: 2,
    commitShas: ["abc123"],
  }),
  refs: [{ kind: "commit", sha: "abc123" }],
  authorSeatId: AUTHOR,
  ...over,
});

const taskSubject = (
  over: Partial<ReviewSubjectProjection> = {},
): ResolvedReviewSubject => ({ kind: "task", projection: projection(over) });

const verdict = (over: Partial<ReviewVerdict> = {}): ReviewVerdict => ({
  verdictId: "v1",
  kind: "green",
  reviewerSeatId: REVIEWER,
  reviewerNodeId: "rev-node",
  authorSeatId: AUTHOR,
  subject: {
    kind: "task",
    installationId: "inst-1",
    canvasName: "c",
    nodeId: "board",
    taskId: "t1",
    epoch: 2,
    subjectHash: projection().subjectHash,
  },
  subjectHash: projection().subjectHash,
  epoch: 2,
  findings: [],
  refs: [],
  postedAtMs: 1000,
  ...over,
});

const armedRule: RuleInForce = {
  rule: { id: "rule-1", text: "needs review", kind: "requires-review" },
  provenance: { kind: "board", boardId: "board" },
};

const gateInput = (
  verdicts: ReadonlyArray<ReviewVerdict>,
  over: {
    projection?: ReviewSubjectProjection;
    authorSeatId?: ActorSeatId | undefined;
    hasEdge?: (seat: ActorSeatId) => boolean;
    rules?: ReadonlyArray<RuleInForce>;
  } = {},
) => ({
  rulesInForce: over.rules ?? [armedRule],
  projection: over.projection ?? projection(),
  verdicts,
  authorSeatId: over.authorSeatId === undefined ? AUTHOR : over.authorSeatId,
  reviewerHasCurrentEdge: over.hasEdge ?? (() => true),
});

describe("resolveTaskSubject — stale binding refusal", () => {
  it("a matching epoch+hash resolves the task subject", () => {
    const p = projection();
    const res = resolveTaskSubject({
      projection: p,
      expected: { epoch: p.epoch, subjectHash: p.subjectHash },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.subject.kind).toBe("task");
    }
  });

  it("a moved epoch refuses stale with expected/received evidence", () => {
    const p = projection();
    const res = resolveTaskSubject({
      projection: p,
      expected: { epoch: p.epoch - 1, subjectHash: p.subjectHash },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.details?.reason).toBe("stale-subject");
      expect(res.error.details?.retryable).toBe(true);
      expect(res.error.details?.expected).toEqual({
        epoch: 1,
        subjectHash: p.subjectHash,
      });
      expect(res.error.details?.received).toEqual({
        epoch: 2,
        subjectHash: p.subjectHash,
      });
    }
  });

  it("a moved subjectHash refuses stale — old green cannot bless new refs", () => {
    const p = projection();
    const res = resolveTaskSubject({
      projection: p,
      expected: { epoch: p.epoch, subjectHash: "deadbeef" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.details?.reason).toBe("stale-subject");
    }
  });
});

describe("planVerdictPost — admission", () => {
  const post = (over: {
    subject?: ResolvedReviewSubject;
    kind?: "green" | "blocking";
    findings?: ReadonlyArray<string>;
    refs?: ReadonlyArray<MailEvidenceRef>;
    edge?: boolean;
    callerSeat?: ActorSeatId;
  }) =>
    planVerdictPost({
      caller: { seatId: over.callerSeat ?? REVIEWER, nodeId: "rev-node" },
      subject: over.subject ?? taskSubject(),
      kind: over.kind ?? "green",
      findings: over.findings ?? [],
      refs: over.refs ?? [],
      reviewsEdgeCurrent: over.edge ?? true,
      verdictId: "v-new",
      postedAtMs: 2000,
    });

  it("no current reviews edge refuses with ScopeError", () => {
    const res = post({ edge: false });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.type).toBe("ScopeError");
      expect(res.error.details?.reason).toBe("reviews-edge-missing");
      expect(res.error.details?.retryable).toBe(false);
    }
  });

  it("the author cannot review their own seat", () => {
    const res = post({ callerSeat: AUTHOR });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.type).toBe("ReviewerIsAuthor");
      expect(res.error.details?.reason).toBe("reviewer-is-author");
    }
  });

  it("an unresolved author is retryable — provenance may arrive later", () => {
    const res = post({
      subject: taskSubject({ authorSeatId: undefined }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.details?.reason).toBe("author-unresolved");
      expect(res.error.details?.retryable).toBe(true);
    }
  });

  it("a blocking verdict with no findings is malformed", () => {
    const res = post({ kind: "blocking", findings: ["   ", ""] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.details?.reason).toBe("malformed-verdict");
    }
  });

  it("blocking on a completed task refuses — completed cannot transition to rejected", () => {
    const res = post({
      kind: "blocking",
      findings: ["broken output"],
      subject: taskSubject({ state: "completed" }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.details?.reason).toBe("subject-settled");
    }
  });

  it("a terminal task refuses even a green verdict", () => {
    const res = post({ subject: taskSubject({ state: "rejected" }) });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.details?.reason).toBe("subject-settled");
    }
  });

  it("green on a completed task is allowed — post-hoc review", () => {
    const res = post({ subject: taskSubject({ state: "completed" }) });
    expect(res.ok).toBe(true);
  });

  it("a commit subject binds epoch 0 and normalizes the sha", () => {
    const res = post({
      subject: { kind: "commit", sha: "  ABCDEF1234  ", authorSeatId: AUTHOR },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.verdict.epoch).toBe(0);
      expect(res.verdict.subject).toEqual({
        kind: "commit",
        sha: "abcdef1234",
        subjectHash: res.verdict.subjectHash,
      });
      expect(res.verdict.subjectHash).toBe(
        reviewSubjectHash({ kind: "commit", sha: "abcdef1234" }),
      );
    }
  });

  it("server-derived identity: reviewer stamp comes from the admitted caller, author from the subject", () => {
    const res = post({});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.verdict.reviewerSeatId).toBe(REVIEWER);
      expect(res.verdict.authorSeatId).toBe(AUTHOR);
      expect(res.verdict.subject.kind).toBe("task");
      if (res.verdict.subject.kind === "task") {
        const s = res.verdict.subject as Extract<VerdictSubject, { kind: "task" }>;
        expect(s.epoch).toBe(2);
        expect(s.subjectHash).toBe(projection().subjectHash);
      }
    }
  });

  it("blocking effect numbers multi-finding summaries and keeps only commit refs", () => {
    const res = post({
      kind: "blocking",
      findings: ["first defect", "second defect"],
      refs: [
        { kind: "commit", sha: "abc123" },
        { kind: "file", path: "src/x.ts" },
      ],
    });
    expect(res.ok).toBe(true);
    if (res.ok && res.effect.kind === "blocking") {
      expect(res.effect.defect.summary).toBe(
        "1. first defect\n2. second defect",
      );
      expect(res.effect.defect.refs).toEqual(["abc123"]);
    } else {
      throw new Error("expected a blocking effect");
    }
  });
});

describe("evaluateReviewGate — completion gating", () => {
  it("no armed requires-review rule is satisfied vacuously", () => {
    const res = evaluateReviewGate(gateInput([], { rules: [] }));
    expect(res.satisfied).toBe(true);
    expect(res.armed).toEqual([]);
  });

  it("a region-provenance review rule does not arm the task gate", () => {
    const res = evaluateReviewGate(
      gateInput([], {
        rules: [
          {
            rule: { id: "r-region", text: "review", kind: "requires-review" },
            provenance: { kind: "region", regionId: "g1", label: "zone" },
          },
        ],
      }),
    );
    expect(res.armed).toEqual([]);
    expect(res.satisfied).toBe(true);
  });

  it("armed with no verdicts is unsatisfied — no-green-current-epoch", () => {
    const res = evaluateReviewGate(gateInput([]));
    expect(res.satisfied).toBe(false);
    expect(res.unsatisfied[0]?.reason).toBe("no-green-current-epoch");
  });

  it("a green on the previous epoch does not satisfy — epoch-bound", () => {
    const res = evaluateReviewGate(
      gateInput([verdict({ epoch: 1, subject: { ...verdict().subject, epoch: 1 } as VerdictSubject })]),
    );
    expect(res.satisfied).toBe(false);
    expect(res.unsatisfied[0]?.reason).toBe("no-green-current-epoch");
  });

  it("a green on the current epoch but stale hash does not satisfy — new refs unblessed", () => {
    const res = evaluateReviewGate(gateInput([verdict({ subjectHash: "stale" })]));
    expect(res.satisfied).toBe(false);
    expect(res.unsatisfied[0]?.reason).toBe("stale-refs");
  });

  it("a current-epoch current-hash green with a live edge satisfies", () => {
    const res = evaluateReviewGate(gateInput([verdict()]));
    expect(res.satisfied).toBe(true);
  });

  it("concurrent green→blocking resolves to the blocking — latest per reviewer wins", () => {
    const res = evaluateReviewGate(
      gateInput([
        verdict({ verdictId: "v-g", kind: "green", postedAtMs: 1000 }),
        verdict({ verdictId: "v-b", kind: "blocking", postedAtMs: 2000 }),
      ]),
    );
    expect(res.satisfied).toBe(false);
    expect(res.unsatisfied[0]?.reason).toBe("no-qualifying-green");
  });

  it("concurrent blocking→green resolves to the green", () => {
    const res = evaluateReviewGate(
      gateInput([
        verdict({ verdictId: "v-b", kind: "blocking", postedAtMs: 1000 }),
        verdict({ verdictId: "v-g", kind: "green", postedAtMs: 2000 }),
      ]),
    );
    expect(res.satisfied).toBe(true);
  });

  it("the author's own green never qualifies even if it exists", () => {
    const res = evaluateReviewGate(
      gateInput([verdict({ reviewerSeatId: AUTHOR })]),
    );
    expect(res.satisfied).toBe(false);
    expect(res.unsatisfied[0]?.reason).toBe("no-qualifying-green");
  });

  it("a qualifying green with a removed reviews edge is edge-removed", () => {
    const res = evaluateReviewGate(
      gateInput([verdict()], { hasEdge: () => false }),
    );
    expect(res.satisfied).toBe(false);
    expect(res.unsatisfied[0]?.reason).toBe("edge-removed");
  });

  it("another seat's green counts even alongside the author's disqualifying green", () => {
    const res = evaluateReviewGate(
      gateInput([
        verdict({ verdictId: "v-a", reviewerSeatId: AUTHOR }),
        verdict({ verdictId: "v-o", reviewerSeatId: OTHER, postedAtMs: 900 }),
      ]),
    );
    expect(res.satisfied).toBe(true);
  });

  // Root ruling: same-ms ties resolve BLOCKING WINS, independent of array
  // order (crew-repository's anyReviewerLatestGreen implements the same law
  // on the durable side).
  it("same-ms blocking and green: the blocking verdict wins the tie", () => {
    const res = evaluateReviewGate(
      gateInput([
        verdict({ verdictId: "v-b", kind: "blocking", postedAtMs: 1000 }),
        verdict({ verdictId: "v-g", kind: "green", postedAtMs: 1000 }),
      ]),
    );
    expect(res.satisfied).toBe(false);
  });

  it("same-ms tie holds regardless of array order — green first still loses", () => {
    const res = evaluateReviewGate(
      gateInput([
        verdict({ verdictId: "v-g", kind: "green", postedAtMs: 1000 }),
        verdict({ verdictId: "v-b", kind: "blocking", postedAtMs: 1000 }),
      ]),
    );
    expect(res.satisfied).toBe(false);
  });
});

describe("reviews edges — effective grant, not raw verb", () => {
  const doc = (mask: ReadonlyArray<string> | undefined): CanvasDoc => ({
    nodes: [
      { id: "rev-node", type: "text", x: 0, y: 0, width: 1, height: 1, text: "r" },
      { id: "auth-node", type: "text", x: 0, y: 0, width: 1, height: 1, text: "a" },
    ],
    edges: [
      {
        id: "e1",
        fromNode: "rev-node",
        toNode: "auth-node",
        ether: {
          verb: "reviews",
          ...(mask === undefined ? {} : { mask: mask as never }),
        },
      },
    ],
  } as unknown as CanvasDoc);

  it("an unmasked reviews edge counts", () => {
    expect(reviewsEdgeExists(doc(undefined), "rev-node", "auth-node")).toBe(true);
  });

  it("a reviews edge masked to zero ports does not count — mask respected", () => {
    const d = doc([]);
    expect(reviewsEdgeExists(d, "rev-node", "auth-node")).toBe(false);
    const reviewers = reviewersOfAuthor({
      doc: d,
      authorNodeId: "auth-node",
      actorRefs: [{ seatId: REVIEWER, canvasName: "c", nodeId: "rev-node" }],
    });
    expect(reviewers).toEqual([]);
  });

  it("a mask naming other ports but not verdict.post does not count", () => {
    const d = doc(["messages"]);
    expect(reviewsEdgeExists(d, "rev-node", "auth-node")).toBe(false);
  });
});

describe("planReceiptMail — the receipt feed", () => {
  const task = {
    id: "t1",
    state: "working",
    history: [
      {
        messageId: "m0",
        role: "user",
        parts: [{ kind: "text", text: "Ship the thing" }],
        contextId: "ctx",
      },
    ],
  } as unknown as Task;

  const plan = (over: { alreadySent?: (k: string) => boolean } = {}) =>
    planReceiptMail({
      canvasName: "c",
      nodeId: "board",
      task,
      refs: [
        { kind: "commit", sha: "abc123" },
        { kind: "commit", sha: "abc123" },
        { kind: "file", path: "src/x.ts" },
      ],
      source: {
        kind: "task-fact",
        eventHome: "inst-1",
        entityHome: "inst-1",
        seq: "7",
      },
      projection: {
        installationId: "inst-1",
        canvasName: "c",
        nodeId: "board",
        taskId: "t1",
        state: "working" as const,
        epoch: 1,
        subjectHash: "hash-t1-e1",
        refs: [{ kind: "commit" as const, sha: "abc123" }],
      },
      reviewers: [
        { nodeId: "rev-node", seatId: REVIEWER },
        { nodeId: "other-node", seatId: OTHER },
      ],
      author: { seatId: AUTHOR, generation: "gen-1", harness: "devin" },
      contextId: "ctx",
      alreadySent: over.alreadySent ?? (() => false),
      messageId: (() => {
        let n = 0;
        return () => `m-${++n}`;
      })(),
    });

  it("one mail per reviewer carrying each fresh commit ref", () => {
    const res = plan();
    expect(res.mail).toHaveLength(2);
    expect(res.coalesced).toBe(0);
    expect(res.mail[0]?.reviewerSeatId).toBe(REVIEWER);
    // Duplicate shas normalize to one ref inside one mail.
    expect(res.mail[0]?.dedupeKeys).toHaveLength(1);
  });

  it("exact (source, ref, reviewer) duplicates coalesce per reviewer", () => {
    const sent = new Set<string>();
    const first = plan({ alreadySent: (k) => sent.has(k) });
    for (const m of first.mail) for (const k of m.dedupeKeys) sent.add(k);
    const second = plan({ alreadySent: (k) => sent.has(k) });
    // Reviewer rows already covered produce no second mail for that reviewer.
    expect(second.mail).toHaveLength(0);
    expect(second.coalesced).toBeGreaterThan(0);
  });

  it.fails(
    "case-variant commit shas bypass the fresh dedupe — the key normalizes " +
      "with normalizeSha but `fresh.some(kept => kept.sha === ref.sha)` " +
      "compares raw text, so 'ABC123'+'abc123' emit two identical dedupe " +
      "keys and 'N commit refs' over-counts",
    () => {
      const res = planReceiptMail({
        canvasName: "c",
        nodeId: "board",
        task,
        refs: [
          { kind: "commit", sha: "ABC123" },
          { kind: "commit", sha: "abc123" },
        ],
        source: {
          kind: "task-fact",
          eventHome: "inst-1",
          entityHome: "inst-1",
          seq: "7",
        },
        projection: {
          installationId: "inst-1",
          canvasName: "c",
          nodeId: "board",
          taskId: "t1",
          state: "working" as const,
          epoch: 1,
          subjectHash: "hash-t1-e1",
          refs: [],
        },
        reviewers: [{ nodeId: "rev-node", seatId: REVIEWER }],
        author: { seatId: AUTHOR, generation: "gen-1", harness: "devin" },
        contextId: "ctx",
        alreadySent: () => false,
        messageId: () => "m-1",
      });
      expect(res.mail[0]?.dedupeKeys).toHaveLength(1);
      expect(new Set(res.mail[0]?.dedupeKeys).size).toBe(1);
    });

  it("receipt mail is deliverable — foreign user-role in the reviewer's mailbox", () => {
    const res = plan();
    for (const m of res.mail) {
      expect(m.message.role).toBe("user");
    }
  });
});
