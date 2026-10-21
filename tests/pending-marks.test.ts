/**
 * `junto task list|show` and `junto artifact list|show` mark an item that one
 * of this machine's queued writes touches, with its at-risk state (plan 02
 * audit item 3), and tasks have the overlay reader artifacts have: `op show`,
 * `op list` and the window read a queued task write's overlay.
 */
import { Effect, Exit, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import type { ActorSeatId } from "../src/shared/actor-seat";
import type { QueuedCommand } from "../src/shared/command-row";
import { ARTIFACTS_ENABLED, TASKS_ENABLED } from "../src/shared/features";
import type { InstallationId } from "../src/shared/installation-id";
import type { Canvas } from "../src/shared/model";
import { pendingMarks, type OpOverlay, type PendingMark } from "../src/shared/op-control";
import { asNodeId } from "../src/shared/physics/schema";
import { mintItemId, mintOpId, type ItemId, type OpId, type PendingEntry } from "../src/shared/resource-command";
import { taskNodeId, type TaskView } from "../src/shared/task-model";
import { TaskNumber } from "../src/shared/work-ids";
import { handleArtifactOp, type ArtifactCaller, type ArtifactPorts } from "../src/main/junto/work/artifact-control";
import { ArtifactRepository } from "../src/main/junto/work/artifact-repository";
import { handleOpOp, pendingMarksOf, queuedOverlays } from "../src/main/junto/work/op-control";
import { OpRepository } from "../src/main/junto/work/op-repository";
import { handleTaskOp, type TaskCaller, type TaskPorts } from "../src/main/junto/work/task-control";
import { TaskRepository } from "../src/main/junto/work/task-repository";

const box = (x: number, y: number, width = 50, height = 50) => ({ x, y, width, height });
const canvas = {
  nodes: new Map(
    [
      { id: "R", kind: "region", label: "R", ...box(0, 0, 500, 500) },
      { id: "seat-a", kind: "agent", label: "alpha", agentKey: "a", ...box(10, 10) },
      { id: "tasks-1", kind: "task", name: "CLI tasks", ...box(200, 200) },
      { id: "docs", kind: "artifacts", name: "Docs", ...box(300, 300) },
    ].map((node) => [node.id, node]),
  ),
  wires: new Map(),
} as unknown as Canvas;

const seat = { kind: "seat" as const, seatId: "seat-generation-a" as ActorSeatId, nodeId: asNodeId("seat-a") };
const mini = "mini" as InstallationId;
const tnode = taskNodeId(asNodeId("tasks-1"));

const T1 = mintItemId();
const T2 = mintItemId();
const view = (taskId: ItemId, number: number): TaskView => ({
  taskId,
  number: TaskNumber.make(number),
  title: "Ship it",
  current: { state: "backlog", node: tnode, epoch: 0, stampPolicy: { required: 0 }, reviewers: [], stamps: [] },
  layers: [],
  dependsOn: [],
  createdAt: 1,
  updatedAt: 1,
  stateSince: 1,
});

const queued = (kind: "task" | "artifact", itemId: ItemId, op: unknown): QueuedCommand =>
  ({ opId: mintOpId(), canvasName: "factory", actor: seat, target: { kind, nodeId: asNodeId(kind === "task" ? "tasks-1" : "docs"), itemId }, basis: null, after: [], op }) as never;

describe("pendingMarks", () => {
  const A = mintItemId();
  const B = mintItemId();
  const first = queued("task", A, { kind: "start" });
  const second = queued("task", A, { kind: "pause" });
  const third = queued("task", A, { kind: "resume" });
  const other = queued("artifact", B, { op: "archive" });
  const refusal = { reason: "invalid_transition", message: "This task is canceled, so it cannot be paused" } as const;

  it("marks each item a queued write of the kind touches, and only those", () => {
    const marks = pendingMarks([first, other], new Map(), "task");
    expect([...marks]).toEqual([[A, { pending: true }]]);
  });

  it("names the first write in queue order the overlay reads at risk, refused or waiting", () => {
    const overlays = new Map<OpId, OpOverlay>([
      [first.opId, { status: "pending" }],
      [second.opId, { status: "at_risk", refusal }],
      [third.opId, { status: "at_risk", waiting: "base_not_pulled", root: third.opId }],
    ]);
    expect(pendingMarks([first, second, third], overlays, "task").get(A)).toEqual({ pending: true, atRisk: { opId: second.opId, refusal } });
    expect(pendingMarks([first, third], overlays, "task").get(A)).toEqual({
      pending: true,
      atRisk: { opId: third.opId, waiting: "base_not_pulled", root: third.opId },
    });
  });
});

describe.runIf(TASKS_ENABLED)("task list and show", () => {
  const caller: TaskCaller = { canvas, canvasName: "factory", actor: seat };
  const mark: PendingMark = { pending: true, atRisk: { opId: mintOpId(), refusal: { reason: "invalid_transition", message: "no" } } };
  const ports = (pending?: TaskPorts["pending"]): TaskPorts => ({
    nodes: (c) => [...c.nodes.values()].filter((node) => node.kind === "task"),
    list: () => Effect.succeed({ tasks: [view(T1, 1), view(T2, 2)], more: false }),
    find: (_c, _n, lookup) => Effect.succeed([view(T1, 1), view(T2, 2)].find((task) => lookup.kind === "id" && task.taskId === lookup.taskId)),
    submit: () => Effect.die("no write"),
    changes: () => () => undefined,
    now: () => 0,
    comment: () => Effect.die("no comment"),
    ...(pending === undefined ? {} : { pending }),
  });
  const marked = ports(() => Effect.succeed(new Map([[T1, mark]])));
  const run = (op: "task.list" | "task.show", args: unknown, with_: TaskPorts) => Effect.runPromise(handleTaskOp(op, args, caller, with_));

  it("list marks a pending task with its at-risk state, and leaves the rest as they were", async () => {
    const listed = (await run("task.list", {}, marked)) as { tasks: ReadonlyArray<TaskView & Partial<PendingMark>> };
    expect(listed.tasks[0]).toEqual({ ...view(T1, 1), ...mark });
    expect(listed.tasks[1]).toEqual(view(T2, 2));
  });

  it("show marks a pending task", async () => {
    expect(await run("task.show", { task: T1 }, marked)).toEqual({ task: { ...view(T1, 1), ...mark } });
    expect(await run("task.show", { task: T2 }, marked)).toEqual({ task: view(T2, 2) });
  });

  it("marks nothing without the port", async () => {
    expect(await run("task.show", { task: T1 }, ports())).toEqual({ task: view(T1, 1) });
  });
});

describe.runIf(ARTIFACTS_ENABLED)("artifact list and show", () => {
  const A1 = mintItemId();
  const head = {
    artifact: { artifactId: A1, nodeId: asNodeId("docs"), type: "document", title: "Doc", version: 1, createdBy: seat, updatedAt: 1, archived: false, taskIds: [] },
    body: { type: "document", markdown: "hi" },
    bodyRef: { sha256: "0".repeat(64), bytes: 2 },
  };
  const caller: ArtifactCaller = { canvas, canvasName: "factory", actor: seat };
  const ports = {
    nodes: (c: Canvas) => [...c.nodes.values()].filter((node) => node.kind === "artifacts"),
    list: () => Effect.succeed({ artifacts: [head.artifact], more: false }),
    head: () => Effect.succeed(Option.some(head)),
    pending: () => Effect.succeed(new Map([[A1, { pending: true } as PendingMark]])),
  } as unknown as ArtifactPorts;

  it("list and show mark a pending artifact", async () => {
    const listed = await Effect.runPromise(handleArtifactOp("artifact.list", {}, caller, ports));
    expect(listed).toMatchObject({ artifacts: [{ artifactId: A1, pending: true }] });
    const exit = await Effect.runPromiseExit(handleArtifactOp("artifact.show", { artifact: A1 }, caller, ports));
    expect(exit).toMatchObject({ _tag: "Success", value: { artifact: { artifactId: A1, pending: true }, text: expect.any(String) } });
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("the task overlay reader", () => {
  const start = queued("task", T1, { kind: "start" });
  const edit = queued("artifact", mintItemId(), { op: "retitle", title: "x" });
  const answer: PendingEntry = { opId: start.opId, status: "at_risk", refusal: { reason: "invalid_transition", message: "This task is in the backlog, so it cannot be started" } };
  let replayed: ReadonlyArray<OpId> = [];
  const services = Layer.mergeAll(
    Layer.succeed(OpRepository, OpRepository.of({
      show: (_scope, opId) => Effect.succeed({ state: "queued", opId }),
      list: () => Effect.succeed({ ops: [{ state: "queued", opId: start.opId }], more: false }),
      unruled: () => Effect.succeed({ writer: mini, commands: [start, edit] }),
    })),
    Layer.succeed(ArtifactRepository, { overlay: () => Effect.succeed([]) } as never),
    Layer.succeed(TaskRepository, {
      overlay: (_canvas: string, _writer: InstallationId, commands: ReadonlyArray<{ readonly opId: OpId }>) => {
        replayed = commands.map(({ opId }) => opId);
        return Effect.succeed([answer]);
      },
    } as never),
  );

  it("replays this machine's queued task writes, so op show carries a task write's overlay", async () => {
    const shown = await Effect.runPromise(handleOpOp("op.show", { opId: start.opId }, { canvasName: "factory", nodeId: asNodeId("seat-a"), canvas }).pipe(Effect.provide(services)));
    expect(shown).toEqual({ op: { state: "queued", opId: start.opId, overlay: { status: "at_risk", refusal: answer.refusal } } });
    expect(replayed).toEqual([start.opId]);
  });

  it("gives the window and the marks the same overlay", async () => {
    const overlays = await Effect.runPromise(queuedOverlays("factory", canvas).pipe(Effect.provide(services)));
    expect(overlays?.overlays.get(start.opId)).toEqual({ status: "at_risk", refusal: answer.refusal });
    const marks = await Effect.runPromise(pendingMarksOf("task")("factory", canvas).pipe(Effect.provide(services)));
    expect(marks.get(T1)).toEqual({ pending: true, atRisk: { opId: start.opId, refusal: answer.refusal } });
  });

  it("marks nothing in a build without the record of resource writes", async () => {
    expect((await Effect.runPromise(pendingMarksOf("task")("factory", canvas))).size).toBe(0);
  });
});
