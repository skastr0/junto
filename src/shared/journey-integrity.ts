/**
 * Journey referential integrity — what a canvas mutation would break.
 *
 * Task journeys and defect logs reference station node ids; flow edges decide
 * where live work can still travel. Deleting a station or a flow edge does not
 * corrupt the record (journeys are append-only history), but it strands the
 * actions that depend on those ids: defect-to-target, forwarding, journey
 * rendering. The rules, settled with the operator:
 *
 * - mutations to task sinks and flow edges that live journeys reference must
 *   be DETECTABLE before they happen (warn/confirm surfaces read this module);
 * - actions that depend on a missing id fail closed and are shown disabled
 *   with the reason, never half-work.
 *
 * Everything here is a pure projection of the document — computed, not stored.
 */

import type { CanvasDoc } from "./canvas";
import type { Task } from "./work-model";
import { isTerminalTaskState } from "./task";
import { flowDestinations } from "./flow-graph";
import { taskDefects } from "./claims";

/** How a task references a station. */
export type StationReferenceKind = "passage" | "defect-target" | "home-row";

export type StationReference = {
  readonly taskId: string;
  /** Station row the task currently lives on (where the reference was read). */
  readonly rowStation: string;
  readonly kind: StationReferenceKind;
};

/** Every task row on the canvas, with the station its row lives on. */
const taskRows = (
  doc: CanvasDoc,
): ReadonlyArray<{ readonly station: string; readonly task: Task }> =>
  doc.nodes.flatMap((node) =>
    (node.ether?.tasks?.items ?? []).map((task) => ({
      station: node.id,
      task,
    })),
  );

/**
 * Stations referenced by LIVE journeys, station id -> references. Terminal
 * tasks are history — their references never block a mutation, they only
 * degrade rendering (which renders the bare id and moves on).
 */
export const stationsReferencedByLiveJourneys = (
  doc: CanvasDoc,
): ReadonlyMap<string, ReadonlyArray<StationReference>> => {
  const out = new Map<string, StationReference[]>();
  // One reference per (task, kind) per station — a station revisited across
  // epochs is still one passage dependency, not two.
  const add = (station: string, reference: StationReference) => {
    const refs = out.get(station) ?? [];
    if (
      refs.some(
        (existing) =>
          existing.taskId === reference.taskId &&
          existing.kind === reference.kind,
      )
    ) {
      return;
    }
    refs.push(reference);
    out.set(station, refs);
  };
  // The LIVE row is the authority: passage-record rows carry the journey only
  // as of their exit, and document order says nothing about which row is
  // live. One live row per task holds by the no-split invariant.
  for (const { station, task } of taskRows(doc)) {
    if (isTerminalTaskState(task.state)) continue;
    add(station, { taskId: task.id, rowStation: station, kind: "home-row" });
    for (const passage of task.journey ?? []) {
      add(passage.nodeId, {
        taskId: task.id,
        rowStation: station,
        kind: "passage",
      });
    }
    for (const defect of taskDefects(task)) {
      add(defect.target, {
        taskId: task.id,
        rowStation: station,
        kind: "defect-target",
      });
    }
  }
  return out;
};

export type DeletionImpact = {
  /** Live tasks whose journey or defect log references the node. */
  readonly strandedTasks: ReadonlyArray<{
    readonly taskId: string;
    readonly kinds: ReadonlyArray<StationReferenceKind>;
  }>;
  /** True when any live task's row LIVES on the node (work would vanish). */
  readonly carriesLiveRows: boolean;
};

/**
 * What deleting a task-sink node would strand. Empty impact = free to delete
 * silently; anything else earns the warn/confirm naming exactly this.
 */
export const stationDeletionImpact = (
  doc: CanvasDoc,
  nodeId: string,
): DeletionImpact => {
  const references = stationsReferencedByLiveJourneys(doc).get(nodeId) ?? [];
  const byTask = new Map<string, Set<StationReferenceKind>>();
  let carriesLiveRows = false;
  for (const reference of references) {
    const kinds = byTask.get(reference.taskId) ?? new Set();
    kinds.add(reference.kind);
    byTask.set(reference.taskId, kinds);
    if (reference.kind === "home-row" && reference.rowStation === nodeId) {
      carriesLiveRows = true;
    }
  }
  return {
    strandedTasks: [...byTask.entries()].map(([taskId, kinds]) => ({
      taskId,
      kinds: [...kinds],
    })),
    carriesLiveRows,
  };
};

export type FlowEdgeImpact = {
  /** Live tasks currently at the source whose forward move loses this destination. */
  readonly affectedTasks: ReadonlyArray<string>;
  /** True when this edge is the source's ONLY destination (station turns terminal). */
  readonly lastDestination: boolean;
};

/** What removing the flow edge source -> destination would take away. */
export const flowEdgeRemovalImpact = (
  doc: CanvasDoc,
  source: string,
  destination: string,
): FlowEdgeImpact => {
  const destinations = flowDestinations(doc, source);
  const remaining = destinations.filter((node) => node !== destination);
  const affected = taskRows(doc)
    .filter(
      ({ station, task }) =>
        station === source && !isTerminalTaskState(task.state),
    )
    .map(({ task }) => task.id);
  return {
    affectedTasks: [...new Set(affected)],
    lastDestination: destinations.includes(destination) && remaining.length === 0,
  };
};

export type DefectTargetOption = {
  readonly station: string;
  /** False when the station left the canvas — the action renders disabled with this reason. */
  readonly present: boolean;
};

/**
 * The legal defect targets for a task at `currentStation`: every visited
 * station except the current one, in first-visit order, each flagged with
 * whether it still exists on the canvas. Pickers render absent stations
 * disabled instead of hiding them — the journey happened either way.
 */
export const defectTargetOptions = (
  doc: CanvasDoc,
  task: Task,
  currentStation: string,
): ReadonlyArray<DefectTargetOption> => {
  const seen = new Set<string>();
  const out: DefectTargetOption[] = [];
  for (const passage of task.journey ?? []) {
    if (passage.nodeId === currentStation) continue;
    if (seen.has(passage.nodeId)) continue;
    seen.add(passage.nodeId);
    out.push({
      station: passage.nodeId,
      present: doc.nodes.some((node) => node.id === passage.nodeId),
    });
  }
  return out;
};
