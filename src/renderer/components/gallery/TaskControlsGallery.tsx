import { useState } from "react";
import { Eyebrow, TaskStateMark } from "../ui";
import { TaskVerbBar } from "../work/TaskVerbBar";
import { TaskReviewers } from "../work/TaskReviewers";
import {
  seatNodeId,
  taskNodeId,
  type TaskActor,
  type TaskCommand,
  type TaskContext,
  type TaskCore,
} from "@shared/task-machine";
import type { SeatChoice } from "../../lib/task-ui";

/**
 * Dev gallery for the Tasks controls on the 0.10 model: the verb bar and the
 * reviewers panel in every state the ruler draws them differently. Route:
 * `#/gallery/tasks`. All data is made up; commands only show what would be sent.
 */
const ada = seatNodeId("seat-ada");
const bo = seatNodeId("seat-bo");
const cy = seatNodeId("seat-cy");
const SEATS: ReadonlyArray<SeatChoice> = [
  { node: ada, name: "product-modals" },
  { node: bo, name: "product-shell" },
  { node: cy, name: "product-typography" },
];
const OPERATOR: TaskActor = { kind: "operator" };
const NAMES = new Map<string, string>([["task-held", "T-12"]]);
const CTX: TaskContext = {
  taskId: "task-1",
  at: 1,
  openTaskOf: (seat) => (seat === bo ? "task-held" : undefined),
  downstream: [],
  stampDefaultOf: () => ({ required: 0 }),
};
const core = (over: Partial<TaskCore>): TaskCore => ({
  state: "backlog",
  node: taskNodeId("tasks-build"),
  epoch: 0,
  stampPolicy: { required: 0 },
  reviewers: [],
  stamps: [],
  ...over,
});

const CASES: ReadonlyArray<{ readonly label: string; readonly task: TaskCore }> = [
  { label: "Backlog", task: core({}) },
  { label: "Assigned", task: core({ state: "assigned", assignee: ada }) },
  {
    label: "Working, one reviewer, one approval required",
    task: core({ state: "working", assignee: ada, reviewers: [bo], stampPolicy: { required: 1 } }),
  },
  { label: "Paused", task: core({ state: "input-required", assignee: ada }) },
  {
    label: "In review, waiting on two reviewers",
    task: core({
      state: "in-review",
      assignee: ada,
      reviewers: [bo, cy],
      stampPolicy: { required: 2 },
      stamps: [{ reviewer: bo, verdict: "approve", epoch: 0, at: 1 }],
    }),
  },
  {
    label: "In review, changes asked",
    task: core({
      state: "in-review",
      assignee: ada,
      reviewers: [bo],
      stampPolicy: { required: 1 },
      stamps: [{ reviewer: bo, verdict: "changes", epoch: 0, at: 1, text: "The empty state still says Queue." }],
    }),
  },
  { label: "Done", task: core({ state: "done", assignee: ada, reviewers: [bo] }) },
];

function Case({ label, task }: { readonly label: string; readonly task: TaskCore }) {
  const [last, setLast] = useState<TaskCommand | undefined>();
  return (
    <section className="grid gap-2">
      <Eyebrow>{label}</Eyebrow>
      <TaskStateMark state={task.state} withLabel />
      <div className="grid gap-3 rounded-lg border border-stroke bg-raise p-3">
        <TaskVerbBar
          task={task}
          actor={OPERATOR}
          ctx={CTX}
          seats={SEATS}
          numberOf={(id) => NAMES.get(id)}
          onCommand={setLast}
        />
        <TaskReviewers task={task} actor={OPERATOR} ctx={CTX} seats={SEATS} onCommand={setLast} />
        <p className="m-0 text-caption text-faint">
          {last === undefined ? "Nothing sent." : `Would send ${JSON.stringify(last)}`}
        </p>
      </div>
    </section>
  );
}

export function TaskControlsGallery() {
  return (
    <main className="mx-auto grid max-w-xl gap-5 p-6 text-ink" data-testid="task-controls-gallery">
      <h1 className="m-0 text-lg font-semibold">Tasks controls</h1>
      {CASES.map((entry) => (
        <Case key={entry.label} {...entry} />
      ))}
    </main>
  );
}
