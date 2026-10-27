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
  taskRefusalMessage,
  type TaskBoardState,
  type TaskDomainEnv,
  type TaskRecord,
} from "@shared/task-machine";
import { mintOpId } from "@shared/resource-command";
import { taskEnvOf, taskRefusalOf, type TaskPendingWrite, type TaskResourceApi } from "@shared/resource-ipc";
import type {
  ClosedTaskLayer,
  TaskActor,
  TaskCommand,
  TaskId,
  TaskNodeId,
  TaskRefusal,
  TaskView,
} from "@shared/task-model";

/**
 * What one write came back as. A refusal always has its words; it carries the
 * domain's `refusal` when the task domain gave it (not for a refusal before
 * the domain: reach, a full queue). `queued` is a success: durable, not ruled yet.
 */
export type TaskRuling =
  | {
    readonly ok: true;
    readonly queued?: true;
    /** The write stands but the mail it owes did not go. Say so; never resend. */
    readonly deliveryError?: string;
  }
  | { readonly ok: false; readonly message: string; readonly refusal?: TaskRefusal };

/** What the ruler consults besides the tasks: flows, stamp defaults, reach (04, 01). */
export type TaskFacts = Omit<TaskDomainEnv, "at">;

export interface TasksSource {
  /** The tasks that sit on this node now, oldest first. */
  readonly list: (canvasName: string, node: TaskNodeId) => Promise<ReadonlyArray<TaskView>>;
  /** Every task of the canvas but archived ones. */
  readonly all: (canvasName: string) => Promise<ReadonlyArray<TaskView>>;
  /** Rule one command. On `create` the caller mints `taskId` and names it in the command. */
  readonly apply: (
    canvasName: string,
    node: TaskNodeId,
    taskId: TaskId,
    command: TaskCommand,
  ) => Promise<TaskRuling>;
  /** This machine's writes to the node's tasks that have no ruling yet, in queue order. */
  readonly pending: (canvasName: string, node: TaskNodeId) => Promise<ReadonlyArray<TaskPendingWrite>>;
  /** The canvas's facts the ruler is asked in, to check a command before it is sent. */
  readonly facts: (canvasName: string) => Promise<TaskFacts>;
  /** Called after any change; returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
}

type Stored = {
  readonly createdAt: number;
  readonly updatedAt: number;
  /** When the current state began; a write that leaves the state as it is keeps it. */
  readonly stateSince: number;
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
    stateSince: stored.stateSince,
  };
};

/** The local source, plus `as`: the same tasks written by another actor (a seat, for tests and the gallery). */
export type LocalTasksSource = TasksSource & { readonly as: (actor: TaskActor) => TasksSource };

/** An in-memory source, as the stand-in and for tests. Every write is `actor`'s. */
export const makeLocalTasksSource = (
  env: TaskFacts = {
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
      viewOf(record, stored.get(record.id) ?? { createdAt: 0, updatedAt: 0, stateSince: 0, layers: [] }),
    );

  const writtenBy = (writer: TaskActor): TasksSource => ({
    list: async (canvasName, node) => views(canvasName).filter((view) => view.current.node === node),
    all: async (canvasName) => views(canvasName),
    apply: async (canvasName, node, taskId, command) => {
      const at = now();
      const full: TaskDomainEnv = { ...env, at };
      const state = boardOf(canvasName);
      const was = state.tasks.get(taskId)?.state;
      const ruling = ruleTaskBoardCommand(state, { node, taskId }, writer, command, full);
      if (!ruling.ok) return { ok: false, message: taskRefusalMessage(ruling.refusal.detail), refusal: ruling.refusal };
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
        stateSince: before !== undefined && was === ruling.task.state ? before.stateSince : at,
        layers: [...(before?.layers ?? []), ...closed],
      });
      for (const listener of listeners) listener();
      return { ok: true };
    },
    pending: async () => [],
    facts: async () => env,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });

  return { ...writtenBy(actor), as: writtenBy };
};

/**
 * Main's tasks over the resource IPC (`resource-ipc.ts`): the same four reads
 * and one write as the local stand-in. The opId is minted per command, so a
 * resend after a lost answer is the same command to the ruler.
 */
export const makeIpcTasksSource = (api: TaskResourceApi): TasksSource => ({
  list: (canvasName, node) => api.list(canvasName, node),
  all: (canvasName) => api.all(canvasName),
  apply: async (canvasName, node, taskId, command) => {
    const outcome = await api.apply(canvasName, node, taskId, mintOpId(), command);
    switch (outcome.kind) {
      case "applied":
        return outcome.deliveryError === undefined ? { ok: true } : { ok: true, deliveryError: outcome.deliveryError.message };
      case "queued":
        return { ok: true, queued: true };
      case "refused": {
        const refusal = taskRefusalOf(outcome.error);
        return {
          ok: false,
          message: refusal === undefined ? outcome.error.message : taskRefusalMessage(refusal.detail),
          ...(refusal === undefined ? {} : { refusal }),
        };
      }
    }
  },
  pending: (canvasName, node) => api.pending(canvasName, node),
  facts: async (canvasName) => taskEnvOf(await api.context(canvasName)),
  subscribe: (listener) => api.onChanged(() => listener()),
});

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

const NO_FACTS: TaskFacts = {
  downstream: () => [],
  stampDefaultOf: () => ({ required: 0 }),
  seatReaches: () => false,
};

/** The canvas's ruling facts; nothing is reachable until they are read. */
export const useTaskFacts = (canvasName: string): TaskFacts =>
  useSourced(() => tasksSource().facts(canvasName), NO_FACTS, canvasName);

/** This machine's unruled writes to the node's tasks, kept fresh. */
export const useNodePending = (canvasName: string, node: TaskNodeId): ReadonlyArray<TaskPendingWrite> =>
  useSourced(() => tasksSource().pending(canvasName, node), NONE, `${canvasName}\u0000${node}`);

export const useCanvasTasks = (canvasName: string): ReadonlyArray<TaskView> =>
  useSourced(() => tasksSource().all(canvasName), NONE, canvasName);

let installed = false;

/**
 * Point the Tasks node at main's tasks. Idempotent. Without the API (the
 * feature is off, or no bridge in a test) the in-memory source stays.
 */
export const installIpcTasksSource = (api: TaskResourceApi | undefined): boolean => {
  if (api === undefined) return false;
  if (!installed) {
    setTasksSource(makeIpcTasksSource(api));
    installed = true;
  }
  return true;
};
