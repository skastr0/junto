import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import type { ReviewVerdict } from "../src/shared/crew";
import { InstallationId } from "../src/shared/installation-id";
import { LogicalSequence } from "../src/shared/work-protocol";
import { Port } from "../src/shared/physics/schema";
import {
  evaluateReviewGate,
  planCheckoutReceiptMail,
  planReceiptMail,
  planVerdictPost,
  receiptDedupeKey,
  receiptSourceForRecord,
  receiptSourceId,
  resolveTaskSubject,
  reviewSubjectProjection,
  reviewersOfAuthor,
  reviewsEdgeExists,
  REVIEW_REASON_AUTHOR_UNRESOLVED,
  REVIEW_REASON_EDGE_MISSING,
  REVIEW_REASON_MALFORMED,
  REVIEW_REASON_STALE_SUBJECT,
} from "../src/main/junto/work/reviews";
import {
  workTaskClaim,
  workTaskCreate,
  workTaskTransition,
} from "../src/shared/work";
import type { CanvasDoc } from "../src/shared/canvas";
import type { RuleInForce } from "../src/shared/rules";
import type { Rule } from "../src/shared/work-model";
import { ActorRef } from "../src/shared/work-protocol";
import type { ActorSeatId } from "../src/shared/actor-seat";

// Durable review identity: CAS-bound task subjects (epoch + subjectHash over
// ALL typed refs), mask-aware directed verdict.post grants, the completion
// gate's latest-per-reviewer rule (same-ms blocking wins), and the receipt
// feed's exact source/ref dedupe.

const ids = (() => {
  let n = 0;
  return {
    id: () => `id-${++n}`,
    messageId: () => `msg-${++n}`,
  };
})();

const AUTHOR = `seat_${"a".repeat(64)}` as ActorSeatId;
const REVIEWER = `seat_${"b".repeat(64)}` as ActorSeatId;

const actorRefOf = (seatId: string, nodeId: string, canvasName = "alpha") =>
  Schema.decodeUnknownSync(ActorRef)({ seatId, canvasName, nodeId });

const taskNode = (id = "s1"): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: "tasks",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: { entity: { kind: "task" } },
});

const agentNode = (id: string): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: { entity: { kind: "agent", name: `local:${id}` } },
});

type PortName = typeof Port.Type;

const reviewsEdge = (
  fromNode: string,
  toNode: string,
  mask?: ReadonlyArray<PortName>,
): CanvasDoc["edges"][number] => ({
  id: `edge-${fromNode}-${toNode}`,
  fromNode,
  toNode,
  ether: { verb: "reviews", ...(mask !== undefined ? { mask: [...mask] } : {}) },
});

/** A claimed, working task with staged evidence, fresh from the pure transforms. */
const workingTask = (evidence?: {
  commits?: ReadonlyArray<string>;
  artifacts?: ReadonlyArray<{ nodeId: string; artifactId: string }>;
  claimRefs?: ReadonlyArray<string>;
}) => {
  const doc: CanvasDoc = { nodes: [taskNode("s1")], edges: [] };
  const created = workTaskCreate(doc, "alpha", "s1", "paint fence", { details: "paint it" }, ids);
  const claimed = workTaskClaim(created.doc, "alpha", "s1", created.task.id, actorRefOf(AUTHOR, "author-node"), ids);
  const working = workTaskTransition(
    claimed.doc,
    "alpha",
    "s1",
    created.task.id,
    "working",
    undefined,
    ids,
    evidence === undefined
      ? undefined
      : {
          artifacts: [...(evidence.artifacts ?? [])],
          ...(evidence.commits !== undefined
            ? { git: { commits: [...evidence.commits] } }
            : {}),
          ...(evidence.claimRefs !== undefined
            ? {
                claims: [
                  { ruleId: "rule-1", text: "done", refs: [...evidence.claimRefs] },
                ],
              }
            : {}),
        },
    { nowMs: Date.parse("2026-09-12T12:00:00.000Z") },
  );
  return working.task;
};

