/**
 * Crew reviews — a requires-review contract gates task completion on a
 * distinct reviewer's green verdict over the exact epoch + subject [fake-tui].
 *
 * The authority is the directed reviews edge reviewer -> author: without it
 * verdict.post is ScopeError, with it a green satisfies the gate and a
 * blocking verdict sends the task back with a defect and a bumped epoch.
 * Every refusal class is exercised at the wire: ReviewerIsAuthor,
 * reviews-edge-missing, stale-subject, author-unresolved, malformed-verdict.
 *
 * Laws covered:
 *   1. A requires-review rule refuses completion until a distinct reviewer
 *      posts green on the current epoch + subjectHash — the gate evaluates
 *      the subject as it will exist once completion lands;
 *   2. self-review is ReviewerIsAuthor even when the author could name an
 *      edge; a missing directed reviews edge is ScopeError;
 *   3. blocking verdicts send the task back in place at epoch+1 with a
 *      defect log entry, and a green minted at the old epoch can never
 *      bless the new subject — the reviewer re-reads and posts again;
 *   4. verdict.post is compare-and-swap: a stale epoch/subjectHash pair is
 *      InputError/stale-subject carrying expected + received, never a
 *      silent re-bind of an old judgment onto new refs;
 *   5. malformed verdicts (blocking without findings), unknown tasks, and
 *      subjects with no author provenance are refused with named reasons.
 */
import { expect, launchJunto, test } from "../harness/launch";
import {
  crewOccupySeat,
  crewPlayFactory,
  crewMutateCanvas,
  crewReviewsEdge,
  crewRule,
  crewSeat,
  crewSeatNode,
  crewDoc,
  crewTasksNode,
  crewVerdicts,
  crewWorksEdge,
  installCrewSeatHarness,
  type WorkEnvelope,
} from "../harness/crew-fixture";
import { taskItem } from "../harness/sandbox";
import { crewManagesEdge } from "../harness/crew-fixture";

const CANVAS = "crew-reviews";
const A = "seat-a";
const R = "seat-r";
const SINK = "sink";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const seatA = crewSeatNode({ id: A, x: 40, y: 40 });
const seatR = crewSeatNode({ id: R, x: 360, y: 40 });
const sink = crewTasksNode({
  id: SINK,
  x: 640,
  y: 40,
  items: [
    taskItem("task-1", "review me before merge"),
    // waitUntil far in the future keeps this row in waiting admission — the
    // factory claim cycle skips it, so no seat ever becomes its author.
    {
      ...taskItem("task-2", "nobody claimed me"),
      waitUntil: "2999-01-01T00:00:00.000Z",
    },
  ],
  contract: {
    rules: [
      crewRule(
        "rule-rr",
        "A distinct reviewer must record green on the current epoch.",
        "requires-review",
      ),
    ],
  },
});

const reviewDoc = (withReviewsEdge: boolean) =>
  crewDoc(
    [seatA, seatR, sink],
    [
      crewWorksEdge("w-sink-a", SINK, A, [seatA, seatR, sink]),
      // manages, not works: the reviewer reads tasks.show/tasks.wait through
      // tasks.list but is never claimable, so task authorship stays with A.
      crewManagesEdge("m-r", R, SINK, [seatA, seatR, sink]),
      ...(withReviewsEdge
        ? [crewReviewsEdge("e-rev", R, A, [seatA, seatR, sink])]
        : []),
    ],
  );

const opData = (env: WorkEnvelope): Record<string, unknown> => {
  expect(env.ok, JSON.stringify(env)).toBe(true);
  if (!env.ok) throw new Error("unreachable");
  return (env.data ?? {}) as Record<string, unknown>;
};

const opErr = (
  env: WorkEnvelope,
): Extract<WorkEnvelope, { readonly ok: false }>["error"] => {
  expect(env.ok, JSON.stringify(env)).toBe(false);
  if (env.ok) throw new Error("unreachable");
  return env.error;
};

type ReviewSubject = {
  readonly epoch: number;
  readonly subjectHash: string;
  readonly taskId?: string;
  readonly authorSeatId?: string;
};

