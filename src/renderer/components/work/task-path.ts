/**
 * Pure column derivation for the task board's path shape.
 * Columns follow the flow edges: a node with incoming flow shows Incoming in
 * place of Queue; a node with outgoing flow shows Outgoing in place of Closed;
 * a node with no flow edges keeps the plain board.
 */

import type { CanvasDoc, Task } from "@shared/canvas";
import type { TasksContract, Visit } from "@shared/work-model";
import { flowDestinations, flowSources } from "@shared/flow-graph";
import { taskAdmissionState, type TaskAdmissionState } from "@shared/rules";

export type TaskPathShape = {
  readonly sources: ReadonlyArray<string>;
  readonly destinations: ReadonlyArray<string>;
  readonly hasIncoming: boolean;
  readonly hasOutgoing: boolean;
};

export const taskPathShape = (doc: CanvasDoc, nodeId: string): TaskPathShape => {
  const sources = flowSources(doc, nodeId);
  const destinations = flowDestinations(doc, nodeId);
  return { sources, destinations, hasIncoming: sources.length > 0, hasOutgoing: destinations.length > 0 };
};

export const formatBoardNames = (names: ReadonlyArray<string>): string => {
  if (names.length === 0) return "connected boards";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
};

export type TaskPathLaneCopy = { readonly incomingHint: string; readonly incomingEmpty: string; readonly outgoingHint: string; readonly outgoingEmpty: string };

export const taskPathLaneCopy = (shape: TaskPathShape, boardName: (nodeId: string) => string): TaskPathLaneCopy => {
  const upstream = formatBoardNames(shape.sources.map(boardName));
  const destinations = formatBoardNames(shape.destinations.map(boardName));
  return {
    incomingHint: `From ${upstream}`,
    incomingEmpty: `Tasks from ${upstream} land here.`,
    outgoingHint: `Sent on to ${destinations}`,
    outgoingEmpty: `Completed tasks move to ${destinations}.`,
  };
};

const SECOND_MS = 1000; const MINUTE_MS = 60 * SECOND_MS; const HOUR_MS = 60 * MINUTE_MS; const DAY_MS = 24 * HOUR_MS;
const pad = (value: number) => String(value).padStart(2, "0");

/** Countdown to a wait release: "8s", "4m 20s", "1h 05m", "2d 3h". */
export const formatWaitCountdown = (waitUntil: string | undefined, nowMs: number): string | undefined => {
  if (waitUntil === undefined) return undefined;
  const releaseMs = Date.parse(waitUntil);
  if (!Number.isFinite(releaseMs)) return undefined;
  const left = releaseMs - nowMs;
  if (left <= 0) return undefined;
  if (left < MINUTE_MS) return `${Math.ceil(left / SECOND_MS)}s`;
  if (left < HOUR_MS) return `${Math.floor(left / MINUTE_MS)}m ${pad(Math.floor((left % MINUTE_MS) / SECOND_MS))}s`;
  if (left < DAY_MS) return `${Math.floor(left / HOUR_MS)}h ${pad(Math.floor((left % HOUR_MS) / MINUTE_MS))}m`;
  return `${Math.floor(left / DAY_MS)}d ${Math.floor((left % DAY_MS) / HOUR_MS)}h`;
};

export type IncomingGlance = { readonly admission: TaskAdmissionState; readonly countdown?: string; readonly promotable: boolean };

/** Admission glance for a submitted task in Queue or Incoming. */
export const incomingGlance = (task: Task, contract: TasksContract | undefined, nowMs: number): IncomingGlance => {
  const admission = taskAdmissionState(task, contract, nowMs);
  const countdown = formatWaitCountdown(task.waitUntil, nowMs);
  return { admission, ...(countdown !== undefined ? { countdown } : {}), promotable: admission === "approval" };
};

/** True when a submitted task is still gated on operator approval. */
export const taskNeedsApproval = (
  task: Task,
  contract: TasksContract | undefined,
  nowMs: number,
): boolean => task.state === "submitted" && incomingGlance(task, contract, nowMs).promotable;

