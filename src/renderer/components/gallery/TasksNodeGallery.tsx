import { useEffect, useMemo, useState } from "react";
import { asNodeId } from "@shared/model";
import { mintItemId, mintOpId } from "@shared/resource-command";
import { seatNodeId, taskNodeId, type TaskId } from "@shared/task-model";
import { makeLocalTasksSource, setTasksSource } from "../../lib/tasks-source";
import type { SeatChoice } from "../../lib/task-ui";
import { TasksNode } from "../tasks/TasksNode";
import type { TaskCanvasFacts } from "../tasks/tasks-pane-model";

/**
 * Dev gallery for the Tasks node on the 0.10 model. Route:
 * `#/gallery/tasks-node`. The tasks are made up and live in this window's
 * local source, ruled by the real task domain: assign, start (as the seat),
 * finish and send on all work, and a refusal reads as the ruler's.
 */
const ada = seatNodeId(asNodeId("seat-ada"));
const bo = seatNodeId(asNodeId("seat-bo"));
const cy = seatNodeId(asNodeId("seat-cy"));
const BUILD = taskNodeId(asNodeId("tasks-build"));
const QA = taskNodeId(asNodeId("tasks-qa"));
const CANVAS = "gallery";

const SEATS: ReadonlyArray<SeatChoice> = [
  { node: ada, name: "product-modals" },
  { node: bo, name: "product-shell" },
  { node: cy, name: "product-typography" },
];
const NODE_NAMES: Readonly<Record<string, string>> = { [BUILD]: "Build board", [QA]: "QA board" };

const FACTS: TaskCanvasFacts = {
  downstream: (node) => (node === BUILD ? [QA] : []),
  stampDefaultOf: (node) => ({ required: node === QA ? 1 : 0 }),
  seatReaches: () => true,
};

export const GALLERY_CANVAS = CANVAS;
export const GALLERY_BUILD = BUILD;
export const GALLERY_QA = QA;

export const seed = async (): Promise<void> => {
  const source = makeLocalTasksSource(FACTS);
  const asSeat = (seat: typeof ada) => source.as({ kind: "seat", seat });
  const make = async (title: string, body?: string): Promise<TaskId> => {
    const taskId = mintItemId() as TaskId;
    await source.apply(CANVAS, BUILD, taskId, { kind: "create", taskId, title, ...(body ? { body } : {}) });
    return taskId;
  };
  const sent = await make("Tasks controls on the new model", "Verb bar, reviewers, stamps.");
  await source.apply(CANVAS, BUILD, sent, { kind: "assign", seat: ada });
  await asSeat(ada).apply(CANVAS, BUILD, sent, { kind: "start" });
  await asSeat(ada).apply(CANVAS, BUILD, sent, { kind: "finish" });
  const working = await make("Tasks node on the local source");
  await source.apply(CANVAS, BUILD, working, { kind: "assign", seat: bo });
  await asSeat(bo).apply(CANVAS, BUILD, working, { kind: "start" });
  const review = await make("Delete the factory-era admission UI");
  await source.apply(CANVAS, BUILD, review, { kind: "reviewer-add", reviewer: { kind: "seat", seat: bo } });
  await source.apply(CANVAS, BUILD, review, { kind: "reviewer-add", reviewer: { kind: "operator" } });
  await source.apply(CANVAS, BUILD, review, { kind: "stamp-policy", required: 2 });
  await source.apply(CANVAS, BUILD, review, { kind: "assign", seat: ada });
  await asSeat(ada).apply(CANVAS, BUILD, review, { kind: "start" });
  await asSeat(ada).apply(CANVAS, BUILD, review, { kind: "finish" });
  await asSeat(bo).apply(CANVAS, BUILD, review, { kind: "stamp", verdict: "approve" });
  await make("Wire the board to the real source");
  await make("Move task numbers into mentions");
  // This machine's queued writes, as main would report them: a create that has no
  // ruling yet, and a pause waiting on the working task.
  const queuedTitle = "Draft the release notes";
  const queuedId = mintItemId() as TaskId;
  setTasksSource({
    ...source,
    pending: async () => [
      {
        opId: mintOpId(),
        taskId: queuedId,
        command: { kind: "create", taskId: queuedId, title: queuedTitle },
      },
      { opId: mintOpId(), taskId: working, command: { kind: "pause" } },
    ],
  });
};

export function TasksNodeGallery() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void seed().then(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, []);
  const nodeName = useMemo(() => (node: string): string => NODE_NAMES[node] ?? node, []);
  if (!ready) return null;
  return (
    <TasksNode
      canvasName={CANVAS}
      node={BUILD}
      seats={SEATS}
      nodeName={nodeName}
      onClose={() => undefined}
    />
  );
}
