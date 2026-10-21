/**
 * Tasks UI on the 0.10 model: which verbs and review controls draw is the
 * ruler's answer (task-ui.test.ts); here, that the surfaces draw exactly that
 * and nothing from the factory era.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/model";
import type { TaskContext } from "../src/shared/task-machine";
import { STAMPS_REQUIRED_MAX, seatNodeId, taskNodeId, type Reviewer, type TaskActor, type TaskCore } from "../src/shared/task-model";
import { ItemId } from "../src/shared/work-ids";
import { TaskVerbBar } from "../src/renderer/components/work/TaskVerbBar";
import { TaskReviewers } from "../src/renderer/components/work/TaskReviewers";
import type { SeatChoice } from "../src/renderer/lib/task-ui";
import { TaskControlsGallery } from "../src/renderer/components/gallery/TaskControlsGallery";

const ada = seatNodeId(asNodeId("seat-ada"));
const bo = seatNodeId(asNodeId("seat-bo"));
const qa = taskNodeId(asNodeId("tasks-qa"));
const ship = taskNodeId(asNodeId("tasks-ship"));
const seats: ReadonlyArray<SeatChoice> = [
  { node: ada, name: "Ada" },
  { node: bo, name: "Bo" },
];
const operator: TaskActor = { kind: "operator" };
const asSeat = (s: typeof ada): Reviewer => ({ kind: "seat", seat: s });
const core = (over: Partial<TaskCore> = {}): TaskCore => ({
  state: "backlog",
  node: taskNodeId(asNodeId("tasks-build")),
  epoch: 0,
  stampPolicy: { required: 0 },
  reviewers: [],
  stamps: [],
  ...over,
});
const ctx = (over: Partial<TaskContext> = {}): TaskContext => ({
  taskId: ItemId.make("01JZ0000000000000000000001"),
  at: 1,
  openTaskOf: () => undefined,
  downstream: [],
  stampDefaultOf: () => ({ required: 0 }),
  seatReaches: () => true,
  ...over,
});
const noop = () => undefined;
const verbsIn = (html: string): string[] =>
  [...html.matchAll(/data-testid="task-verb-([a-z]+)"/g)].map((m) => m[1] ?? "");

describe("TaskVerbBar", () => {
  it("draws assign and cancel on the backlog, with the assign picker", () => {
    const html = renderToStaticMarkup(
      <TaskVerbBar task={core()} actor={operator} ctx={ctx()} seats={seats} numberOf={() => undefined} onCommand={noop} />,
    );
    expect(verbsIn(html)).toEqual(["assign", "cancel"]);
    expect(html).toContain("Assign to");
  });

  it("draws unassign and cancel on a working task for the operator", () => {
    const html = renderToStaticMarkup(
      <TaskVerbBar task={core({ state: "working", assignee: ada })} actor={operator} ctx={ctx()} seats={seats} numberOf={() => undefined} onCommand={noop} />,
    );
    expect(verbsIn(html)).toEqual(["unassign", "cancel"]);
    expect(html).not.toContain("Assign to");
  });

  it("draws nothing for an archived task", () => {
    expect(
      renderToStaticMarkup(
        <TaskVerbBar task={core({ state: "archived" })} actor={operator} ctx={ctx()} seats={seats} numberOf={() => undefined} onCommand={noop} />,
      ),
    ).toBe("");
  });

  it("asks which node to send on to only when several are downstream", () => {
    const working = core({ state: "working", assignee: ada });
    const bar = (downstream: ReadonlyArray<typeof qa>) =>
      renderToStaticMarkup(
        <TaskVerbBar task={working} actor={{ kind: "seat", seat: ada }} ctx={ctx({ downstream })} seats={seats} numberOf={() => undefined} onCommand={noop} />,
      );
    expect(bar([qa])).not.toContain("Send on to");
    const two = bar([qa, ship]);
    expect(two).toContain("Send on to");
    expect(verbsIn(two)).toContain("finish");
  });
});

describe("TaskReviewers", () => {
  const inReview = core({
    state: "in-review",
    assignee: ada,
    reviewers: [asSeat(bo)],
    stampPolicy: { required: 1 },
  });
  const panel = (task: TaskCore, actor: TaskActor = operator) =>
    renderToStaticMarkup(<TaskReviewers task={task} actor={actor} ctx={ctx()} seats={seats} onCommand={noop} />);

  it("shows the policy, the tally and a waiting reviewer by name", () => {
    const html = panel(inReview);
    expect(html).toContain('data-required="1"');
    expect(html).toContain("0 of 1 approved");
    expect(html).toContain("Bo");
    expect(html).toContain("waiting");
  });

  it("gives the operator approve and changes while the task is in review", () => {
    const html = panel(inReview);
    expect(html).toContain("task-stamp-approve");
    expect(html).toContain("task-stamp-changes");
    expect(panel(core({ state: "working", assignee: ada }))).not.toContain("task-stamp-approve");
  });

  it("draws the operator as a reviewer, and an approval from a seat", () => {
    const task = core({
      ...inReview,
      reviewers: [{ kind: "operator" }, asSeat(bo)],
      stamps: [{ reviewer: asSeat(bo), verdict: "approve", epoch: 0, at: 1 }],
    });
    const html = panel(task);
    expect(html).toContain("You");
    expect(html).toContain("1 of 1 approved");
    expect(html).toContain('data-verdict="approve"');
  });

  it("stops the approval count at the wire maximum", () => {
    const full = panel(core({ state: "working", assignee: ada, stampPolicy: { required: STAMPS_REQUIRED_MAX } }));
    const plus = /<button[^>]*aria-label="Require one more approval"[^>]*>/.exec(full)?.[0] ?? "";
    expect(plus).toContain("disabled");
  });

  it("reads an ask for changes as the earlier round once the task works again", () => {
    const html = panel(
      core({
        state: "working",
        assignee: ada,
        epoch: 1,
        reviewers: [asSeat(bo)],
        stampPolicy: { required: 1 },
        stamps: [{ reviewer: asSeat(bo), verdict: "changes", epoch: 0, at: 1 }],
      }),
    );
    expect(html).toContain("asked for changes, earlier round");
    expect(html).not.toContain("no stamp yet");
  });

  it("says plainly when nothing is required, and freezes a closed task", () => {
    expect(panel(core({ state: "working", assignee: ada }))).toContain("No reviewers. Finishing completes the task.");
    expect(panel(core({ state: "canceled" }))).not.toContain("Finishing completes");
    const done = panel(core({ state: "done", reviewers: [asSeat(bo)] }));
    expect(done).not.toContain("Remove Bo");
    expect(done).not.toContain("Add reviewer");
  });
});

describe("TaskControlsGallery", () => {
  it("renders every case without throwing", () => {
    const html = renderToStaticMarkup(<TaskControlsGallery />);
    expect(html).toContain("Tasks controls");
    expect(html).toContain("you are a reviewer");
    expect(html).toContain("Canceled");
  });
});