/** tasks.show -> the subject a reviewer judges (epoch + subjectHash CAS). */
const showSubject = async (
  seat: ReturnType<typeof crewSeat>,
  taskId: string,
): Promise<ReviewSubject> => {
  const env = await seat.op("tasks.show", { target: SINK, task: taskId });
  const data = opData(env) as { reviewSubject: ReviewSubject };
  return data.reviewSubject;
};

const showTask = async (
  seat: ReturnType<typeof crewSeat>,
  taskId: string,
) => {
  const env = await seat.op("tasks.show", { target: SINK, task: taskId });
  return opData(env) as {
    task: {
      id: string;
      state: string;
      epoch?: number;
      defects?: ReadonlyArray<{ epoch: number; target: string; at: string }>;
      visits?: ReadonlyArray<{ board: string; exit?: string }>;
      history?: ReadonlyArray<{ parts?: ReadonlyArray<{ text?: string }> }>;
    };
  };
};

const launch = (withReviewsEdge: boolean) =>
  launchJunto({
    seedCanvases: { [CANVAS]: reviewDoc(withReviewsEdge) },
    afterSeed: installCrewSeatHarness,
  });

const boot = async (junto: Awaited<ReturnType<typeof launch>>) => {
  const { page, sandbox } = junto;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await crewPlayFactory(page);
  const a = crewSeat(sandbox, CANVAS, A);
  const r = crewSeat(sandbox, CANVAS, R);
  await crewOccupySeat(page, CANVAS, seatA, a);
  await crewOccupySeat(page, CANVAS, seatR, r);
  return { page, sandbox, a, r };
};

const claimAndStage = async (
  a: ReturnType<typeof crewSeat>,
  sha: string,
) => {
  const claim = await a.op("tasks.claim", { target: SINK, task: "task-1" });
  expect(claim.ok, JSON.stringify(claim)).toBe(true);
  const staged = await a.op("tasks.update", {
    target: SINK,
    task: "task-1",
    state: "working",
    completionEvidence: { artifacts: [], git: { commits: [sha] } },
  });
  expect(staged.ok, JSON.stringify(staged)).toBe(true);
};

test("crew reviews [fake-tui]: requires-review gates completion on a distinct green", async () => {
  test.setTimeout(300_000);
  const junto = await launch(false);
  try {
    const { page, sandbox, a, r } = await boot(junto);
    await claimAndStage(a, SHA_A);

    // The gate refuses completion — and hands back the exact subject a
    // reviewer must judge (epoch + subjectHash of the would-be completion).
    const blocked = await a.op("tasks.update", {
      target: SINK,
      task: "task-1",
      state: "completed",
    });
    const blockedErr = opErr(blocked);
    expect(blockedErr.type).toBe("InputError");
    expect(blockedErr.details?.reason).toBe("review-required");
    const gated = (blockedErr.details?.received as {
      subject: ReviewSubject;
    }).subject;
    expect(gated.epoch).toBe(0);
    expect(gated.subjectHash).toMatch(/^[a-f0-9]{64}$/);

    // The author cannot review its own work — even with no edge question.
    const selfReview = await a.op("verdict.post", {
      target: SINK,
      subject: { kind: "task", taskId: "task-1", epoch: gated.epoch, subjectHash: gated.subjectHash },
      kind: "green",
    });
    expect(opErr(selfReview).type).toBe("ReviewerIsAuthor");

    // The reviewer holds no reviews edge yet — authority is the edge.
    const noEdge = await r.op("verdict.post", {
      target: SINK,
      subject: { kind: "task", taskId: "task-1", epoch: gated.epoch, subjectHash: gated.subjectHash },
      kind: "green",
    });
    const noEdgeErr = opErr(noEdge);
    expect(noEdgeErr.type).toBe("ScopeError");
    expect(noEdgeErr.details?.reason).toBe("reviews-edge-missing");

    // The operator draws the directed reviews edge reviewer -> author.
    await crewMutateCanvas(page, CANVAS, (doc) => ({
      ...doc,
      edges: [
        ...doc.edges,
        crewReviewsEdge("e-rev", R, A, [seatA, seatR, sink]),
      ],
    }));

    // The reviewer reads the current subject, then posts green on it.
    const subject = await showSubject(r, "task-1");
    expect(subject.epoch).toBe(gated.epoch);
    expect(subject.subjectHash).toBe(gated.subjectHash);
    const green = await r.op("verdict.post", {
      target: SINK,
      subject: { kind: "task", taskId: "task-1", epoch: subject.epoch, subjectHash: subject.subjectHash },
      kind: "green",
    });
    const greenData = opData(green) as {
      verdictId: string;
      effect: string;
      epoch: number;
    };
    expect(greenData.verdictId.length).toBeGreaterThan(0);
    expect(greenData.effect).toBe("none");

    // The same completion now lands — the green armed the exact subject.
    const done = await a.op("tasks.update", {
      target: SINK,
      task: "task-1",
      state: "completed",
    });
    expect(done.ok, JSON.stringify(done)).toBe(true);

    // The verdict is durable: one green row bound to epoch 0 + the subject.
    const verdicts = await crewVerdicts(page, CANVAS);
    expect(verdicts).toHaveLength(1);
    const [row] = verdicts;
    expect(row!.kind).toBe("green");
    expect(row!.subject.kind).toBe("task");
    if (row!.subject.kind === "task") {
      expect(row!.subject.taskId).toBe("task-1");
      expect(row!.subject.epoch).toBe(0);
    }
    expect(row!.epoch).toBe(0);
    expect(row!.subjectHash).toBe(subject.subjectHash);
    expect(row!.reviewerSeatId).not.toBe(row!.authorSeatId);
  } finally {
    await junto.close();
  }
});

