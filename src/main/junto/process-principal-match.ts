import type { Node } from "@shared/model";
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
  node: Node,
  principal: ProcessPrincipal,
): boolean => {
  const kind = node.kind;
  if (roleOf(resolveSpec({ kind, isGroup: node.kind === "region" })) !== "actor") {
    return false;
  }
  if (principal.nodeId !== undefined && node.id !== principal.nodeId) {
    return false;
  }
  if (
    principal.agentKey !== undefined &&
    (node.kind !== "agent" || node.agentKey !== principal.agentKey)
  ) {
    return false;
  }
  if (
    principal.bindingId !== undefined &&
    ((node.kind !== "agent" && node.kind !== "terminal") || node.bindingId !== principal.bindingId)
  ) {
    return false;
  }
  return (
    principal.nodeId !== undefined ||
    principal.agentKey !== undefined ||
    principal.bindingId !== undefined
  );
};
