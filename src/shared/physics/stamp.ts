import type { CanvasDoc, CanvasEdge } from "../canvas";
import { ACTOR_ACTOR_INBOX_PORTS, resolveSpec, roleOf } from "./kinds";

// Ports stamped onto pre-existing actor↔actor edges that lack `ether.ports`
// come from the kind table's actor inbox (kinds.ts) — stamping preserves the
// pre-S3 Full-default inbox behavior as an explicit mask (I8/I21) without
// restating which ports that is.

const nodeRole = (
  nodes: CanvasDoc["nodes"],
  id: string,
): string | undefined => {
  const node = nodes.find((n) => n.id === id);
  if (node === undefined) return undefined;
  const kind =
    node.ether !== undefined &&
    typeof node.ether === "object" &&
    node.ether !== null &&
    "entity" in node.ether &&
    node.ether.entity !== undefined &&
    typeof node.ether.entity === "object" &&
    node.ether.entity !== null &&
    "kind" in node.ether.entity
      ? (node.ether.entity as { kind?: string }).kind
      : undefined;
  return roleOf(resolveSpec({ isGroup: node.type === "group", kind }));
};

const isActorActorEdge = (
  edge: CanvasEdge,
  nodes: CanvasDoc["nodes"],
): boolean => {
  const from = nodeRole(nodes, edge.fromNode);
  const to = nodeRole(nodes, edge.toNode);
  return from === "actor" && to === "actor";
};

/**
 * One-time migration stamp: actor↔actor edges with no `ether.ports` receive
 * `ports: ["msg.list","msg.send"]`. Idempotent — only writes when absent.
 * Never stamps actor↔sink (or any non-actor↔actor) edges.
 *
 * Pure: returns the same reference when nothing changes (byte-stable callers
 * should still compare via serializeCanvas for durability identity).
 */
export const stampActorActorMsgPorts = (doc: CanvasDoc): CanvasDoc => {
  let changed = false;
  const edges = doc.edges.map((edge) => {
    if (!isActorActorEdge(edge, doc.nodes)) return edge;
    // Absent only — empty array or any present ports array is authorial.
    if (edge.ether?.ports !== undefined) return edge;
    changed = true;
    return {
      ...edge,
      ether: {
        ...edge.ether,
        ports: [...ACTOR_ACTOR_INBOX_PORTS],
      },
    };
  });
  if (!changed) return doc;
  return { ...doc, edges };
};
