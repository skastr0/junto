import { useState } from "react";
import { asNodeId } from "@shared/model";
import { ruleTaskCommand, taskRefusalMessage, type TaskContext } from "@shared/task-machine";
import {
  seatNodeId,
  taskNodeId,
  type Reviewer,
  type TaskActor,
  type TaskCommand,
  type TaskCore,
} from "@shared/task-model";
import { ItemId } from "@shared/work-ids";
import { Eyebrow, TaskStateMark } from "../ui";
import { TaskVerbBar } from "../work/TaskVerbBar";
import { TaskReviewers } from "../work/TaskReviewers";
import type { SeatChoice } from "../../lib/task-ui";

/**
 * Dev gallery for the Tasks controls on the 0.10 model: the verb bar and the
 * reviewers panel in every state the ruler draws them differently. Route:
 * `#/gallery/tasks`. All data is made up. Commands are ruled by the real
 * task ruler against the case's own task, so a click moves it, or says why
 * the ruler refused.
 */
const ada = seatNodeId(asNodeId("seat-ada"));
const bo = seatNodeId(asNodeId("seat-bo"));
const cy = seatNodeId(asNodeId("seat-cy"));
const BUILD = taskNodeId(asNodeId("tasks-build"));
const QA = taskNodeId(asNodeId("tasks-qa"));
const SHIP = taskNodeId(asNodeId("tasks-ship"));
const HELD = ItemId.make("01JZ0000000000000000000009");
const THIS = ItemId.make("01JZ0000000000000000000001");

const SEATS: ReadonlyArray<SeatChoice> = [
  { node: ada, name: "product-modals" },
  { node: bo, name: "product-shell" },
  { node: cy, name: "product-typography" },
];
const NODE_NAMES = new Map<string, string>([
  [QA, "QA board"],
  [SHIP, "Ship board"],
]);
const OPERATOR: TaskActor = { kind: "operator" };
const asSeat = (seat: typeof ada): Reviewer => ({ kind: "seat", seat });

const ctxFor = (downstream: ReadonlyArray<typeof QA>): TaskContext => ({
  taskId: THIS,
  at: 1,
  openTaskOf: (seat) => (seat === bo ? HELD : undefined),
  downstream,
  stampDefaultOf: () => ({ required: 0 }),
  seatReaches: () => true,
});

const core = (over: Partial<TaskCore>): TaskCore => ({
  state: "backlog",
  node: BUILD,
  epoch: 0,
  stampPolicy: { required: 0 },
  reviewers: [],
  stamps: [],
  ...over,
});

type Case = {
  readonly label: string;
  readonly actor: TaskActor;
  readonly downstream: ReadonlyArray<typeof QA>;
  readonly task: TaskCore;
};

const CASES: ReadonlyArray<Case> = [
  { label: "Backlog", actor: OPERATOR, downstream: [], task: core({}) },
  { label: "Assigned", actor: OPERATOR, downstream: [], task: core({ state: "assigned", assignee: ada }) },
  {
    label: "Working, one reviewer, one approval required",
    actor: OPERATOR,
    downstream: [],
    task: core({
      state: "working",
      assignee: ada,
      reviewers: [asSeat(bo)],
      stampPolicy: { required: 1 },
    }),
  },
  {
    label: "Working, seen by its assignee, two boards downstream",
    actor: { kind: "seat", seat: ada },
    downstream: [QA, SHIP],
    task: core({ state: "working", assignee: ada }),
  },
  { label: "Paused", actor: OPERATOR, downstream: [], task: core({ state: "input-required", assignee: ada }) },
  {
    label: "In review, waiting on two reviewers",
    actor: OPERATOR,
    downstream: [],
    task: core({
      state: "in-review",
      assignee: ada,
      reviewers: [asSeat(bo), asSeat(cy)],
      stampPolicy: { required: 2 },
      stamps: [{ reviewer: asSeat(bo), verdict: "approve", epoch: 0, at: 1 }],
    }),
  },
  {
    label: "In review, you are a reviewer",
    actor: OPERATOR,
    downstream: [],
    task: core({
      state: "in-review",
      assignee: ada,
      reviewers: [{ kind: "operator" }, asSeat(bo)],
      stampPolicy: { required: 2 },
      stamps: [
        { reviewer: asSeat(bo), verdict: "changes", epoch: 0, at: 1, text: "The empty state still says Queue." },
      ],
    }),
  },
  {
    label: "Done",
    actor: OPERATOR,
    downstream: [],
    task: core({ state: "done", assignee: ada, reviewers: [asSeat(bo)] }),
  },
];

function Frame({ entry }: { readonly entry: Case }) {
  const [task, setTask] = useState(entry.task);
  const ctx = ctxFor(entry.downstream);
  const onCommand = (command: TaskCommand): string | undefined => {
    const ruling = ruleTaskCommand(task, entry.actor, command, ctx);
    if (!ruling.ok) return taskRefusalMessage(ruling.refusal.detail);
    setTask(ruling.task);
    return undefined;
  };
  return (
    <section className="grid gap-2">
      <Eyebrow>{entry.label}</Eyebrow>
      <TaskStateMark state={task.state} withLabel />
      <div className="grid gap-3 rounded-lg border border-stroke bg-raise p-3">
        <TaskVerbBar
          task={task}
          actor={entry.actor}
          ctx={ctx}
          seats={SEATS}
          numberOf={(id) => (id === HELD ? "T-12" : undefined)}
          nodeName={(node) => NODE_NAMES.get(node) ?? node}
          onCommand={onCommand}
        />
        <TaskReviewers task={task} actor={entry.actor} ctx={ctx} seats={SEATS} onCommand={onCommand} />
      </div>
    </section>
  );
}

export function TaskControlsGallery() {
  return (
    <main className="mx-auto grid max-w-xl gap-5 p-6 text-ink" data-testid="task-controls-gallery">
      <h1 className="m-0 text-lg font-semibold">Tasks controls</h1>
      {CASES.map((entry) => (
        <Frame key={entry.label} entry={entry} />
      ))}
    </main>
  );
}
