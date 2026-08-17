import type { CanvasDoc } from "@shared/canvas";
import type { CanvasNode, GroupNode } from "@shared/canvas";
import { commitDoc } from "./mutations";
import { state$ } from "./state";

type Point = { readonly x: number; readonly y: number };
type Size = { readonly width: number; readonly height: number };

const overlaps = (a: { readonly x: number; readonly y: number } & Size, b: CanvasNode): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

// Find the nearest visible slot around the viewport center. The first few
// items on an empty canvas still use the deterministic grid in Canvas; this
// helper covers subsequent additions and avoids stacking on existing nodes.
export const findOpenPosition = (nodes: ReadonlyArray<CanvasNode>, center: Point, size: Size): Point => {
  const gap = 28;
  const step = Math.max(size.width, size.height) + gap;
  for (let radius = 0; radius < 18; radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const candidate = {
          x: Math.round(center.x - size.width / 2 + dx * step),
          y: Math.round(center.y - size.height / 2 + dy * step),
          width: size.width,
          height: size.height,
        };
        if (!nodes.some((node) => overlaps(candidate, node))) return { x: candidate.x, y: candidate.y };
      }
    }
  }
  return { x: Math.round(center.x - size.width / 2), y: Math.round(center.y - size.height / 2) };
};

export const resizeNode = (id: string, params: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((node) => node.id === id ? {
      ...node,
      x: Math.round(params.x),
      y: Math.round(params.y),
      width: Math.round(params.width),
      height: Math.round(params.height),
    } : node),
  }, false, true);
};

// Drag-hold interaction ONLY — not membership truth. Every node — including
// nested regions — whose CENTER lies within the region's rect, the region
// itself always excluded. Pure and re-derived at drag time; never persisted
// (the product's derived-state law). Unlike the shared membership authority
// (groupMembers / I9 in shared/graph.ts: full-rect containment, flat POC
// rule that skips nested groups), this exists solely to decide which nodes
// ride along when an operator drags a hold region — center-point, and
// deliberately includes nested regions so a region can hold a region.
export const dragHoldMemberIds = (doc: CanvasDoc, regionNode: GroupNode): string[] =>
  doc.nodes
    .filter((node) => node.id !== regionNode.id)
    .filter((node) => {
      const cx = node.x + node.width / 2;
      const cy = node.y + node.height / 2;
      return (
        cx >= regionNode.x &&
        cx <= regionNode.x + regionNode.width &&
        cy >= regionNode.y &&
        cy <= regionNode.y + regionNode.height
      );
    })
    .map((node) => node.id);

export const syncPositions = (positions: ReadonlyMap<string, { x: number; y: number }>): void => {
  if (state$.settings.station.role.peek() === "remote") return;
  const doc: CanvasDoc = state$.doc.peek();
  // Preserve CanvasNode identity when rounded coords are unchanged so the
  // FlowIdentityCache (convert.toFlow) keeps reminting only moved nodes.
  let changed = false;
  const nodes = doc.nodes.map((node) => {
    const pos = positions.get(node.id);
    if (!pos) return node;
    const x = Math.round(pos.x);
    const y = Math.round(pos.y);
    if (x === node.x && y === node.y) return node;
    changed = true;
    return { ...node, x, y };
  });
  if (!changed) return;
  commitDoc({ ...doc, nodes }, false, true);
};
