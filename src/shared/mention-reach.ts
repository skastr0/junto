/**
 * What a `#` or a page `@` may name from a place (plan 0.10, 03 section 3),
 * one rule for the composer's offer and main's check. From a seat (its
 * mail): the resources it reaches, a live overseer's every task board
 * included (`resourcesSeatReaches`), and the pages in its reach. From a
 * resource (its comments): the resources and pages in its reach, itself
 * included. Sorted by id.
 */
import { MENTION_KIND_OF_NODE } from "./mention";
import { frameContains, type Canvas } from "./model/canvas";
import type { NodeKind } from "./model/kinds";
import type { NodeId } from "./physics/schema";
import { inReachOfRegion, isResourceKind, reaches, resourcesSeatReaches, type ReachCanvas, type ReachNode } from "./region-reach";

const isPageKind = (kind: NodeKind): boolean => kind === "page";

const byId = (a: ReachNode, b: ReachNode): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const mentionableNodesFrom = (canvas: ReachCanvas, from: NodeId): ReadonlyArray<ReachNode> => {
  if (canvas.nodes.get(from)?.kind === "agent") {
    const pages = [...canvas.nodes.values()].filter((node) => isPageKind(node.kind) && reaches(canvas, from, node.id));
    return [...resourcesSeatReaches(canvas, from), ...pages].sort(byId);
  }
  return [...canvas.nodes.values()]
    .filter((node) => (isResourceKind(node.kind) || isPageKind(node.kind)) && (node.id === from || reaches(canvas, from, node.id)))
    .sort(byId);
};

const isMentionableKind = (kind: NodeKind): boolean => Object.hasOwn(MENTION_KIND_OF_NODE, kind);

/**
 * What a briefing may mention (plan 0.11, 08). A region's instruction and
 * references: what a seat inside the region reaches, seats, resources and
 * pages in it, below it and above it, and every node a seat of the region is
 * wired to. The app's texts, with no region: every node on the canvas a
 * mention can name. Sorted by id.
 */
export const briefingMentionableNodes = (
  canvas: Pick<Canvas, "nodes" | "wires">,
  regionId?: NodeId,
): ReadonlyArray<ReachNode> => {
  if (regionId === undefined) return [...canvas.nodes.values()].filter((node) => isMentionableKind(node.kind)).sort(byId);
  const region = canvas.nodes.get(regionId);
  if (region?.kind !== "region") return [];
  const found = new Map(inReachOfRegion(canvas, regionId, isMentionableKind).map((node) => [node.id, node]));
  const seats = new Set([...canvas.nodes.values()].filter((node) => node.kind === "agent" && frameContains(region, node)).map((node) => node.id));
  for (const wire of canvas.wires.values()) {
    const far = seats.has(wire.from) ? wire.to : seats.has(wire.to) ? wire.from : undefined;
    const node = far === undefined ? undefined : canvas.nodes.get(far);
    if (node !== undefined && isMentionableKind(node.kind)) found.set(node.id, node);
  }
  return [...found.values()].sort(byId);
};
