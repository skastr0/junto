import type { CanvasNode } from "@shared/canvas";
import { isGroup } from "@shared/graph";
import { resolveSpec, type ResolvedSpecValue } from "@shared/physics";

/**
 * Resolve a canvas node (or absence, e.g. a dangling edge endpoint) into the
 * physics kernel's role/offers spec. Single call site for isGroup+kind →
 * ResolvedSpec across renderer surfaces (inspector, connect preview).
 */
export const specOf = (node: CanvasNode | undefined): ResolvedSpecValue =>
  resolveSpec({
    isGroup: node !== undefined && isGroup(node),
    kind: node?.ether?.entity?.kind,
  });
