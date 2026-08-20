/**
 * Pure column derivation for the task flow modal's pipeline shape.
 * Columns follow the flow edges: a sink with incoming flow shows Inbound in
 * place of Proposals + Queue; a sink with outgoing flow shows Outbound in
 * place of Closed; a sink with no flow edges keeps the plain board.
 * No React state shape, no I/O — the modal reads these and renders.
 */

import type { CanvasDoc, Passage, Task, TasksSinkContract } from "@shared/canvas";
import { taskAdmissionState, type TaskAdmissionState } from "@shared/claims";
import { flowDestinations, flowSources } from "@shared/flow-graph";

export type PipelineShape = {
  /** Upstream stations feeding this sink, in document edge order. */
  readonly sources: ReadonlyArray<string>;
  /** Forward stations this sink can hand work to, in document edge order. */
  readonly destinations: ReadonlyArray<string>;
  readonly hasInbound: boolean;
  readonly hasOutbound: boolean;
};

export const pipelineShape = (doc: CanvasDoc, nodeId: string): PipelineShape => {
  const sources = flowSources(doc, nodeId);
  const destinations = flowDestinations(doc, nodeId);
  return {
    sources,
    destinations,
    hasInbound: sources.length > 0,
    hasOutbound: destinations.length > 0,
  };
};

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const pad = (value: number): string => String(value).padStart(2, "0");

/**
 * Glance countdown to a hold release: "8s", "4m 20s", "1h 05m", "2d 3h".
 * Undefined when there is no hold or the hold has already elapsed.
 */
export const formatHoldCountdown = (
  holdUntil: string | undefined,
  nowMs: number,
): string | undefined => {
  if (holdUntil === undefined) return undefined;
  const releaseMs = Date.parse(holdUntil);
  if (!Number.isFinite(releaseMs)) return undefined;
  const left = releaseMs - nowMs;
  if (left <= 0) return undefined;
  if (left < MINUTE_MS) return `${Math.ceil(left / SECOND_MS)}s`;
  if (left < HOUR_MS) {
    return `${Math.floor(left / MINUTE_MS)}m ${pad(Math.floor((left % MINUTE_MS) / SECOND_MS))}s`;
  }
  if (left < DAY_MS) {
    return `${Math.floor(left / HOUR_MS)}h ${pad(Math.floor((left % HOUR_MS) / MINUTE_MS))}m`;
  }
  return `${Math.floor(left / DAY_MS)}d ${Math.floor((left % DAY_MS) / HOUR_MS)}h`;
};

export type ArrivalGlance = {
  readonly admission: TaskAdmissionState;
  /** Time left on the arrival bake, when the arrival is still held. */
  readonly countdown?: string;
  /** Operator promotion is the only way past an operator-gated arrival. */
  readonly promotable: boolean;
};

/**
 * Admission glance for an arrival waiting in the Inbound column. Only
 * meaningful for `submitted` rows — a claimed or closed task has left
 * admission behind.
 */
export const arrivalGlance = (
  task: Task,
  contract: TasksSinkContract | undefined,
  nowMs: number,
): ArrivalGlance => {
  const admission = taskAdmissionState(task, contract, nowMs);
  const countdown =
    admission === "held" ? formatHoldCountdown(task.holdUntil, nowMs) : undefined;
  return {
    admission,
    ...(countdown !== undefined ? { countdown } : {}),
    promotable: admission === "operator-gated",
  };
};

/** True while any arrival still bakes — the column ticks its clock only then. */
export const hasPendingHold = (
  tasks: ReadonlyArray<Task>,
  nowMs: number,
): boolean =>
  tasks.some((task) => formatHoldCountdown(task.holdUntil, nowMs) !== undefined);

export type OutboundGroupKind = "forwarded" | "returned" | "closed";

export type OutboundGroup<T> = {
  readonly key: string;
  readonly kind: OutboundGroupKind;
  /** Station the passage went to — absent for work that closed here. */
  readonly stationId?: string;
  readonly tasks: ReadonlyArray<T>;
};

type JourneyTask = {
  readonly id: string;
  readonly journey?: ReadonlyArray<Passage>;
};

/**
 * The passage record this task left at `nodeId` — the last journey entry that
 * both names this station and has exited. Absent for work that never travelled.
 */
export const localPassage = <T extends JourneyTask>(
  task: T,
  nodeId: string,
): Passage | undefined => {
  let found: Passage | undefined;
  for (const passage of task.journey ?? []) {
    if (passage.nodeId === nodeId && passage.exit !== undefined) found = passage;
  }
  return found;
};

/**
 * Group the Outbound column by where each passage went: forwarded stations
 * first (flow-edge order), then defect returns, then work that closed here.
 * Task order inside a group is preserved from the input.
 */
export const groupOutboundPassages = <T extends JourneyTask>(
  tasks: ReadonlyArray<T>,
  nodeId: string,
  destinationOrder: ReadonlyArray<string>,
): ReadonlyArray<OutboundGroup<T>> => {
  const buckets = new Map<string, { group: OutboundGroup<T>; tasks: T[] }>();
  const order: string[] = [];
  const bucket = (key: string, kind: OutboundGroupKind, stationId?: string) => {
    const existing = buckets.get(key);
    if (existing) return existing;
    const created = {
      group: {
        key,
        kind,
        ...(stationId !== undefined ? { stationId } : {}),
        tasks: [] as ReadonlyArray<T>,
      },
      tasks: [] as T[],
    };
    buckets.set(key, created);
    order.push(key);
    return created;
  };
  for (const task of tasks) {
    const passage = localPassage(task, nodeId);
    const next = passage?.next;
    if (passage?.exit === "forwarded" && next !== undefined) {
      bucket(`forwarded:${next}`, "forwarded", next).tasks.push(task);
      continue;
    }
    if (passage?.exit === "rejected-back" && next !== undefined) {
      bucket(`returned:${next}`, "returned", next).tasks.push(task);
      continue;
    }
    bucket("closed", "closed").tasks.push(task);
  }
  const rank = (key: string): number => {
    const entry = buckets.get(key)!.group;
    if (entry.kind === "closed") return 2;
    if (entry.kind === "returned") return 1;
    const index = destinationOrder.indexOf(entry.stationId ?? "");
    return index < 0 ? 0.5 : 0;
  };
  const positionWithinForwarded = (key: string): number => {
    const stationId = buckets.get(key)!.group.stationId ?? "";
    const index = destinationOrder.indexOf(stationId);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  return order
    .map((key, insertion) => ({ key, insertion }))
    .sort((left, right) => {
      const byRank = rank(left.key) - rank(right.key);
      if (byRank !== 0) return byRank;
      if (rank(left.key) === 0) {
        return positionWithinForwarded(left.key) - positionWithinForwarded(right.key);
      }
      return left.insertion - right.insertion;
    })
    .map(({ key }) => {
      const entry = buckets.get(key)!;
      return { ...entry.group, tasks: entry.tasks };
    });
};
