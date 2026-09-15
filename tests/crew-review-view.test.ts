import { describe, expect, it } from "vitest";
import type { Rule, Task } from "../src/shared/work-model";
import {
  boardReviewGate,
  contractRequiresReview,
  parseReviewVerdict,
  reviewGateOf,
  verdictsOnTask,
  withRequiresReviewRule,
} from "../src/renderer/lib/crew-review-view";

const seat = (n: string): Task["claimedBy"] =>
  `seat_${n.repeat(64)}` as Task["claimedBy"];

const taskOf = (
  overrides: Partial<Task> & {
    readonly verdicts?: unknown;
    readonly subjectHash?: string;
  } = {},
): Task =>
  ({
    id: "task-1",
    state: "working",
    history: [],
    ...overrides,
  }) as Task;

const hash = "subject-hash-current";

const canonicalVerdict = (input: {
  readonly verdictId: string;
  readonly kind: "green" | "blocking";
  readonly reviewerSeatId: Task["claimedBy"];
  readonly authorSeatId: Task["claimedBy"];
  readonly epoch: number;
  readonly subjectHash: string;
  readonly reviewerNodeId?: string;
}) => ({
  verdictId: input.verdictId,
  kind: input.kind,
  reviewerSeatId: input.reviewerSeatId,
  ...(input.reviewerNodeId === undefined
    ? {}
    : { reviewerNodeId: input.reviewerNodeId }),
  authorSeatId: input.authorSeatId,
  subject: {
    kind: "task" as const,
    installationId: "inst-1",
    canvasName: "ops",
    nodeId: "tasks",
    taskId: "task-1",
    epoch: input.epoch,
    subjectHash: input.subjectHash,
  },
  subjectHash: input.subjectHash,
  epoch: input.epoch,
  findings: [] as string[],
  refs: [] as const,
  postedAtMs: 10,
});

describe("requires-review projection", () => {
  it("reads typed rule kind and contract flag, never a free-text guess", () => {
    const statement: Rule = { id: "r1", text: "Requires a distinct reviewer" };
    const typed = { id: "r2", text: "Review", kind: "requires-review" } as Rule;
    expect(contractRequiresReview({ rules: [statement] })).toBe(false);
    expect(contractRequiresReview({ rules: [typed] })).toBe(true);
    expect(
      contractRequiresReview({
        rules: [{ id: "r3", text: "Review", kind: "statement" }],
      }),
    ).toBe(false);
    expect(
      withRequiresReviewRule([statement], true, () => "r-new").some(
        (rule) => rule.kind === "requires-review",
      ),
    ).toBe(true);
  });
});

