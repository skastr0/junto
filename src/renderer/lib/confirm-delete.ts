import { askConfirm } from "./confirm";
import { wireRemovalWarnings, removalPolicy, boardRemovalWarnings } from "./deletion-impact";
import { state$ } from "./state";
import { modelStore } from "./use-model";

/**
 * The delete questions for canvas nodes and edges, with the same wording and
 * impact warnings the native confirm carried. Each resolves true when the
 * operator confirms, and true without asking when there is nothing to
 * delete, so a caller can gate on the answer alone.
 */

export const confirmNodeDelete = async (ids: ReadonlyArray<string>): Promise<boolean> => {
  const removed = new Set(ids);
  const canvasName = state$.canvasName.peek();
  const canvas = modelStore.canvasOf(canvasName);
  const nodes = [...canvas.nodes.values()].filter((node) => removed.has(node.id));
  if (nodes.length === 0) return Promise.resolve(true);
  const removedEdges = [...canvas.wires.values()].filter(
    (edge) => removed.has(edge.from) || removed.has(edge.to),
  );
  const one = nodes.length === 1;
  const policy = await removalPolicy(canvasName, canvas, removed, removedEdges);
  return askConfirm({
    source: "node-delete",
    title: one ? "Delete this node?" : `Delete ${nodes.length} nodes?`,
    body: [
      ...boardRemovalWarnings(canvas, removed, policy),
      ...wireRemovalWarnings(canvas, removedEdges, policy, removed),
      ...(removedEdges.length === 0
        ? []
        : [`Connected edges (${removedEdges.length}) will also be removed.`]),
    ],
    confirmLabel: one ? "Delete node" : `Delete ${nodes.length} nodes`,
    tone: "danger",
  });
};

export const confirmEdgeDelete = async (ids: ReadonlyArray<string>): Promise<boolean> => {
  const removed = new Set(ids);
  const canvasName = state$.canvasName.peek();
  const canvas = modelStore.canvasOf(canvasName);
  const edges = [...canvas.wires.values()].filter((edge) => removed.has(edge.id));
  if (edges.length === 0) return Promise.resolve(true);
  const one = edges.length === 1;
  const policy = await removalPolicy(canvasName, canvas, new Set(), edges);
  return askConfirm({
    source: "edge-delete",
    title: one ? "Delete this relation?" : `Delete ${edges.length} relations?`,
    body: wireRemovalWarnings(canvas, edges, policy),
    confirmLabel: one ? "Delete relation" : `Delete ${edges.length} relations`,
    tone: "danger",
  });
};
