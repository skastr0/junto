import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  ReviewVerdict,
  VERDICT_SUBJECT_HASH_DOMAIN,
  verdictSubjectHashPayload,
} from "../src/shared/crew";

// Independent adversarial seam tests for the review-verdict contract
// (docs/crew-contract.md). The gate compares epoch AND subjectHash; the
// hash payload is the one canonical function every lane must build from,
// so its normalization semantics are pinned here.

const taskInput = {
  kind: "task" as const,
  installationId: "inst-1",
  canvasName: "c",
  nodeId: "board",
  taskId: "t1",
  epoch: 2,
};

describe("crew verdict subject hash — canonical binding", () => {
  it("a different epoch produces a different payload (old green cannot bless a new epoch)", () => {
    const a = verdictSubjectHashPayload(taskInput);
    const b = verdictSubjectHashPayload({ ...taskInput, epoch: 3 });
    expect(a).not.toBe(b);
  });

  it("newly submitted refs change the payload (old green cannot bless new commits)", () => {
    const before = verdictSubjectHashPayload({ ...taskInput, commitShas: ["aaa"] });
    const after = verdictSubjectHashPayload({ ...taskInput, commitShas: ["aaa", "bbb"] });
    expect(before).not.toBe(after);
  });

  it("commit sha order, case and duplicates never change the identity", () => {
    const a = verdictSubjectHashPayload({
      ...taskInput,
      commitShas: ["ABC", "def", "abc", "DEF"],
    });
    const b = verdictSubjectHashPayload({ ...taskInput, commitShas: ["def", "abc"] });
    expect(a).toBe(b);
  });

  it("task and commit subjects are domain-separated", () => {
    const task = verdictSubjectHashPayload(taskInput);
    const commit = verdictSubjectHashPayload({ kind: "commit", sha: "abc" });
    expect(task).not.toBe(commit);
    expect(task).toContain(VERDICT_SUBJECT_HASH_DOMAIN);
    expect(commit).toContain(VERDICT_SUBJECT_HASH_DOMAIN);
  });

  it("every task-identity field binds the payload", () => {
    const base = verdictSubjectHashPayload(taskInput);
    for (const field of ["installationId", "canvasName", "nodeId", "taskId"] as const) {
      const changed = verdictSubjectHashPayload({ ...taskInput, [field]: "other" });
      expect(changed).not.toBe(base);
    }
  });

  it("the payload is deterministic across processes", () => {
    expect(verdictSubjectHashPayload(taskInput)).toBe(
      verdictSubjectHashPayload({ ...taskInput }),
    );
  });
});

describe("crew verdict row — schema contract", () => {
  const decode = Schema.decodeUnknownSync(ReviewVerdict);

  const verdict = {
    verdictId: "v1",
    kind: "green" as const,
    reviewerSeatId: `seat_${"a".repeat(64)}`,
    authorSeatId: `seat_${"b".repeat(64)}`,
    subject: {
      kind: "task" as const,
      installationId: "inst-1",
      canvasName: "c",
      nodeId: "board",
      taskId: "t1",
      epoch: 2,
      subjectHash: "hash-1",
    },
    subjectHash: "hash-1",
    epoch: 2,
    findings: [],
    refs: [],
    postedAtMs: 1_000,
  };

  it("a verdict carries epoch and subjectHash as first-class fields", () => {
    const decoded = decode(verdict);
    expect(decoded.epoch).toBe(2);
    expect(decoded.subjectHash).toBe("hash-1");
    expect(decoded.kind).toBe("green");
  });

  it("a blocking verdict is a distinct kind, not a flag on green", () => {
    const decoded = decode({ ...verdict, kind: "blocking", findings: ["f1"] });
    expect(decoded.kind).toBe("blocking");
    expect(decoded.findings).toEqual(["f1"]);
  });

  it("verdicts on different epochs are independent rows", () => {
    const older = decode({ ...verdict, verdictId: "v0", epoch: 1, subjectHash: "h0" });
    const newer = decode(verdict);
    expect(older.epoch).toBe(1);
    expect(newer.epoch).toBe(2);
    expect(older.verdictId).not.toBe(newer.verdictId);
  });
});
