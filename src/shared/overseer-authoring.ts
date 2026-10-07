import type { CanvasDoc, CanvasNode } from "./canvas";

// What is left of the overseer's document rules: the one the canvas service's
// document write still applies, so a saved document can never mint, restore or
// copy an overseer grant. The overseer itself reads and writes the model
// (overseer-rules.ts). This file is deleted with the canvas service.

type SeatBinding = { readonly hostId: string; readonly bindingId: string };

const trimDefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

const nodeSeatBinding = (node: CanvasNode): SeatBinding | undefined => {
  if (node.ether?.entity?.kind !== "agent") return undefined;
  const bindingId = trimDefined(node.ether.terminal?.bindingId);
  if (bindingId === undefined) return undefined;
  return { hostId: trimDefined(node.ether.host) ?? "local", bindingId };
};

const nodeHasOverseerGrant = (node: CanvasNode): boolean =>
  node.ether?.overseer === true && nodeSeatBinding(node) !== undefined;

const withoutKey = <T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> => {
  const { [key]: _removed, ...rest } = value;
  return rest;
};

/** Set or clear `ether.overseer` without minting empty ether objects. */
const applyOverseerFlag = (node: CanvasNode, overseer: boolean): CanvasNode => {
  const ether = node.ether;
  if (overseer) {
    return { ...node, ether: { ...(ether ?? {}), overseer: true } };
  }
  if (ether?.overseer !== true) return node;
  const next = withoutKey(ether, "overseer");
  if (Object.keys(next).length === 0) {
    return withoutKey(node, "ether") as CanvasNode;
  }
  return { ...node, ether: next };
};

/**
 * Incoming documents never mint, restore, or copy overseer. Live grant survives
 * only when the same node id keeps the same (host, binding). New, replaced,
 * reseated, or copied nodes are cleared even if they alias a live binding.
 */
export const reconcileOverseerGrants = (
  previous: CanvasDoc,
  next: CanvasDoc,
): CanvasDoc => {
  const previousById = new Map(previous.nodes.map((node) => [node.id, node]));
  return {
    ...next,
    nodes: next.nodes.map((node) => {
      const prior = previousById.get(node.id);
      const nextSeat = nodeSeatBinding(node);
      const priorSeat = prior === undefined ? undefined : nodeSeatBinding(prior);
      const unchanged =
        prior !== undefined &&
        nextSeat !== undefined &&
        priorSeat !== undefined &&
        nextSeat.hostId === priorSeat.hostId &&
        nextSeat.bindingId === priorSeat.bindingId;
      return applyOverseerFlag(
        node,
        unchanged && prior !== undefined && nodeHasOverseerGrant(prior),
      );
    }),
  };
};
