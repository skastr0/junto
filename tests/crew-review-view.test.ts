import { describe, expect, it } from "vitest";
import type { Rule, Task, TaskRule } from "../src/shared/work-model";
import {
  boardReviewGate,
  contractRequiresReview,
  parseReviewVerdict,
  reviewGateOf,
  verdictsOnTask,
  withRequiresReviewRule,
  type TaskReviewShow,
} from "../src/renderer/lib/crew-review-view";

const seat = (n: string): Task["claimedBy"] =>
  `seat_${n.repeat(64)}` as Task["claimedBy"];

/** Canvas projection: task.verdicts + task.subjectHash. Not metadata. */
const projectedTask = (
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

const reviewTaskRule = (id = "r-review"): TaskRule => ({
  id,
  text: "Review",
  kind: "requires-review",
  board: "tasks",
});

const canonicalVerdict = (input: {
  readonly verdictId: string;
  readonly kind: "green" | "blocking";
  readonly reviewerSeatId: Task["claimedBy"];
  readonly authorSeatId: Task["claimedBy"];
  readonly epoch: number;
  readonly subjectHash: string;
  readonly reviewerNodeId?: string;
  readonly postedAtMs?: number;
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
  postedAtMs: input.postedAtMs ?? 10,
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
    const task = projectedTask({
      epoch: 2,
      claimedBy: author,
      rules: [reviewTaskRule()],
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
    const task = projectedTask({
      epoch: 1,
      claimedBy: author,
      rules: [reviewTaskRule()],
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
    const task = projectedTask({
      epoch: 1,
      claimedBy: author,
      rules: [reviewTaskRule()],
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

  it("ignores metadata.verdicts and empty task.verdicts", () => {
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
    const invented = canonicalVerdict({
      verdictId: "v-metadata",
      kind: "blocking",
      reviewerSeatId: reviewer,
      authorSeatId: author,
      epoch: 1,
      subjectHash: hash,
    });
    const fromField = projectedTask({
      epoch: 1,
      claimedBy: author,
      subjectHash: hash,
      verdicts: [composed],
      metadata: { verdicts: [invented] },
    });
    expect(verdictsOnTask(fromField).map((row) => row.verdictId)).toEqual([
      "v-composed",
    ]);
    expect(
      verdictsOnTask(
        projectedTask({
          epoch: 1,
          claimedBy: author,
          metadata: { verdicts: [invented] },
        }),
      ),
    ).toEqual([]);
    expect(
      verdictsOnTask(
        projectedTask({
          epoch: 1,
          claimedBy: author,
          subjectHash: hash,
          verdicts: [],
          metadata: { verdicts: [invented] },
        }),
      ),
    ).toEqual([]);
  });

  it("fails closed when task.subjectHash is omitted", () => {
    const author = seat("a");
    const reviewer = seat("b");
    const task = projectedTask({
      epoch: 1,
      claimedBy: author,
      rules: [reviewTaskRule()],
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

  it("refuses a green once the current reviews edge is gone", () => {
    const author = seat("a");
    const reviewer = seat("b");
    const task = projectedTask({
      epoch: 1,
      claimedBy: author,
      rules: [reviewTaskRule()],
      subjectHash: hash,
      verdicts: [
        canonicalVerdict({
          verdictId: "v-edge",
          kind: "green",
          reviewerSeatId: reviewer,
          authorSeatId: author,
          epoch: 1,
          subjectHash: hash,
        }),
      ],
    });
    expect(
      reviewGateOf(task, undefined, author, {
        reviewerHasCurrentEdge: () => false,
      }).satisfied,
    ).toBe(false);
    expect(
      reviewGateOf(task, undefined, author, {
        reviewerHasCurrentEdge: (seatId) => seatId === reviewer,
      }).satisfied,
    ).toBe(true);
  });

  it("still reads a WorkTaskShow overlay until the canvas item is stamped", () => {
    const author = seat("a");
    const reviewer = seat("b");
    const task = projectedTask({
      epoch: 1,
      claimedBy: author,
      rules: [reviewTaskRule()],
    });
    const show: TaskReviewShow = {
      reviewSubject: {
        epoch: 1,
        subjectHash: hash,
        taskId: "task-1",
      },
      verdicts: [
        canonicalVerdict({
          verdictId: "v-show",
          kind: "green",
          reviewerSeatId: reviewer,
          authorSeatId: author,
          epoch: 1,
          subjectHash: hash,
        }),
      ],
    };
    expect(reviewGateOf(task, undefined, author, { show }).satisfied).toBe(true);
    expect(verdictsOnTask(task, show)[0]?.verdictId).toBe("v-show");
  });
});
