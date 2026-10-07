import { askConfirm } from "./confirm";
import { flowEdgeRemovalWarnings, readDeletionPolicy, tasksNodeDeletionWarnings } from "./deletion-impact";
import { state$ } from "./state";

/**
 * The delete questions for canvas nodes and edges, with the same wording and
 * impact warnings the native confirm carried. Each resolves true when the
 * operator confirms, and true without asking when there is nothing to
 * delete, so a caller can gate on the answer alone.
 */

export const confirmNodeDelete = async (ids: ReadonlyArray<string>): Promise<boolean> => {
  const removed = new Set(ids);
  const doc = state$.doc.peek();
  const nodes = doc.nodes.filter((node) => removed.has(node.id));
  if (nodes.length === 0) return Promise.resolve(true);
  const removedEdges = doc.edges.filter(
    (edge) => removed.has(edge.fromNode) || removed.has(edge.toNode),
  );
  const one = nodes.length === 1;
  const policy = await readDeletionPolicy(state$.canvasName.peek(), doc, removed, removedEdges);
  return askConfirm({
    source: "node-delete",
    title: one ? "Delete this node?" : `Delete ${nodes.length} nodes?`,
    body: [
      ...tasksNodeDeletionWarnings(doc, removed, policy),
      ...flowEdgeRemovalWarnings(doc, removedEdges, policy, removed),
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
  const doc = state$.doc.peek();
  const edges = doc.edges.filter((edge) => removed.has(edge.id));
  if (edges.length === 0) return Promise.resolve(true);
  const one = edges.length === 1;
  const policy = await readDeletionPolicy(state$.canvasName.peek(), doc, new Set(), edges);
  return askConfirm({
    source: "edge-delete",
    title: one ? "Delete this relation?" : `Delete ${edges.length} relations?`,
    body: flowEdgeRemovalWarnings(doc, edges, policy),
    confirmLabel: one ? "Delete relation" : `Delete ${edges.length} relations`,
    tone: "danger",
  });
};
