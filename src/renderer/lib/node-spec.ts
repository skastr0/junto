import type { CanvasNode } from "@shared/canvas";
import { isGroup } from "@shared/graph";
import { resolveSpec, type NodeSpecValue } from "@shared/physics";

/**
 * Resolve a canvas node (or absence, e.g. a dangling edge endpoint) into the
 * physics kernel's NodeSpec. Single call site for isGroup+kind → NodeSpec
 * across renderer surfaces (inspector, connect preview).
 */
export const specOf = (node: CanvasNode | undefined): NodeSpecValue =>
  resolveSpec({
    isGroup: node !== undefined && isGroup(node),
    kind: node?.ether?.entity?.kind,
  });
