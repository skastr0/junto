import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CrewRepository,
  CrewRepositoryLive,
  applyVerdictWrite,
  subjectHashOf,
} from "../src/main/junto/work/crew-repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/junto/state/engine";
import { unjournaledWorkMutation } from "../src/main/junto/work/mutation-seam";
import { ActorSeatId } from "../src/shared/actor-seat";
import { deriveMailDisplayState, type ReviewVerdict } from "../src/shared/crew";

const seat = (c: string): typeof ActorSeatId.Type =>
  Schema.decodeUnknownSync(ActorSeatId)(`seat_${c.repeat(64)}`);
const SEAT_RECIPIENT = seat("a");
const SEAT_REVIEWER = seat("b");
const SEAT_REVIEWER_2 = seat("d");
const SEAT_AUTHOR = seat("c");

const root = join(tmpdir(), `junto-crew-repo-${randomUUID()}`);
const runtime = ManagedRuntime.make(
  Layer.provideMerge(
    CrewRepositoryLive,
    makeStateEngineLive(join(root, "junto.db")),
  ),
);

let crew: Context.Service.Shape<typeof CrewRepository>;
let state: Context.Service.Shape<typeof StateEngine>;

const sink = { canvasName: "factory", nodeId: "agent-1" };
const iso = (n: number): string => new Date(1_760_000_000_000 + n).toISOString();

const taskSubject = (epoch: number, hash: string): ReviewVerdict["subject"] => ({
  kind: "task",
  installationId: "cc-crew",
  canvasName: "factory",
  nodeId: "board-1",
  taskId: "t1",
  epoch,
  subjectHash: hash,
});

const verdict = (
  over: Partial<ReviewVerdict> & Pick<ReviewVerdict, "verdictId" | "kind">,
): ReviewVerdict => {
  const hash = over.subjectHash ?? "hash-e0";
  return {
    reviewerSeatId: SEAT_REVIEWER,
    authorSeatId: SEAT_AUTHOR,
    subject: taskSubject(over.epoch ?? 0, hash),
    subjectHash: hash,
    epoch: over.epoch ?? 0,
    findings: [],
    refs: [],
    postedAtMs: 1000,
    ...over,
  };
};