const projectionOf = (task: ReturnType<typeof workingTask>, evidenceOverride?: Parameters<typeof reviewSubjectProjection>[0]["evidenceOverride"]) =>
  reviewSubjectProjection({
    installationId: "inst-1",
    canvasName: "alpha",
    nodeId: "s1",
    task,
    ...(evidenceOverride !== undefined ? { evidenceOverride } : {}),
  });

describe("review subject projection — hash covers every typed ref", () => {
  // One task per comparison, evidence ONLY through the override, so the
  // hash difference (if any) is attributable to the ref alone.
  type EvidenceSpec = {
    commits?: ReadonlyArray<string>;
    artifacts?: ReadonlyArray<{ nodeId: string; artifactId: string }>;
    claimRefs?: ReadonlyArray<string>;
  };
  const overrideFor = (evidence: EvidenceSpec) => ({
    artifacts: [...(evidence.artifacts ?? [])],
    ...(evidence.commits !== undefined
      ? { git: { commits: [...evidence.commits] } }
      : {}),
    ...(evidence.claimRefs !== undefined
      ? {
          claims: [
            { ruleId: "rule-1", text: "done", refs: [...evidence.claimRefs] },
          ],
        }
      : {}),
  });
  const hashesOf = (...specs: ReadonlyArray<EvidenceSpec>): Array<string> => {
    const task = workingTask();
    return specs.map(
      (spec) => projectionOf(task, overrideFor(spec)).subjectHash,
    );
  };

  it("commit shas fold case; nothing else does", () => {
    const [lower, upper] = hashesOf(
      { commits: ["sha-abc"] },
      { commits: ["SHA-ABC"] },
    );
    expect(lower).toBe(upper);
  });

  it("claim refs differing only in case are DIFFERENT subjects (collision regression)", () => {
    const [lower, upper] = hashesOf(
      { claimRefs: ["src/File.ts"] },
      { claimRefs: ["src/file.ts"] },
    );
    expect(lower).not.toBe(upper);
  });

  it("artifact ids differing only in case are DIFFERENT subjects", () => {
    const [lower, upper] = hashesOf(
      { artifacts: [{ nodeId: "s1", artifactId: "plan-A" }] },
      { artifacts: [{ nodeId: "s1", artifactId: "plan-a" }] },
    );
    expect(lower).not.toBe(upper);
  });

  it("a claim ref cannot alias a commit sha in the payload slots", () => {
    const [asClaim, asCommit] = hashesOf(
      { claimRefs: ["abc123"] },
      { commits: ["abc123"] },
    );
    expect(asClaim).not.toBe(asCommit);
  });

  it("the prospective-evidence override changes the subject the gate compares", () => {
    const task = workingTask({ commits: ["sha-1"] });
    const current = projectionOf(task);
    const prospective = projectionOf(task, {
      artifacts: [],
      git: { commits: ["sha-1", "sha-2"] },
    });
    expect(prospective.subjectHash).not.toBe(current.subjectHash);
    expect(prospective.epoch).toBe(current.epoch);
  });
});