test("crew reviews [fake-tui]: blocking sends back with defect; old green cannot bless new refs", async () => {
  test.setTimeout(300_000);
  const junto = await launch(true);
  try {
    const { page, a, r } = await boot(junto);
    await claimAndStage(a, SHA_A);

    // Reviewer reads the staged subject and greens it.
    const first = await showSubject(r, "task-1");
    const green = await r.op("verdict.post", {
      target: SINK,
      subject: { kind: "task", taskId: "task-1", epoch: first.epoch, subjectHash: first.subjectHash },
      kind: "green",
    });
    expect(green.ok, JSON.stringify(green)).toBe(true);

    // Then posts blocking on the same subject — findings are the defect.
    const blocking = await r.op("verdict.post", {
      target: SINK,
      subject: { kind: "task", taskId: "task-1", epoch: first.epoch, subjectHash: first.subjectHash },
      kind: "blocking",
      findings: ["no tests cover the merge path"],
      refs: [{ kind: "commit", sha: SHA_A }],
    });
    const blockingData = opData(blocking) as {
      effect: string;
      newEpoch?: number;
    };
    expect(blockingData.effect).toBe("rejected");
    expect(blockingData.newEpoch).toBe(1);

    // Send-back evidence: the re-homed row is submitted at epoch+1 with a
    // defect tail and a sent-back visit; the findings land in history.
    const after = await showTask(a, "task-1");
    expect(after.task.state).toBe("submitted");
    expect(after.task.epoch).toBe(1);
    expect(after.task.defects?.at(-1)).toMatchObject({
      epoch: 1,
      target: SINK,
    });
    expect(after.task.visits?.at(-2)?.exit).toBe("sent-back");
    expect(after.task.visits?.at(-1)?.exit).toBeUndefined();
    const historyText = (after.task.history ?? [])
      .flatMap((entry) => entry.parts ?? [])
      .map((part) => part.text ?? "")
      .join("\n");
    expect(historyText).toContain("defect from");
    expect(historyText).toContain("no tests cover the merge path");

    // Both verdicts are durable — the blocking row carries findings + refs.
    const rows = await crewVerdicts(page, CANVAS);
    expect(rows.map((row) => row.kind)).toEqual(["green", "blocking"]);
    const blockingRow = rows[1]!;
    expect(blockingRow.findings).toEqual(["no tests cover the merge path"]);
    expect(blockingRow.refs).toEqual([{ kind: "commit", sha: SHA_A }]);
    expect(blockingRow.epoch).toBe(0);

    // The fix: the author re-claims at the new epoch and stages new refs.
    await claimAndStage(a, SHA_B);

    // The epoch-0 green cannot bless the new subject — still gated.
    const stillBlocked = await a.op("tasks.update", {
      target: SINK,
      task: "task-1",
      state: "completed",
    });
    expect(opErr(stillBlocked).details?.reason).toBe("review-required");

    // A stale post is refused with expected + received, never re-bound.
    const stale = await r.op("verdict.post", {
      target: SINK,
      subject: { kind: "task", taskId: "task-1", epoch: first.epoch, subjectHash: first.subjectHash },
      kind: "green",
    });
    const staleErr = opErr(stale);
    expect(staleErr.type).toBe("InputError");
    expect(staleErr.details?.reason).toBe("stale-subject");
    expect(staleErr.details?.retryable).toBe(true);
    const expected = staleErr.details?.expected as {
      epoch: number;
      subjectHash: string;
    };
    const received = staleErr.details?.received as {
      epoch: number;
      subjectHash: string;
    };
    expect(expected.epoch).toBe(0);
    expect(received.epoch).toBe(1);

    // The reviewer re-reads the current subject and greens it.
    const second = await showSubject(r, "task-1");
    expect(second.epoch).toBe(1);
    expect(second.subjectHash).not.toBe(first.subjectHash);
    const regreen = await r.op("verdict.post", {
      target: SINK,
      subject: { kind: "task", taskId: "task-1", epoch: second.epoch, subjectHash: second.subjectHash },
      kind: "green",
    });
    expect(regreen.ok, JSON.stringify(regreen)).toBe(true);

    const done = await a.op("tasks.update", {
      target: SINK,
      task: "task-1",
      state: "completed",
    });
    expect(done.ok, JSON.stringify(done)).toBe(true);
    expect(await crewVerdicts(page, CANVAS)).toHaveLength(3);
  } finally {
    await junto.close();
  }
});

