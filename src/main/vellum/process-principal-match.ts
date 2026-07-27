import type { CanvasNode } from "@shared/canvas";
import { isGroup } from "@shared/graph";
import { resolveSpec, roleOf } from "@shared/physics";
import type { ProcessPrincipal } from "./process-identity";

/**
 * Match one main-owned process principal to one live canvas actor seat.
 *
 * Every anchor carried by the registration is authoritative. A matching node
 * id must never hide a stale agent key or terminal binding after a seat is
 * reused. At least one anchor is required.
 */
export const matchesProcessPrincipal = (
  node: CanvasNode,
  principal: ProcessPrincipal,
): boolean => {
  const kind = node.ether?.entity?.kind;
  if (roleOf(resolveSpec({ kind, isGroup: isGroup(node) })) !== "actor") {
    return false;
  }
  if (principal.nodeId !== undefined && node.id !== principal.nodeId) {
    return false;
  }
  if (
    principal.agentKey !== undefined &&
    node.ether?.entity?.name !== principal.agentKey
  ) {
    return false;
  }
  if (
    principal.bindingId !== undefined &&
    node.ether?.terminal?.bindingId !== principal.bindingId
  ) {
    return false;
  }
  return (
    principal.nodeId !== undefined ||
    principal.agentKey !== undefined ||
    principal.bindingId !== undefined
  );
};