describe("reviewGateOf", () => {
  it("refuses to treat an old green as current, and refuses author self-green", () => {
    const author = seat("a");
    const reviewer = seat("b");
    const task = taskOf({
      epoch: 2,
      claimedBy: author,
      rules: [{ id: "r-review", text: "Review", kind: "requires-review" }],
      subjectHash: hash,
      verdicts: [
        canonicalVerdict({
          verdictId: "v1",
          kind: "green",
          reviewerSeatId: reviewer,
          authorSeatId: author,
          epoch: 1,
          subjectHash: "subject-hash-old",
        }),
        canonicalVerdict({
          verdictId: "v2",
          kind: "green",
          reviewerSeatId: author,
          authorSeatId: author,
          epoch: 2,
          subjectHash: hash,
        }),
      ],
    });
    const gate = reviewGateOf(task, undefined, author);
    expect(gate.required).toBe(true);
    expect(gate.currentEpoch).toBe(2);
    expect(gate.satisfied).toBe(false);
    expect(verdictsOnTask(task)).toHaveLength(2);
  });

  it("satisfies only a distinct reviewer green on the current subject hash", () => {
    const author = seat("a");
    const reviewer = seat("b");
    const task = taskOf({
      epoch: 1,
      claimedBy: author,
      rules: [{ id: "r-review", text: "Review", kind: "requires-review" }],
      subjectHash: hash,
      verdicts: [
        canonicalVerdict({
          verdictId: "v3",
          kind: "green",
          reviewerSeatId: reviewer,
          authorSeatId: author,
          epoch: 1,
          subjectHash: hash,
          reviewerNodeId: "reviewer",
        }),
      ],
    });
    const gate = reviewGateOf(task, undefined, author);
    expect(gate.satisfied).toBe(true);
    expect(gate.latestGreen?.verdictId).toBe("v3");
  });

  it("drops malformed verdicts instead of inventing them", () => {
    expect(parseReviewVerdict({ kind: "green" })).toBeUndefined();
    expect(
      parseReviewVerdict({
        verdictId: "v-guess",
        kind: "green",
        reviewerSeatId: seat("b"),
        subject: { kind: "task", taskId: "task-1", epoch: 1 },
        epoch: 1,
      }),
    ).toBeUndefined();
    expect(boardReviewGate(undefined).required).toBe(false);
  });

  it("binds on subject hash, never a bare task id", () => {
    const author = seat("a");
    const reviewer = seat("b");
    const task = taskOf({
      epoch: 1,
      claimedBy: author,
      rules: [{ id: "r-review", text: "Review", kind: "requires-review" }],
      subjectHash: hash,
      verdicts: [
        canonicalVerdict({
          verdictId: "v-canonical",
          kind: "green",
          reviewerSeatId: reviewer,
          authorSeatId: author,
          epoch: 1,
          subjectHash: "hash-other",
          reviewerNodeId: "reviewer",
        }),
      ],
    });
    expect(verdictsOnTask(task)[0]?.subject).toEqual({
      kind: "task",
      taskId: "task-1",
      epoch: 1,
      subjectHash: "hash-other",
    });
    expect(reviewGateOf(task, undefined, author).satisfied).toBe(false);
  });

  it("reads task.verdicts first and keeps metadata.verdicts as a fallback", () => {
    const author = seat("a");
    const reviewer = seat("b");
    const composed = canonicalVerdict({
      verdictId: "v-composed",
      kind: "green",
      reviewerSeatId: reviewer,
      authorSeatId: author,
      epoch: 1,
      subjectHash: hash,
    });
    const legacy = canonicalVerdict({
      verdictId: "v-legacy",
      kind: "blocking",
      reviewerSeatId: reviewer,
      authorSeatId: author,
      epoch: 1,
      subjectHash: hash,
    });
    const fromField = taskOf({
      epoch: 1,
      claimedBy: author,
      subjectHash: hash,
      verdicts: [composed],
      metadata: { verdicts: [legacy] },
    });
    expect(verdictsOnTask(fromField).map((row) => row.verdictId)).toEqual([
      "v-composed",
    ]);
    const fromLegacy = taskOf({
      epoch: 1,
      claimedBy: author,
      subjectHash: hash,
      metadata: { verdicts: [legacy] },
    });
    expect(verdictsOnTask(fromLegacy).map((row) => row.verdictId)).toEqual([
      "v-legacy",
    ]);
    const emptyComposed = taskOf({
      epoch: 1,
      claimedBy: author,
      subjectHash: hash,
      verdicts: [],
      metadata: { verdicts: [legacy] },
    });
    expect(verdictsOnTask(emptyComposed)).toEqual([]);
  });

  it("fails closed when reviewSubjectProjection omitted the hash", () => {
    const author = seat("a");
    const reviewer = seat("b");
    const task = taskOf({
      epoch: 1,
      claimedBy: author,
      rules: [{ id: "r-review", text: "Review", kind: "requires-review" }],
      verdicts: [
        canonicalVerdict({
          verdictId: "v-green",
          kind: "green",
          reviewerSeatId: reviewer,
          authorSeatId: author,
          epoch: 1,
          subjectHash: hash,
        }),
      ],
    });
    expect(reviewGateOf(task, undefined, author).satisfied).toBe(false);
  });
});