beforeAll(async () => {
  crew = await runtime.runPromise(CrewRepository);
  state = await runtime.runPromise(StateEngine);
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

describe("crew delivery attempts", () => {
  it("enqueues idempotently and marks queued before any transport", async () => {
    const input = {
      sink,
      messageId: "m-enqueue",
      recipientSeatId: SEAT_RECIPIENT,
      recipientGeneration: "gen-1",
      policy: "notice" as const,
      at: iso(1),
    };
    const first = await runtime.runPromise(crew.enqueueAttempt(input));
    expect(first.created).toBe(true);
    expect(first.attempt.facts.queuedAt).toBe(iso(1));
    expect(first.attempt.facts.attemptedAt).toBeUndefined();

    const second = await runtime.runPromise(
      crew.enqueueAttempt({ ...input, at: iso(2) }),
    );
    expect(second.created).toBe(false);
    // The queued stamp is not overwritten by a re-enqueue.
    expect(second.attempt.facts.queuedAt).toBe(iso(1));
  });

  it("stamps the intent witness set-once and never clears a prior outcome", async () => {
    const key = {
      sink,
      messageId: "m-outcome",
      recipientSeatId: SEAT_RECIPIENT,
      recipientGeneration: "gen-1",
    };
    await runtime.runPromise(
      crew.enqueueAttempt({ ...key, policy: "immediate", at: iso(10) }),
    );
    await runtime.runPromise(crew.markAttempted({ ...key, at: iso(11) }));
    await runtime.runPromise(crew.markAttempted({ ...key, at: iso(12) }));
    const afterAttempt = await runtime.runPromise(crew.attempt(key));
    expect(afterAttempt?.facts.attemptedAt).toBe(iso(11));

    // Notified stamps once…
    await runtime.runPromise(
      crew.recordAttempt({
        ...key,
        outcome: { kind: "notified", at: iso(13) },
        write: { writesBefore: 4, writesAfter: 5, at: iso(13) },
      }),
    );
    // …and a later refusal cannot clear or move it (independent facts).
    const finalAttempt = await runtime.runPromise(
      crew.recordAttempt({
        ...key,
        outcome: { kind: "refused", at: iso(14), reason: "seat-busy" },
      }),
    );
    expect(finalAttempt.facts.notifiedAt).toBe(iso(13));
    expect(finalAttempt.facts.refusedAt).toBe(iso(14));
    expect(finalAttempt.facts.refusedReason).toBe("seat-busy");
    expect(deriveMailDisplayState(finalAttempt.facts)).toBe("notified");
    expect(finalAttempt.write?.writesAfter).toBe(5);
  });

  it("recovers a crashed intent as unresolved and leaves clean rows alone", async () => {
    // A crashed intent: attempted, no outcome.
    await runtime.runPromise(
      crew.enqueueAttempt({
        sink,
        messageId: "m-crash",
        recipientSeatId: SEAT_RECIPIENT,
        recipientGeneration: "gen-2",
        policy: "notice",
        at: iso(20),
      }),
    );
    await runtime.runPromise(
      crew.markAttempted({
        sink,
        messageId: "m-crash",
        recipientSeatId: SEAT_RECIPIENT,
        recipientGeneration: "gen-2",
        at: iso(21),
      }),
    );
    // A clean durable enqueue with no transport touch.
    await runtime.runPromise(
      crew.enqueueAttempt({
        sink,
        messageId: "m-clean",
        recipientSeatId: SEAT_RECIPIENT,
        recipientGeneration: "gen-2",
        policy: "notice",
        at: iso(22),
      }),
    );

    const reconciled = await runtime.runPromise(
      crew.reconcileUnresolvedAttempts(iso(30)),
    );
    expect(reconciled).toBeGreaterThanOrEqual(1);

    const crashed = await runtime.runPromise(
      crew.attempt({
        sink,
        messageId: "m-crash",
        recipientSeatId: SEAT_RECIPIENT,
        recipientGeneration: "gen-2",
      }),
    );
    expect(crashed?.facts.unresolvedAt).toBe(iso(30));

    const clean = await runtime.runPromise(
      crew.attempt({
        sink,
        messageId: "m-clean",
        recipientSeatId: SEAT_RECIPIENT,
        recipientGeneration: "gen-2",
      }),
    );
    // A queued row that was never attempted stays clean, safe to attempt.
    expect(clean?.facts.attemptedAt).toBeUndefined();
    expect(clean?.facts.unresolvedAt).toBeUndefined();
  });

  it("recovers a retry that crashes after a prior refusal, preserving the refusal", async () => {
    const key = {
      sink,
      messageId: "m-retry",
      recipientSeatId: SEAT_RECIPIENT,
      recipientGeneration: "gen-retry",
    };
    await runtime.runPromise(
      crew.enqueueAttempt({ ...key, policy: "notice", at: iso(70) }),
    );
    // First physical attempt refuses.
    await runtime.runPromise(crew.markAttempted({ ...key, at: iso(71) }));
    await runtime.runPromise(
      crew.recordAttempt({
        ...key,
        outcome: { kind: "refused", at: iso(72), reason: "seat-busy" },
      }),
    );
    // An operator retry opens a SECOND physical intent, then the process crashes
    // before recording an outcome (no new terminal fact).
    await runtime.runPromise(crew.markAttempted({ ...key, at: iso(73) }));

    const reconciled = await runtime.runPromise(
      crew.reconcileUnresolvedAttempts(iso(80)),
    );
    expect(reconciled).toBeGreaterThanOrEqual(1);

    const row = await runtime.runPromise(crew.attempt(key));
    // The crashed retry is recovered as unresolved, and the earlier refusal
    // fact is preserved (independent facts, no clearing).
    expect(row?.facts.unresolvedAt).toBe(iso(80));
    expect(row?.facts.refusedAt).toBe(iso(72));
    expect(row?.facts.refusedReason).toBe("seat-busy");

    // A second reconcile is a no-op: the intent is closed.
    const again = await runtime.runPromise(
      crew.reconcileUnresolvedAttempts(iso(81)),
    );
    expect(again).toBe(0);
  });

  it("commits a batch membership set atomically before transport", async () => {
    const members = ["mb-1", "mb-2"].map((messageId) => ({
      sink,
      messageId,
      recipientSeatId: SEAT_RECIPIENT,
      recipientGeneration: "gen-3",
      policy: "notice" as const,
      batchId: "batch-1",
      at: iso(40),
    }));
    const attempts = await runtime.runPromise(crew.enqueueBatch({ members }));
    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => a.batchId === "batch-1")).toBe(true);
    expect(attempts.every((a) => a.facts.attemptedAt === undefined)).toBe(true);
  });

  it("associates an already-queued, refused row into a later batch, keeping its facts", async () => {
    const base = {
      sink,
      messageId: "m-rebatch",
      recipientSeatId: SEAT_RECIPIENT,
      recipientGeneration: "gen-rebatch",
    };
    // A prior individual attempt queued then refused (not-settled), no batch.
    await runtime.runPromise(crew.enqueueAttempt({ ...base, policy: "notice", at: iso(90) }));
    await runtime.runPromise(crew.markAttempted({ ...base, at: iso(91) }));
    await runtime.runPromise(
      crew.recordAttempt({ ...base, outcome: { kind: "refused", at: iso(92), reason: "not-settled" } }),
    );

    // A later batch after settle includes the existing row plus a new one.
    const attempts = await runtime.runPromise(
      crew.enqueueBatch({
        members: [
          { ...base, policy: "notice", batchId: "batch-after-settle", at: iso(93) },
          {
            sink,
            messageId: "m-rebatch-new",
            recipientSeatId: SEAT_RECIPIENT,
            recipientGeneration: "gen-rebatch",
            policy: "notice",
            batchId: "batch-after-settle",
            at: iso(93),
          },
        ],
      }),
    );
    // Both members carry the actual batch id (existing row was associated).
    expect(attempts.map((a) => a.batchId)).toEqual([
      "batch-after-settle",
      "batch-after-settle",
    ]);
    // The existing row kept its queued and refusal facts.
    const existing = attempts.find((a) => a.messageId === "m-rebatch");
    expect(existing?.facts.queuedAt).toBe(iso(90));
    expect(existing?.facts.refusedAt).toBe(iso(92));
    expect(existing?.facts.refusedReason).toBe("not-settled");
  });

  it("suppresses across generations once a message was notified", async () => {
    const base = {
      sink,
      messageId: "m-suppress",
      recipientSeatId: SEAT_RECIPIENT,
      recipientGeneration: "gen-4",
      policy: "notice" as const,
    };
    await runtime.runPromise(crew.enqueueAttempt({ ...base, at: iso(50) }));
    await runtime.runPromise(
      crew.recordAttempt({
        ...base,
        outcome: { kind: "notified", at: iso(51) },
      }),
    );
    const notified = await runtime.runPromise(
      crew.hasNotifiedAcrossGenerations(sink, "m-suppress", SEAT_RECIPIENT),
    );
    expect(notified).toBe(true);
  });
});

