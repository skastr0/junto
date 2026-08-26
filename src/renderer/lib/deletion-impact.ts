import type { CanvasDoc, CanvasEdge, CanvasNode } from "@shared/canvas";
import { flowDestinations, isTaskSinkNode } from "@shared/flow-graph";
import {
  flowEdgeRemovalImpact,
  stationDeletionImpact,
} from "@shared/journey-integrity";
import { stationIdentity } from "@shared/station-identity";

const count = (value: number, singular: string, plural = `${singular}s`): string =>
  `${value} ${value === 1 ? singular : plural}`;

const quotedTitle = (node: CanvasNode): string =>
  `“${stationIdentity(node).name}”`;

const stationName = (doc: CanvasDoc, nodeId: string): string => {
  const node = doc.nodes.find((candidate) => candidate.id === nodeId);
  return node ? quotedTitle(node) : "the removed station";
};

/**
 * Specific consequences of deleting task stations. Empty means the ordinary
 * deletion confirmation is sufficient.
 */
export const stationDeletionWarnings = (
  doc: CanvasDoc,
  removedNodeIds: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const warnings: string[] = [];
  for (const node of doc.nodes) {
    if (!removedNodeIds.has(node.id) || !isTaskSinkNode(node)) continue;
    const impact = stationDeletionImpact(doc, node.id);
    const liveRows = impact.strandedTasks.filter((task) =>
      task.kinds.includes("home-row"),
    ).length;
    const journeyReferences = impact.strandedTasks.filter((task) =>
      task.kinds.some((kind) => kind === "passage" || kind === "defect-target"),
    ).length;
    if (liveRows > 0) {
      warnings.push(`${quotedTitle(node)} holds ${count(liveRows, "live task")}.`);
    }
    if (journeyReferences > 0) {
      warnings.push(
        `${count(journeyReferences, "live journey")} reference${journeyReferences === 1 ? "s" : ""} ${quotedTitle(node)} as a stop or send-back target.`,
      );
    }
  }
  return warnings;
};

type SourceRemoval = {
  readonly source: string;
  readonly removedDestinations: ReadonlySet<string>;
  readonly affectedTasks: ReadonlySet<string>;
};

/**
 * Specific consequences of removing configured task-flow edges. The caller
 * supplies every edge that will disappear, including edges removed along with
 * a node, so multi-delete reports the collective routing outcome honestly.
 */
export const flowEdgeRemovalWarnings = (
  doc: CanvasDoc,
  removedEdges: ReadonlyArray<CanvasEdge>,
  removedNodeIds: ReadonlySet<string> = new Set(),
): ReadonlyArray<string> => {
  const bySource = new Map<
    string,
    { destinations: Set<string>; tasks: Set<string> }
  >();
  for (const edge of removedEdges) {
    // A `feeds` edge is stored in its own direction: fromNode is the upstream
    // station, toNode the forward destination.
    if (edge.ether?.verb !== "feeds") continue;
    const source = edge.fromNode;
    if (removedNodeIds.has(source)) continue;
    const destination = edge.toNode;
    const impact = flowEdgeRemovalImpact(doc, source, destination);
    const entry = bySource.get(source) ?? {
      destinations: new Set<string>(),
      tasks: new Set<string>(),
    };
    entry.destinations.add(destination);
    for (const task of impact.affectedTasks) entry.tasks.add(task);
    bySource.set(source, entry);
  }

  const removals: SourceRemoval[] = [...bySource].map(([source, value]) => ({
    source,
    removedDestinations: value.destinations,
    affectedTasks: value.tasks,
  }));
  return removals.flatMap(({ source, removedDestinations, affectedTasks }) => {
    const sourceName = stationName(doc, source);
    const lostNames = [...removedDestinations].map((destination) =>
      stationName(doc, destination),
    );
    const remaining = flowDestinations(doc, source).filter(
      (destination) => !removedDestinations.has(destination),
    );
    const warnings: string[] = [];
    if (affectedTasks.size > 0) {
      warnings.push(
        `${sourceName} has ${count(affectedTasks.size, "live task")} that will lose ${lostNames.join(" and ")} as ${lostNames.length === 1 ? "a forward destination" : "forward destinations"}.`,
      );
    }
    if (remaining.length === 0 && removedDestinations.size > 0) {
      warnings.push(
        `This removes ${sourceName}’s last forward connection, leaving it with nowhere to forward.`,
      );
    }
    return warnings;
  });
};
