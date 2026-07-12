import type { CanvasDoc, CanvasNode, GroupNode } from "./canvas";

// Derived state. Never persisted — recomputed from the document so the
// .canvas file cannot go incoherent.

// Semantics: an edge of kind "blocks" means fromNode blocks toNode. The
// blocked closure is every node reachable from a blocker-flagged node by
// following blocks edges forward.
export const blockedClosure = (doc: CanvasDoc): ReadonlySet<string> => {
  const forward = new Map<string, string[]>();
  for (const edge of doc.edges) {
    if (edge.ether?.kind !== "blocks") continue;
    const targets = forward.get(edge.fromNode) ?? [];
    targets.push(edge.toNode);
    forward.set(edge.fromNode, targets);
  }

  const blocked = new Set<string>();
  const queue = doc.nodes
    .filter((node) => node.ether?.flags?.includes("blocker"))
    .map((node) => node.id);

  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const target of forward.get(current) ?? []) {
      if (!blocked.has(target)) {
        blocked.add(target);
        queue.push(target);
      }
    }
  }

  return blocked;
};

// Edges participating in the blocked closure: blocks edges whose source is a
// blocker or itself blocked. These are the edges the surface animates.
export const blockedEdgeIds = (doc: CanvasDoc): ReadonlySet<string> => {
  const blocked = blockedClosure(doc);
  const blockers = new Set(
    doc.nodes.filter((node) => node.ether?.flags?.includes("blocker")).map((node) => node.id),
  );
  return new Set(
    doc.edges
      .filter(
        (edge) =>
          edge.ether?.kind === "blocks" &&
          (blockers.has(edge.fromNode) || blocked.has(edge.fromNode)),
      )
      .map((edge) => edge.id),
  );
};

export const isGroup = (node: CanvasNode): node is GroupNode => node.type === "group";

const containsCenter = (group: GroupNode, node: CanvasNode): boolean => {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  return (
    cx >= group.x && cx <= group.x + group.width && cy >= group.y && cy <= group.y + group.height
  );
};

// Named geography: membership is containment of the node's center inside the
// group rect. Groups never contain groups (flat, POC rule).
export const groupMembers = (doc: CanvasDoc): ReadonlyMap<string, ReadonlyArray<string>> => {
  const groups = doc.nodes.filter(isGroup);
  const members = new Map<string, string[]>();
  for (const group of groups) {
    members.set(
      group.id,
      doc.nodes
        .filter((node) => node.id !== group.id && !isGroup(node) && containsCenter(group, node))
        .map((node) => node.id),
    );
  }
  return members;
};