/**
 * Queue/Incoming column hint from live admission of submitted tasks in that
 * lane. Approval wins over wait; otherwise keep the lane's ready copy.
 */
export const admissionLaneHint = (
  tasks: ReadonlyArray<Task>,
  contract: TasksContract | undefined,
  nowMs: number,
  readyHint: string,
): string => {
  let waiting = false;
  for (const task of tasks) {
    if (task.state !== "submitted") continue;
    const { admission } = incomingGlance(task, contract, nowMs);
    if (admission === "approval") return "Waiting for approval";
    if (admission === "waiting") waiting = true;
  }
  return waiting ? "Waiting to start" : readyHint;
};

/** True while any task still waits — the column ticks its clock only then. */
export const hasPendingWait = (tasks: ReadonlyArray<Task>, nowMs: number): boolean =>
  tasks.some((task) => formatWaitCountdown(task.waitUntil, nowMs) !== undefined);

export type OutgoingGroupKind = "sent-on" | "sent-back" | "completed";
export type OutgoingGroup<T> = { readonly key: string; readonly kind: OutgoingGroupKind; readonly boardId?: string; readonly tasks: ReadonlyArray<T> };

type VisitedTask = { readonly id: string; readonly visits?: ReadonlyArray<Visit> };

/** The visit record this task left at `nodeId` — the last visit that names this board and has exited. */
export const localVisit = <T extends VisitedTask>(task: T, nodeId: string): Visit | undefined => {
  let found: Visit | undefined;
  for (const visit of task.visits ?? []) if (visit.board === nodeId && visit.exit !== undefined) found = visit;
  return found;
};

/**
 * Group the Outgoing column by where each visit went: next boards first
 * (path-edge order), then send-backs, then work completed here.
 */
export const groupOutgoingVisits = <T extends VisitedTask>(tasks: ReadonlyArray<T>, nodeId: string, destinationOrder: ReadonlyArray<string>): ReadonlyArray<OutgoingGroup<T>> => {
  const buckets = new Map<string, { group: OutgoingGroup<T>; tasks: T[] }>();
  const order: string[] = [];
  const bucket = (key: string, kind: OutgoingGroupKind, boardId?: string) => {
    const existing = buckets.get(key);
    if (existing) return existing;
    const created = { group: { key, kind, ...(boardId !== undefined ? { boardId } : {}), tasks: [] as ReadonlyArray<T> }, tasks: [] as T[] };
    buckets.set(key, created); order.push(key);
    return created;
  };
  for (const task of tasks) {
    const visit = localVisit(task, nodeId);
    const next = visit?.next;
    if (visit?.exit === "sent-on" && next !== undefined) { bucket(`sent-on:${next}`, "sent-on", next).tasks.push(task); continue; }
    if (visit?.exit === "sent-back" && next !== undefined) { bucket(`sent-back:${next}`, "sent-back", next).tasks.push(task); continue; }
    bucket("completed", "completed").tasks.push(task);
  }
  const rank = (key: string): number => {
    const entry = buckets.get(key)!.group;
    if (entry.kind === "completed") return 2;
    if (entry.kind === "sent-back") return 1;
    const index = destinationOrder.indexOf(entry.boardId ?? "");
    return index < 0 ? 0.5 : 0;
  };
  const positionWithinSentOn = (key: string): number => {
    const boardId = buckets.get(key)!.group.boardId ?? "";
    const index = destinationOrder.indexOf(boardId);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  return order
    .map((key, insertion) => ({ key, insertion }))
    .sort((left, right) => {
      const byRank = rank(left.key) - rank(right.key);
      if (byRank !== 0) return byRank;
      if (rank(left.key) === 0) return positionWithinSentOn(left.key) - positionWithinSentOn(right.key);
      return left.insertion - right.insertion;
    })
    .map(({ key }) => { const entry = buckets.get(key)!; return { ...entry.group, tasks: entry.tasks }; });
};
