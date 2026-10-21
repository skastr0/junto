/**
 * What a `#` or a page `@` may name from a place (plan 0.10, 03 section 3),
 * one rule for the composer's offer and main's check. From a seat (its
 * mail): the resources it reaches, a live overseer's every task board
 * included (`resourcesSeatReaches`), and the pages in its reach. From a
 * resource (its comments): the resources and pages in its reach, itself
 * included. Sorted by id.
 */
import type { NodeKind } from "./model/kinds";
import type { NodeId } from "./physics/schema";
import { isResourceKind, reaches, resourcesSeatReaches, type ReachCanvas, type ReachNode } from "./region-reach";

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
