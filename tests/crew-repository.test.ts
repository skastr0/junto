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
import { type ReviewVerdict } from "../src/shared/crew";

const seat = (c: string): typeof ActorSeatId.Type =>
  Schema.decodeUnknownSync(ActorSeatId)(`seat_${c.repeat(64)}`);
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
