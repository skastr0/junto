/**
 * Where the Tasks node reads and writes its tasks (plan 0.10/04). One
 * interface, so the pane never knows which side answers it.
 *
 * A write is one `TaskCommand` ruled by the task domain
 * (`ruleTaskBoardCommand`, src/shared/task-machine.ts), so a refusal here
 * reads exactly as the editing machine's: `detail.kind` names why.
 *
 * Stand-in: until cli-identity serves tasks from main, `makeLocalTasksSource`
 * holds them in this window's memory, ruled by the same domain. Reach and
 * flows come in as the `env` the caller builds from the canvas.
 */
import { useEffect, useRef, useState } from "react";
import {
  ruleTaskBoardCommand,
  emptyTaskBoard,
  taskDomain,
  type TaskBoardState,
  type TaskDomainEnv,
  type TaskRecord,
} from "@shared/task-machine";
import type {
  ClosedTaskLayer,
  TaskActor,
  TaskCommand,
  TaskId,
  TaskNodeId,
  TaskRefusal,
  TaskView,
} from "@shared/task-model";

export type TaskRuling =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: TaskRefusal };

export interface TasksSource {
  /** The tasks that sit on this node now, oldest first. */
  readonly list: (canvasName: string, node: TaskNodeId) => Promise<ReadonlyArray<TaskView>>;
  /** Every open task of the canvas, for the one open task rule (a seat holds one anywhere). */
  readonly all: (canvasName: string) => Promise<ReadonlyArray<TaskView>>;
  /** Rule one command. On `create` the caller mints `taskId` and names it in the command. */
  readonly apply: (
    canvasName: string,
    node: TaskNodeId,
    taskId: TaskId,
    command: TaskCommand,
  ) => Promise<TaskRuling>;
  /** Called after any change; returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
}

type Stored = {
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly layers: ReadonlyArray<ClosedTaskLayer>;
};

const viewOf = (record: TaskRecord, stored: Stored): TaskView => {
  const { id, number, title, body, dependsOn, ...core } = record;
  return {
    taskId: id,
    number,
    title,
    ...(body !== undefined ? { body } : {}),
    current: core,
    layers: stored.layers,
    dependsOn,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
};

/** The local source, plus `as`: the same tasks written by another actor (a seat, for tests and the gallery). */
export type LocalTasksSource = TasksSource & { readonly as: (actor: TaskActor) => TasksSource };

/** An in-memory source, as the stand-in and for tests. Every write is `actor`'s. */
export const makeLocalTasksSource = (
  env: Omit<TaskDomainEnv, "at"> = {
    downstream: () => [],
    stampDefaultOf: () => ({ required: 0 }),
    seatReaches: () => true,
  },
  actor: TaskActor = { kind: "operator" },
  now: () => number = Date.now,
): LocalTasksSource => {
  const boards = new Map<string, TaskBoardState>();
  const stored = new Map<TaskId, Stored>();
  const listeners = new Set<() => void>();
  const boardOf = (canvasName: string): TaskBoardState => boards.get(canvasName) ?? emptyTaskBoard();
  const views = (canvasName: string): ReadonlyArray<TaskView> =>
    [...boardOf(canvasName).tasks.values()].map((record) =>
      viewOf(record, stored.get(record.id) ?? { createdAt: 0, updatedAt: 0, layers: [] }),
    );

  const writtenBy = (writer: TaskActor): TasksSource => ({
    list: async (canvasName, node) => views(canvasName).filter((view) => view.current.node === node),
    all: async (canvasName) => views(canvasName),
    apply: async (canvasName, node, taskId, command) => {
      const at = now();
      const full: TaskDomainEnv = { ...env, at };
      const state = boardOf(canvasName);
      const ruling = ruleTaskBoardCommand(state, { node, taskId }, writer, command, full);
      if (!ruling.ok) return { ok: false, refusal: ruling.refusal };
      boards.set(
        canvasName,
        taskDomain(full).apply(state, { kind: "task", task: ruling.task, effects: ruling.effects }),
      );
      const before = stored.get(taskId);
      const closed = ruling.effects.flatMap((effect) =>
        effect.kind === "sent-on" ? [{ ...effect.layer, closedAt: at }] : [],
      );
      stored.set(taskId, {
        createdAt: before?.createdAt ?? at,
        updatedAt: at,
        layers: [...(before?.layers ?? []), ...closed],
      });
      for (const listener of listeners) listener();
      return { ok: true };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });

  return { ...writtenBy(actor), as: writtenBy };
};

/** This window's source. Swapped for main's when cli-identity's handlers land. */
let source: TasksSource = makeLocalTasksSource();

export const tasksSource = (): TasksSource => source;

/** Tests and the main-side switch set the source. */
export const setTasksSource = (next: TasksSource): void => {
  source = next;
};

/** Re-read whenever the source changes or `key` does. */
const useSourced = <T>(read: () => Promise<T>, initial: T, key: string): T => {
  const [value, setValue] = useState<T>(initial);
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    let live = true;
    setValue(initial);
    const refresh = (): void => {
      void readRef.current().then((next) => {
        if (live) setValue(next);
      });
    };
    refresh();
    const unsubscribe = tasksSource().subscribe(refresh);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [key]);
  return value;
};

const NONE: ReadonlyArray<never> = [];

export const useNodeTasks = (canvasName: string, node: TaskNodeId): ReadonlyArray<TaskView> =>
  useSourced(() => tasksSource().list(canvasName, node), NONE, `${canvasName}\u0000${node}`);

export const useCanvasTasks = (canvasName: string): ReadonlyArray<TaskView> =>
  useSourced(() => tasksSource().all(canvasName), NONE, canvasName);