test("crew reviews [fake-tui]: malformed, unknown, and authorless verdicts refused", async () => {
  test.setTimeout(300_000);
  const junto = await launch(true);
  try {
    const { a, r } = await boot(junto);
    await claimAndStage(a, SHA_A);

    const subject = await showSubject(r, "task-1");

    // A blocking verdict must name its defect — findings are required.
    const malformed = await r.op("verdict.post", {
      target: SINK,
      subject: { kind: "task", taskId: "task-1", epoch: subject.epoch, subjectHash: subject.subjectHash },
      kind: "blocking",
      findings: [],
    });
    const malformedErr = opErr(malformed);
    expect(malformedErr.type).toBe("InputError");
    expect(malformedErr.details?.reason).toBe("malformed-verdict");

    // A subject the board does not carry is unknown, not silently minted.
    const unknown = await r.op("verdict.post", {
      target: SINK,
      subject: {
        kind: "task",
        taskId: "task-ghost",
        epoch: 0,
        subjectHash: "0".repeat(64),
      },
      kind: "green",
    });
    expect(opErr(unknown).type).toBe("UnknownTarget");

    // task-2 was never claimed: a well-formed subject still cannot name an
    // author, so the verdict waits on provenance, not on the reviewer.
    const unclaimed = await showSubject(r, "task-2");
    expect(unclaimed.authorSeatId).toBeUndefined();
    const authorless = await r.op("verdict.post", {
      target: SINK,
      subject: { kind: "task", taskId: "task-2", epoch: unclaimed.epoch, subjectHash: unclaimed.subjectHash },
      kind: "green",
    });
    const authorlessErr = opErr(authorless);
    expect(authorlessErr.type).toBe("InputError");
    expect(authorlessErr.details?.reason).toBe("author-unresolved");
    expect(authorlessErr.details?.retryable).toBe(true);
  } finally {
    await junto.close();
  }
});