describe("resolveTaskSubject — CAS, never re-bind", () => {
  it("exact match resolves to the projection", () => {
    const task = workingTask({ commits: ["sha-1"] });
    const projection = projectionOf(task);
    const resolved = resolveTaskSubject({
      projection,
      expected: { epoch: projection.epoch, subjectHash: projection.subjectHash },
    });
    expect(resolved.ok).toBe(true);
  });

  it("moved epoch or refs is a retryable stale-subject InputError carrying both sides", () => {
    const task = workingTask({ commits: ["sha-1"] });
    const projection = projectionOf(task);
    const stale = resolveTaskSubject({
      projection,
      expected: { epoch: projection.epoch + 1, subjectHash: projection.subjectHash },
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.type).toBe("InputError");
    expect(stale.error.details?.reason).toBe(REVIEW_REASON_STALE_SUBJECT);
    expect(stale.error.details?.retryable).toBe(true);
  });
});

describe("planVerdictPost — admission order", () => {
  const base = () => {
    const task = workingTask({ commits: ["sha-1"] });
    const projection = projectionOf(task);
    return { task, projection };
  };

  it("no current reviews edge -> ScopeError reviews-edge-missing", () => {
    const { projection } = base();
    const planned = planVerdictPost({
      caller: { seatId: REVIEWER, nodeId: "reviewer-node" },
      subject: { kind: "task", projection },
      kind: "green",
      findings: [],
      refs: [],
      reviewsEdgeCurrent: false,
      verdictId: "v-1",
      postedAtMs: 1,
    });
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.error.type).toBe("ScopeError");
    expect(planned.error.details?.reason).toBe(REVIEW_REASON_EDGE_MISSING);
    expect(planned.error.details?.retryable).toBe(false);
  });

  it("a task with no current-epoch claimant -> retryable author-unresolved", () => {
    const doc: CanvasDoc = { nodes: [taskNode("s1")], edges: [] };
    const created = workTaskCreate(doc, "alpha", "s1", "paint fence", { details: "x" }, ids);
    const projection = projectionOf(created.task);
    const planned = planVerdictPost({
      caller: { seatId: REVIEWER, nodeId: "reviewer-node" },
      subject: { kind: "task", projection },
      kind: "green",
      findings: [],
      refs: [],
      reviewsEdgeCurrent: true,
      verdictId: "v-1",
      postedAtMs: 1,
    });
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.error.details?.reason).toBe(REVIEW_REASON_AUTHOR_UNRESOLVED);
    expect(planned.error.details?.retryable).toBe(true);
  });

  it("the author cannot review their own work -> ReviewerIsAuthor", () => {
    const { projection } = base();
    const planned = planVerdictPost({
      caller: { seatId: AUTHOR, nodeId: "author-node" },
      subject: { kind: "task", projection },
      kind: "green",
      findings: [],
      refs: [],
      reviewsEdgeCurrent: true,
      verdictId: "v-1",
      postedAtMs: 1,
    });
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.error.type).toBe("ReviewerIsAuthor");
    expect(planned.error.details?.retryable).toBe(false);
  });

  it("self-review refusal precedes the edge check (root precedence ruling)", () => {
    const { projection } = base();
    const planned = planVerdictPost({
      caller: { seatId: AUTHOR, nodeId: "author-node" },
      subject: { kind: "task", projection },
      kind: "green",
      findings: [],
      refs: [],
      reviewsEdgeCurrent: false,
      verdictId: "v-1",
      postedAtMs: 1,
    });
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.error.type).toBe("ReviewerIsAuthor");
  });

  it("a blocking verdict without findings -> malformed-verdict, retryable false", () => {
    const { projection } = base();
    const planned = planVerdictPost({
      caller: { seatId: REVIEWER, nodeId: "reviewer-node" },
      subject: { kind: "task", projection },
      kind: "blocking",
      findings: ["   "],
      refs: [],
      reviewsEdgeCurrent: true,
      verdictId: "v-1",
      postedAtMs: 1,
    });
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.error.details?.reason).toBe(REVIEW_REASON_MALFORMED);
    expect(planned.error.details?.retryable).toBe(false);
  });

  it("green binds projection epoch/hash and derives the author seat", () => {
    const { projection } = base();
    const planned = planVerdictPost({
      caller: { seatId: REVIEWER, nodeId: "reviewer-node" },
      subject: { kind: "task", projection },
      kind: "green",
      findings: ["  looks right  "],
      refs: [{ kind: "commit", sha: "sha-1" }],
      reviewsEdgeCurrent: true,
      verdictId: "v-9",
      postedAtMs: 42,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.effect).toEqual({ kind: "green" });
    expect(planned.verdict).toMatchObject({
      verdictId: "v-9",
      kind: "green",
      reviewerSeatId: REVIEWER,
      authorSeatId: AUTHOR,
      epoch: projection.epoch,
      subjectHash: projection.subjectHash,
      findings: ["looks right"],
      postedAtMs: 42,
    });
    expect(planned.verdict.subject).toMatchObject({
      kind: "task",
      taskId: projection.taskId,
      epoch: projection.epoch,
      subjectHash: projection.subjectHash,
    });
  });

  it("blocking on a task yields the send-back defect (single finding verbatim)", () => {
    const { projection } = base();
    const planned = planVerdictPost({
      caller: { seatId: REVIEWER, nodeId: "reviewer-node" },
      subject: { kind: "task", projection },
      kind: "blocking",
      findings: ["wrong fence"],
      refs: [{ kind: "commit", sha: "SHA-1" }, { kind: "url", url: "https://x" }],
      reviewsEdgeCurrent: true,
      verdictId: "v-2",
      postedAtMs: 2,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.effect).toEqual({
      kind: "blocking",
      defect: { summary: "wrong fence", refs: ["SHA-1"] },
    });
  });

  it("a standalone commit subject is epoch 0 and blocking has NO send-back effect", () => {
    const planned = planVerdictPost({
      caller: { seatId: REVIEWER, nodeId: "reviewer-node" },
      subject: { kind: "commit", sha: "SHA-ABC", authorSeatId: AUTHOR },
      kind: "blocking",
      findings: ["bad commit"],
      refs: [],
      reviewsEdgeCurrent: true,
      verdictId: "v-3",
      postedAtMs: 3,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.effect).toEqual({ kind: "none" });
    expect(planned.verdict.epoch).toBe(0);
    expect(planned.verdict.subject).toMatchObject({ kind: "commit", sha: "sha-abc" });
  });
});

describe("evaluateReviewGate — latest per reviewer on the exact binding", () => {
  const rule: Rule = { id: "rule-rv", text: "independent review", kind: "requires-review" };
  const boardRule: RuleInForce = { rule, provenance: { kind: "board", boardId: "s1" } };
  const regionRule: RuleInForce = {
    rule,
    provenance: { kind: "region", label: "crew", regionId: "reg-1" },
  };

  // One working task per test; verdicts must name ITS taskId or the gate
  // correctly sees a different subject.
  const fixture = () => {
    const projection = projectionOf(workingTask({ commits: ["sha-1"] }));
    const verdictOf = (input: {
      readonly reviewerSeatId: ActorSeatId;
      readonly kind: "green" | "blocking";
      readonly postedAtMs: number;
      readonly epoch?: number;
      readonly subjectHash?: string;
      readonly verdictId?: string;
    }): ReviewVerdict => ({
      verdictId: input.verdictId ?? `v-${input.postedAtMs}-${input.kind}`,
      kind: input.kind,
      reviewerSeatId: input.reviewerSeatId,
      reviewerNodeId: "reviewer-node",
      authorSeatId: AUTHOR,
      subject: {
        kind: "task",
        installationId: projection.installationId,
        canvasName: projection.canvasName,
        nodeId: projection.nodeId,
        taskId: projection.taskId,
        epoch: input.epoch ?? projection.epoch,
        subjectHash: input.subjectHash ?? projection.subjectHash,
      },
      subjectHash: input.subjectHash ?? projection.subjectHash,
      epoch: input.epoch ?? projection.epoch,
      findings: [],
      refs: [],
      postedAtMs: input.postedAtMs,
    });
    const gate = (input: {
      readonly rules?: ReadonlyArray<RuleInForce>;
      readonly verdicts: ReadonlyArray<ReviewVerdict>;
      readonly hasEdge?: (seat: ActorSeatId) => boolean;
    }) =>
      evaluateReviewGate({
        rulesInForce: input.rules ?? [boardRule],
        projection,
        verdicts: input.verdicts,
        authorSeatId: AUTHOR,
        reviewerHasCurrentEdge: input.hasEdge ?? (() => true),
      });
    return { projection, verdictOf, gate };
  };

  it("no armed rules -> satisfied; a region-provenance requires-review never arms", () => {
    const f = fixture();
    const result = f.gate({ verdicts: [], rules: [regionRule] });
    expect(result.satisfied).toBe(true);
    expect(result.armed).toEqual([]);
  });

  it("no verdicts at all -> no-green-current-epoch", () => {
    const result = fixture().gate({ verdicts: [] });
    expect(result.satisfied).toBe(false);
    expect(result.unsatisfied[0]?.reason).toBe("no-green-current-epoch");
  });

  it("a green from an OLDER epoch cannot bless the current one", () => {
    const f = fixture();
    const result = f.gate({
      verdicts: [
        f.verdictOf({
          reviewerSeatId: REVIEWER,
          kind: "green",
          postedAtMs: 1,
          epoch: f.projection.epoch - 1,
        }),
      ],
    });
    expect(result.satisfied).toBe(false);
    expect(result.unsatisfied[0]?.reason).toBe("no-green-current-epoch");
  });

  it("a green on the right epoch but OLD refs cannot bless new refs -> stale-refs", () => {
    const f = fixture();
    const result = f.gate({
      verdicts: [
        f.verdictOf({
          reviewerSeatId: REVIEWER,
          kind: "green",
          postedAtMs: 1,
          subjectHash: "old-refs-hash",
        }),
      ],
    });
    expect(result.satisfied).toBe(false);
    expect(result.unsatisfied[0]?.reason).toBe("stale-refs");
  });

  it("a distinct reviewer's latest green on the exact binding with a live edge satisfies", () => {
    const f = fixture();
    const result = f.gate({
      verdicts: [f.verdictOf({ reviewerSeatId: REVIEWER, kind: "green", postedAtMs: 1 })],
    });
    expect(result.satisfied).toBe(true);
  });

  it("the author's own green never qualifies -> no-qualifying-green", () => {
    const f = fixture();
    const result = f.gate({
      verdicts: [f.verdictOf({ reviewerSeatId: AUTHOR, kind: "green", postedAtMs: 1 })],
    });
    expect(result.satisfied).toBe(false);
    expect(result.unsatisfied[0]?.reason).toBe("no-qualifying-green");
  });

  it("a qualifying green whose edge was revoked -> edge-removed", () => {
    const f = fixture();
    const result = f.gate({
      verdicts: [f.verdictOf({ reviewerSeatId: REVIEWER, kind: "green", postedAtMs: 1 })],
      hasEdge: () => false,
    });
    expect(result.satisfied).toBe(false);
    expect(result.unsatisfied[0]?.reason).toBe("edge-removed");
  });

  it("a blocking posted AFTER a green by the same reviewer unblesses the gate", () => {
    const f = fixture();
    const result = f.gate({
      verdicts: [
        f.verdictOf({ reviewerSeatId: REVIEWER, kind: "green", postedAtMs: 1 }),
        f.verdictOf({ reviewerSeatId: REVIEWER, kind: "blocking", postedAtMs: 2 }),
      ],
    });
    expect(result.satisfied).toBe(false);
    expect(result.unsatisfied[0]?.reason).toBe("no-qualifying-green");
  });

  it("same reviewer, same ms: BLOCKING WINS regardless of array order", () => {
    const f = fixture();
    const green = f.verdictOf({
      reviewerSeatId: REVIEWER,
      kind: "green",
      postedAtMs: 7,
      verdictId: "v-green",
    });
    const blocking = f.verdictOf({
      reviewerSeatId: REVIEWER,
      kind: "blocking",
      postedAtMs: 7,
      verdictId: "v-block",
    });
    for (const order of [
      [green, blocking],
      [blocking, green],
    ] as const) {
      const result = f.gate({ verdicts: [...order] });
      expect(result.satisfied).toBe(false);
      expect(result.unsatisfied[0]?.reason).toBe("no-qualifying-green");
    }
  });
});

describe("reviewsEdgeExists — mask-aware, directed", () => {
  const docWith = (edge: CanvasDoc["edges"][number]): CanvasDoc => ({
    nodes: [agentNode("reviewer-node"), agentNode("author-node")],
    edges: [edge],
  });

  it("authored reviews verb with no mask = full compiled grant", () => {
    expect(
      reviewsEdgeExists(docWith(reviewsEdge("reviewer-node", "author-node")), "reviewer-node", "author-node"),
    ).toBe(true);
  });

  it("a mask naming verdict.post keeps the grant", () => {
    expect(
      reviewsEdgeExists(
        docWith(reviewsEdge("reviewer-node", "author-node", ["verdict.post"])),
        "reviewer-node",
        "author-node",
      ),
    ).toBe(true);
  });

  it("an empty mask is NO grant", () => {
    expect(
      reviewsEdgeExists(
        docWith(reviewsEdge("reviewer-node", "author-node", [])),
        "reviewer-node",
        "author-node",
      ),
    ).toBe(false);
  });

  it("direction matters: author -> reviewer is not the reviewer's grant", () => {
    expect(
      reviewsEdgeExists(docWith(reviewsEdge("author-node", "reviewer-node")), "reviewer-node", "author-node"),
    ).toBe(false);
  });
});

describe("receipt feed — exact source/ref dedupe", () => {
  const installationA = Schema.decodeUnknownSync(InstallationId)("inst-alpha-tasks");
  const installationB = Schema.decodeUnknownSync(InstallationId)("inst-alpha");
  const recordSource = receiptSourceForRecord({
    id: {
      route: { eventHome: installationA, entityHome: installationB },
      seq: Schema.decodeUnknownSync(LogicalSequence)("7"),
    },
  });

  const plan = (over?: {
    alreadySent?: (key: string) => boolean;
    refs?: ReadonlyArray<{ kind: "commit"; sha: string }>;
  }) => {
    const task = workingTask({ commits: ["sha-1"] });
    return planReceiptMail({
      canvasName: "alpha",
      nodeId: "s1",
      task,
      projection: projectionOf(task),
      refs: over?.refs ?? [
        { kind: "commit", sha: "sha-1" },
        { kind: "commit", sha: "sha-2" },
      ],
      source: recordSource,
      reviewers: [{ nodeId: "reviewer-node", seatId: REVIEWER }],
      author: { seatId: AUTHOR, generation: "gen-3", harness: "claude" },
      contextId: "ctx-1",
      alreadySent: over?.alreadySent ?? (() => false),
      messageId: () => "m-1",
    });
  };

  it("dedupe identity is the verbatim WorkRecord id, string seq included", () => {
    const key = receiptDedupeKey({
      canvasName: "alpha",
      source: recordSource,
      refSha: "SHA-1",
      reviewerSeatId: REVIEWER,
    });
    expect(key).toContain("inst-alpha-tasks/inst-alpha/7");
    expect(key).toContain("sha-1"); // sha folded, seq NOT number-parsed
    expect(receiptSourceId(recordSource)).toBe("inst-alpha-tasks/inst-alpha/7");
  });

  it("two fresh refs -> one user-role receipt mail per reviewer with both dedupe keys", () => {
    const planned = plan();
    expect(planned.coalesced).toBe(0);
    expect(planned.mail).toHaveLength(1);
    const mail = planned.mail[0]!;
    expect(mail.message.role).toBe("user");
    expect(mail.dedupeKeys).toHaveLength(2);
    // Root ruling: the receipt hands the reviewer the exact server-derived
    // CAS subject (no task-read grant widening) — in the returned shape, in
    // metadata, and actionably in the body with the target sink.
    expect(mail.subject.kind).toBe("task");
    if (mail.subject.kind !== "task") return;
    expect(mail.subject.subjectHash).toMatch(/^[0-9a-f]{64}$/);
    const metadata = mail.message.metadata as Record<string, unknown>;
    expect(metadata.mailKind).toBe("receipt");
    expect(metadata.fromSeat).toBe(AUTHOR);
    expect(metadata.reviewSubject).toMatchObject({
      kind: "task",
      taskId: mail.subject.taskId,
      epoch: mail.subject.epoch,
      subjectHash: mail.subject.subjectHash,
    });
    const body = mail.message.parts
      .filter((part) => part.kind === "text")
      .map((part) => ("text" in part ? part.text : ""))
      .join("\n");
    expect(body).toContain(mail.subject.subjectHash);
    expect(body).toContain("s1"); // target sink
    const refs = metadata.refs as ReadonlyArray<{ kind: string }>;
    expect(refs[0]).toMatchObject({ kind: "task" });
  });

  it("an already-sent (source, ref, reviewer) coalesces out of the mail", () => {
    const sentKey = receiptDedupeKey({
      canvasName: "alpha",
      source: recordSource,
      refSha: "sha-1",
      reviewerSeatId: REVIEWER,
    });
    const planned = plan({ alreadySent: (key) => key === sentKey });
    expect(planned.coalesced).toBe(1);
    expect(planned.mail[0]?.dedupeKeys).toHaveLength(1);
  });

  it("within a batch, case variants of one sha ship ONE ref and one key", () => {
    const planned = plan({
      refs: [
        { kind: "commit", sha: "ABC123" },
        { kind: "commit", sha: "abc123" },
      ],
    });
    expect(planned.coalesced).toBe(0);
    expect(planned.mail).toHaveLength(1);
    const mail = planned.mail[0]!;
    expect(mail.dedupeKeys).toHaveLength(1);
    expect(new Set(mail.dedupeKeys).size).toBe(1);
    const metadata = mail.message.metadata as Record<string, unknown>;
    const refs = metadata.refs as ReadonlyArray<{ kind: string; sha?: string }>;
    expect(refs.filter((r) => r.kind === "commit")).toEqual([
      { kind: "commit", sha: "abc123" },
    ]);
    expect(metadata.subject).toContain("1 commit ref");
  });

  it("sha case never defeats the dedupe", () => {
    const sentKey = receiptDedupeKey({
      canvasName: "alpha",
      source: recordSource,
      refSha: "sha-1",
      reviewerSeatId: REVIEWER,
    });
    const planned = plan({
      refs: [{ kind: "commit", sha: "SHA-1" }],
      alreadySent: (key) => key === sentKey,
    });
    expect(planned.coalesced).toBe(1);
    expect(planned.mail).toHaveLength(0);
  });
});

describe("checkout receipt feed — standalone commit subjects", () => {
  const REVIEWER_2 = `seat_${"c".repeat(64)}` as ActorSeatId;

  const plan = (over?: {
    shas?: ReadonlyArray<string>;
    reviewers?: ReadonlyArray<{ nodeId: string; seatId: ActorSeatId }>;
    alreadySent?: (key: string) => boolean;
  }) =>
    planCheckoutReceiptMail({
      canvasName: "alpha",
      checkoutKey: "co-1",
      shas: over?.shas ?? ["abc123", "def456"],
      reviewers: over?.reviewers ?? [{ nodeId: "reviewer-node", seatId: REVIEWER }],
      author: { seatId: AUTHOR, generation: "gen-3", harness: "claude" },
      contextId: "ctx-1",
      alreadySent: over?.alreadySent ?? (() => false),
      messageId: (() => {
        let n = 0;
        return () => `m-${++n}`;
      })(),
    });

  it("one mail per (fresh commit, reviewer), each an actionable commit subject", () => {
    const planned = plan({
      reviewers: [
        { nodeId: "reviewer-node", seatId: REVIEWER },
        { nodeId: "reviewer-2-node", seatId: REVIEWER_2 },
      ],
    });
    expect(planned.coalesced).toBe(0);
    expect(planned.mail).toHaveLength(4); // 2 shas x 2 reviewers
    const first = planned.mail[0]!;
    expect(first.subject).toEqual({ kind: "commit", sha: "abc123" });
    expect(first.dedupeKeys).toHaveLength(1);
    expect(first.message.role).toBe("user");
    const metadata = first.message.metadata as Record<string, unknown>;
    expect(metadata.mailKind).toBe("receipt");
    expect(metadata.reviewSubject).toEqual({ kind: "commit", sha: "abc123" });
    expect(metadata.fromSeat).toBe(AUTHOR);
    const refs = metadata.refs as ReadonlyArray<{ kind: string; sha?: string }>;
    expect(refs).toEqual([{ kind: "commit", sha: "abc123" }]);
  });

  it("the body states plainly that no task binding is implied", () => {
    const body = plan().mail[0]!.message.parts
      .filter((part) => part.kind === "text")
      .map((part) => ("text" in part ? part.text : ""))
      .join("\n");
    expect(body).toContain("no task binding is implied");
    expect(body).not.toContain("epoch");
  });

  it("an already-recorded (checkout, sha, reviewer) coalesces out", () => {
    const sentKey = receiptDedupeKey({
      canvasName: "alpha",
      source: { kind: "checkout", checkoutKey: "co-1" },
      refSha: "abc123",
      reviewerSeatId: REVIEWER,
    });
    const planned = plan({ alreadySent: (key) => key === sentKey });
    expect(planned.coalesced).toBe(1);
    expect(planned.mail).toHaveLength(1);
    expect(planned.mail[0]?.subject).toEqual({ kind: "commit", sha: "def456" });
  });

  it("case variants of one sha collapse before keying and mailing", () => {
    const planned = plan({ shas: ["ABC123", "abc123"] });
    expect(planned.coalesced).toBe(0);
    expect(planned.mail).toHaveLength(1);
    expect(planned.mail[0]?.subject).toEqual({ kind: "commit", sha: "abc123" });
  });

  it("blank shas never reach a reviewer", () => {
    expect(plan({ shas: ["", "   "] }).mail).toHaveLength(0);
  });
});

describe("reviewersOfAuthor — stable-seat dedupe", () => {
  const docWith = (...edges: ReadonlyArray<CanvasDoc["edges"][number]>): CanvasDoc => ({
    nodes: [agentNode("reviewer-node-a"), agentNode("reviewer-node-b"), agentNode("author-node")],
    edges: [...edges],
  });
  const twoNodeRefs = [
    actorRefOf(REVIEWER, "reviewer-node-a"),
    actorRefOf(REVIEWER, "reviewer-node-b"),
  ];

  it("parallel eligible edges sharing one stable seat collapse to the first edge in doc order", () => {
    const doc = docWith(
      reviewsEdge("reviewer-node-a", "author-node"),
      reviewsEdge("reviewer-node-b", "author-node"),
    );
    expect(
      reviewersOfAuthor({ doc, authorNodeId: "author-node", actorRefs: twoNodeRefs }),
    ).toEqual([{ nodeId: "reviewer-node-a", seatId: REVIEWER }]);
  });

  it("an ineligible parallel edge does not shadow the reviewer", () => {
    const doc = docWith(
      reviewsEdge("reviewer-node-a", "author-node", []), // mask removes verdict.post
      reviewsEdge("reviewer-node-b", "author-node"),
    );
    expect(
      reviewersOfAuthor({ doc, authorNodeId: "author-node", actorRefs: twoNodeRefs }),
    ).toEqual([{ nodeId: "reviewer-node-b", seatId: REVIEWER }]);
  });

  it("distinct seats keep one entry each", () => {
    const doc = docWith(
      reviewsEdge("reviewer-node-a", "author-node"),
      reviewsEdge("reviewer-node-b", "author-node"),
    );
    const OTHER = `seat_${"c".repeat(64)}` as ActorSeatId;
    const reviewers = reviewersOfAuthor({
      doc,
      authorNodeId: "author-node",
      actorRefs: [actorRefOf(REVIEWER, "reviewer-node-a"), actorRefOf(OTHER, "reviewer-node-b")],
    });
    expect(reviewers).toEqual([
      { nodeId: "reviewer-node-a", seatId: REVIEWER },
      { nodeId: "reviewer-node-b", seatId: OTHER },
    ]);
  });
});
