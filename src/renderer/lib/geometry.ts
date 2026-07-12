import type { CanvasDoc } from "@shared/canvas";
import type { CanvasNode } from "@shared/canvas";
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

export const syncPositions = (positions: ReadonlyMap<string, { x: number; y: number }>): void => {
  const doc: CanvasDoc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((node) => {
      const pos = positions.get(node.id);
      return pos ? { ...node, x: Math.round(pos.x), y: Math.round(pos.y) } : node;
    }),
  }, false, true);
};