describe("crew review verdicts", () => {
  it("subject hash is deterministic, kind-separated, and ref-order invariant", () => {
    const a = subjectHashOf({
      kind: "task",
      installationId: "cc",
      canvasName: "factory",
      nodeId: "b1",
      taskId: "t1",
      epoch: 1,
      commitShas: ["DEAD", "beef"],
    });
    const b = subjectHashOf({
      kind: "task",
      installationId: "cc",
      canvasName: "factory",
      nodeId: "b1",
      taskId: "t1",
      epoch: 1,
      commitShas: ["beef", "dead"],
    });
    expect(a).toBe(b); // normalized (lowercased, sorted)
    const commit = subjectHashOf({ kind: "commit", sha: "dead" });
    expect(commit).not.toBe(a);
  });

  it("subject hash keeps commit/artifact/claim refs in distinct slots (no aliasing)", () => {
    const base = {
      kind: "task" as const,
      installationId: "cc",
      canvasName: "factory",
      nodeId: "b1",
      taskId: "t1",
      epoch: 1,
    };
    // Artifact refs dedupe and sort, case preserved; order does not matter.
    const artA = subjectHashOf({
      ...base,
      artifactRefs: [
        { nodeId: "N2", artifactId: "A2" },
        { nodeId: "N1", artifactId: "A1" },
        { nodeId: "N1", artifactId: "A1" },
      ],
    });
    const artB = subjectHashOf({
      ...base,
      artifactRefs: [
        { nodeId: "N1", artifactId: "A1" },
        { nodeId: "N2", artifactId: "A2" },
      ],
    });
    expect(artA).toBe(artB);
    // Case is preserved for artifacts (not folded like shas).
    const artLower = subjectHashOf({
      ...base,
      artifactRefs: [{ nodeId: "n1", artifactId: "a1" }],
    });
    const artUpper = subjectHashOf({
      ...base,
      artifactRefs: [{ nodeId: "N1", artifactId: "A1" }],
    });
    expect(artLower).not.toBe(artUpper);
    // A claim ref string cannot alias an artifact pair or a commit sha.
    const claim = subjectHashOf({ ...base, claimRefs: ["N1"] });
    const artifactOnly = subjectHashOf({
      ...base,
      artifactRefs: [{ nodeId: "N1", artifactId: "" }],
    });
    expect(claim).not.toBe(artifactOnly);
    const commitSlot = subjectHashOf({ ...base, commitShas: ["N1"] });
    expect(claim).not.toBe(commitSlot);
  });

  it("keeps the immutable chain and is idempotent by verdict id", async () => {
    const v1 = verdict({ verdictId: "vr-1", kind: "blocking", subjectHash: "hash-c1", findings: ["fix x"] });
    const first = await runtime.runPromise(crew.postVerdict(v1));
    expect(first.created).toBe(true);
    const repost = await runtime.runPromise(crew.postVerdict(v1));
    expect(repost.created).toBe(false);

    const v2 = verdict({ verdictId: "vr-2", kind: "green", subjectHash: "hash-c1", postedAtMs: 2000 });
    await runtime.runPromise(crew.postVerdict(v2));

    const chain = await runtime.runPromise(
      crew.verdictsForSubject({
        kind: "task",
        installationId: "cc-crew",
        canvasName: "factory",
        nodeId: "board-1",
        taskId: "t1",
      }),
    );
    const forHash = chain.filter((v) => v.subjectHash === "hash-c1");
    expect(forHash.map((v) => v.verdictId)).toEqual(["vr-1", "vr-2"]);
  });

  it("gate takes each reviewer's latest verdict and excludes the author", async () => {
    const hash = "hash-gate";
    // Reviewer B: blocking then green -> latest green.
    await runtime.runPromise(
      crew.postVerdict(
        verdict({ verdictId: "g-1", kind: "blocking", subjectHash: hash, reviewerSeatId: SEAT_REVIEWER, postedAtMs: 1000 }),
      ),
    );
    await runtime.runPromise(
      crew.postVerdict(
        verdict({ verdictId: "g-2", kind: "green", subjectHash: hash, reviewerSeatId: SEAT_REVIEWER, postedAtMs: 2000 }),
      ),
    );
    const green = await runtime.runPromise(
      crew.currentGreenExists({
        installationId: "cc-crew",
        canvasName: "factory",
        nodeId: "board-1",
        taskId: "t1",
        epoch: 0,
        subjectHash: hash,
        excludingSeatId: SEAT_AUTHOR,
      }),
    );
    expect(green).toBe(true);

    // The author's own green never counts.
    const authorOnly = await runtime.runPromise(
      crew.currentGreenExists({
        installationId: "cc-crew",
        canvasName: "factory",
        nodeId: "board-1",
        taskId: "t1",
        epoch: 0,
        subjectHash: hash,
        excludingSeatId: SEAT_REVIEWER,
      }),
    );
    expect(authorOnly).toBe(false);

    // A later blocking from the same reviewer withdraws the green.
    await runtime.runPromise(
      crew.postVerdict(
        verdict({ verdictId: "g-3", kind: "blocking", subjectHash: hash, reviewerSeatId: SEAT_REVIEWER, postedAtMs: 3000 }),
      ),
    );
    const afterBlock = await runtime.runPromise(
      crew.currentGreenExists({
        installationId: "cc-crew",
        canvasName: "factory",
        nodeId: "board-1",
        taskId: "t1",
        epoch: 0,
        subjectHash: hash,
        excludingSeatId: SEAT_AUTHOR,
      }),
    );
    expect(afterBlock).toBe(false);
  });

  it("a postedAtMs tie for one reviewer resolves to blocking", async () => {
    const hash = "hash-tie";
    // Same reviewer, same subject+epoch, identical postedAtMs: green + blocking.
    await runtime.runPromise(
      crew.postVerdict(
        verdict({ verdictId: "tie-green", kind: "green", subjectHash: hash, reviewerSeatId: SEAT_REVIEWER_2, postedAtMs: 5000 }),
      ),
    );
    await runtime.runPromise(
      crew.postVerdict(
        verdict({ verdictId: "tie-block", kind: "blocking", subjectHash: hash, reviewerSeatId: SEAT_REVIEWER_2, postedAtMs: 5000 }),
      ),
    );
    const green = await runtime.runPromise(
      crew.currentGreenExists({
        installationId: "cc-crew",
        canvasName: "factory",
        nodeId: "board-1",
        taskId: "t1",
        epoch: 0,
        subjectHash: hash,
        excludingSeatId: SEAT_AUTHOR,
      }),
    );
    // Blocking wins the tie regardless of insertion order.
    expect(green).toBe(false);
  });

  it("a stale epoch or subject hash does not satisfy the gate", async () => {
    const hash = "hash-epoch";
    await runtime.runPromise(
      crew.postVerdict(
        verdict({ verdictId: "e-1", kind: "green", subjectHash: hash, epoch: 1, reviewerSeatId: SEAT_REVIEWER_2, postedAtMs: 1000 }),
      ),
    );
    // Same identity, different epoch -> no green.
    const otherEpoch = await runtime.runPromise(
      crew.currentGreenExists({
        installationId: "cc-crew",
        canvasName: "factory",
        nodeId: "board-1",
        taskId: "t1",
        epoch: 2,
        subjectHash: hash,
        excludingSeatId: SEAT_AUTHOR,
      }),
    );
    expect(otherEpoch).toBe(false);
    // Same epoch, different subject hash -> no green.
    const otherHash = await runtime.runPromise(
      crew.currentGreenExists({
        installationId: "cc-crew",
        canvasName: "factory",
        nodeId: "board-1",
        taskId: "t1",
        epoch: 1,
        subjectHash: "hash-different",
        excludingSeatId: SEAT_AUTHOR,
      }),
    );
    expect(otherHash).toBe(false);
  });

  it("composes a verdict write inside one caller transaction, atomic on throw", async () => {
    const v = verdict({ verdictId: "tx-1", kind: "blocking", subjectHash: "hash-tx", reviewerSeatId: SEAT_REVIEWER_2 });
    // A caller opens ONE transaction and writes the verdict plus a receipt.
    await runtime.runPromise(
      state.transaction("test.compose", (writer) =>
        unjournaledWorkMutation("crew.review-verdict", () => {
        applyVerdictWrite(writer, v);
        writer.run(
          `INSERT OR IGNORE INTO work_review_receipts(
             canvas_name, source_kind, source_id, ref_sha, reviewer_seat_id,
             author_seat_id, created_at
           ) VALUES ('factory','task-fact','f1:1','sha-tx', ?, ?, ?)`,
          [SEAT_REVIEWER_2, SEAT_AUTHOR, iso(60)],
        );
        }),
      ),
    );
    const chain = await runtime.runPromise(
      crew.verdictsForSubject({
        kind: "task",
        installationId: "cc-crew",
        canvasName: "factory",
        nodeId: "board-1",
        taskId: "t1",
      }),
    );
    expect(chain.some((entry) => entry.verdictId === "tx-1")).toBe(true);
    const author = await runtime.runPromise(crew.firstAuthorForSha("sha-tx"));
    expect(author).toBe(SEAT_AUTHOR);

    // A throw inside the caller transaction rolls back BOTH writes.
    await runtime
      .runPromise(
        state.transaction("test.compose-rollback", (writer) =>
          unjournaledWorkMutation("crew.review-verdict", () => {
            applyVerdictWrite(
              writer,
              verdict({ verdictId: "tx-2", kind: "green", subjectHash: "hash-tx" }),
            );
            throw new Error("caller aborted");
          }),
        ),
      )
      .catch(() => undefined);
    const afterRollback = await runtime.runPromise(
      crew.verdictsForSubject({
        kind: "task",
        installationId: "cc-crew",
        canvasName: "factory",
        nodeId: "board-1",
        taskId: "t1",
      }),
    );
    expect(afterRollback.some((entry) => entry.verdictId === "tx-2")).toBe(false);
  });
});
