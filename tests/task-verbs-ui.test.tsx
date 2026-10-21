/**
 * Tasks UI on the 0.10 model: which verbs and review controls draw is the
 * ruler's answer (task-ui.test.ts); here, that the surfaces draw exactly that
 * and nothing from the factory era.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskVerbBar } from "../src/renderer/components/work/TaskVerbBar";
import { TaskReviewers } from "../src/renderer/components/work/TaskReviewers";
import type { SeatChoice } from "../src/renderer/lib/task-ui";
import {
  seatNodeId,
  taskNodeId,
  type TaskActor,
  type TaskContext,
  type TaskCore,
} from "../src/shared/task-machine";

const ada = seatNodeId("seat-ada");
const bo = seatNodeId("seat-bo");
const seats: ReadonlyArray<SeatChoice> = [
  { node: ada, name: "Ada" },
  { node: bo, name: "Bo" },
];
const operator: TaskActor = { kind: "operator" };
const core = (over: Partial<TaskCore> = {}): TaskCore => ({
  state: "backlog",
  node: taskNodeId("tasks-build"),
  epoch: 0,
  stampPolicy: { required: 0 },
  reviewers: [],
  stamps: [],
  ...over,
});
const ctx: TaskContext = {
  taskId: "t1",
  at: 1,
  openTaskOf: () => undefined,
  downstream: [],
  stampDefaultOf: () => ({ required: 0 }),
};
const noop = () => undefined;
const verbsIn = (html: string): string[] =>
  [...html.matchAll(/data-testid="task-verb-([a-z]+)"/g)].map((m) => m[1] ?? "");

describe("TaskVerbBar", () => {
  it("draws assign and cancel on the backlog, with the assign picker", () => {
    const html = renderToStaticMarkup(
      <TaskVerbBar task={core()} actor={operator} ctx={ctx} seats={seats} numberOf={() => undefined} onCommand={noop} />,
    );
    expect(verbsIn(html)).toEqual(["assign", "cancel"]);
    expect(html).toContain("Assign to");
  });

  it("draws unassign and cancel on a working task for the operator", () => {
    const html = renderToStaticMarkup(
      <TaskVerbBar task={core({ state: "working", assignee: ada })} actor={operator} ctx={ctx} seats={seats} numberOf={() => undefined} onCommand={noop} />,
    );
    expect(verbsIn(html)).toEqual(["unassign", "cancel"]);
    expect(html).not.toContain("Assign to");
  });

  it("draws nothing for an archived task", () => {
    expect(
      renderToStaticMarkup(
        <TaskVerbBar task={core({ state: "archived" })} actor={operator} ctx={ctx} seats={seats} numberOf={() => undefined} onCommand={noop} />,
      ),
    ).toBe("");
  });
});

describe("TaskReviewers", () => {
  const inReview = core({
    state: "in-review",
    assignee: ada,
    reviewers: [bo],
    stampPolicy: { required: 1 },
  });

  it("shows the policy, the tally and a waiting reviewer", () => {
    const html = renderToStaticMarkup(
      <TaskReviewers task={inReview} actor={operator} ctx={ctx} seats={seats} onCommand={noop} />,
    );
    expect(html).toContain('data-required="1"');
    expect(html).toContain("0 of 1 approved");
    expect(html).toContain("waiting");
  });

  it("never draws stamp buttons: stamps come from reviewing seats", () => {
    const html = renderToStaticMarkup(
      <TaskReviewers task={inReview} actor={operator} ctx={ctx} seats={seats} onCommand={noop} />,
    );
    expect(html).not.toContain("task-stamp");
  });

  it("shows an approval from a reviewer", () => {
    const task = { ...inReview, stamps: [{ reviewer: bo, verdict: "approve" as const, epoch: 0, at: 1 }] };
    const html = renderToStaticMarkup(
      <TaskReviewers task={task} actor={operator} ctx={ctx} seats={seats} onCommand={noop} />,
    );
    expect(html).toContain("1 of 1 approved");
    expect(html).toContain('data-verdict="approve"');
  });

  it("says plainly when nothing is required, and freezes a closed task", () => {
    const html = renderToStaticMarkup(
      <TaskReviewers task={core({ state: "working", assignee: ada })} actor={operator} ctx={ctx} seats={seats} onCommand={noop} />,
    );
    expect(html).toContain("No reviewers. Finishing completes the task.");
    const done = renderToStaticMarkup(
      <TaskReviewers task={core({ state: "done", reviewers: [bo] })} actor={operator} ctx={ctx} seats={seats} onCommand={noop} />,
    );
    expect(done).not.toContain("Remove Bo");
    expect(done).not.toContain("Add reviewer");
  });
});
