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

const taskOf = (overrides: Partial<Task> = {}): Task => ({
  id: "task-1",
  state: "working",
  history: [],
  ...overrides,
});

describe("requires-review projection", () => {
  it("reads typed rule kind and contract flag, never a free-text guess", () => {
    const statement: Rule = { id: "r1", text: "Requires a distinct reviewer" };
    const typed = { id: "r2", text: "Review", kind: "requires-review" } as Rule;
    expect(contractRequiresReview({ rules: [statement] })).toBe(false);
    expect(contractRequiresReview({ rules: [typed] })).toBe(true);
    expect(
      contractRequiresReview({
        rules: [{ id: "r3", text: "Review", requiresReview: true } as Rule],
      }),
    ).toBe(true);
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
      metadata: {
        requiresReview: true,
        verdicts: [
          {
            verdictId: "v1",
            kind: "green",
            reviewerSeatId: reviewer,
            reviewerLabel: "Reviewer",
            subject: { kind: "task", taskId: "task-1", epoch: 1 },
            epoch: 1,
            findings: [],
            refs: [],
            postedAtMs: 10,
          },
          {
            verdictId: "v2",
            kind: "green",
            reviewerSeatId: author,
            reviewerLabel: "Author",
            subject: { kind: "task", taskId: "task-1", epoch: 2 },
            epoch: 2,
            findings: [],
            refs: [],
            postedAtMs: 20,
          },
        ],
      },
    });
    const gate = reviewGateOf(task, undefined, author);
    expect(gate.required).toBe(true);
    expect(gate.currentEpoch).toBe(2);
    expect(gate.satisfied).toBe(false);
    expect(verdictsOnTask(task)).toHaveLength(2);
  });

  it("satisfies only a distinct reviewer green on the current subject", () => {
    const author = seat("a");
    const reviewer = seat("b");
    const task = taskOf({
      epoch: 1,
      claimedBy: author,
      metadata: {
        requiresReview: true,
        verdicts: [
          {
            verdictId: "v3",
            kind: "green",
            reviewerSeatId: reviewer,
            reviewerLabel: "Reviewer",
            subject: { kind: "task", taskId: "task-1", epoch: 1 },
            epoch: 1,
            findings: [],
            refs: [{ kind: "commit", sha: "deadbeefcafebabe" }],
            postedAtMs: 30,
          },
        ],
      },
    });
    const gate = reviewGateOf(task, undefined, author);
    expect(gate.satisfied).toBe(true);
    expect(gate.latestGreen?.verdictId).toBe("v3");
  });

  it("drops malformed verdicts instead of inventing them", () => {
    expect(parseReviewVerdict({ kind: "green" })).toBeUndefined();
    expect(boardReviewGate(undefined).required).toBe(false);
  });
});
