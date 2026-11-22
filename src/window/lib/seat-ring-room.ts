// How large a seat's ring may grow when the camera pulls back.
//
// At the far tier a seat is its portrait in its ring, held at a floor size on
// screen (canvas-tier.ts farSeatScale), so the ring grows in canvas units as
// the camera pulls back. It never grows into a neighbour: each ring is capped
// at the room around its centre, half the way to the next ring (both grow)
// and all the way to any card's edge, less a gap, counting the halo a seat
// that needs the operator wears. Seats of one region share the region's
// smallest cap, so they read as one size. The cap is a scale factor on
// the ring's own size, computed once per projection (convert.ts) and handed to
// CSS as --ring-cap, so a zoom measures nothing.

import { SEAT_SCALE_MAX } from "./canvas-tier";

export type RoomRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** A node on the board: a ringed seat (with its ring's diameter) or any other card. */
export type RoomNode = RoomRect & { readonly id: string; readonly ringPx?: number };

/** Clear ground kept between two rings, or a ring and a card, in canvas units. */
export const RING_GAP = 12;
/** The largest a ring grows (canvas-tier.ts SEAT_SCALE_MAX). */
export const RING_SCALE_MAX = SEAT_SCALE_MAX;
/**
 * A ring's footprint as a multiple of its diameter: the needs-you halo is
 * drawn just outside the ring (canvas-lod.css), and a halo must not meet a
 * neighbour either.
 */
export const RING_FOOTPRINT = 1.16;

const centre = (rect: RoomRect): readonly [number, number] => [rect.x + rect.width / 2, rect.y + rect.height / 2];

const distanceToRect = (x: number, y: number, rect: RoomRect): number => {
  const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.width));
  const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
};

/**
 * Scale cap per ringed seat: the ring may grow to this multiple of its own
 * size and still keep RING_GAP from every other ring and card. Never below 1
 * (the size it is drawn at up close) and never above RING_SCALE_MAX.
 */
export const seatRingCaps = (nodes: ReadonlyArray<RoomNode>): ReadonlyMap<string, number> => {
  const caps = new Map<string, number>();
  const centres = nodes.map(centre);
  // A node lowers a ring's cap only when its room is under the ring's
  // starting radius: a ring's centre within twice that radius and the gap, a
  // card's edge within the radius and the gap. So each seat is tested only
  // against the nodes on a grid of that reach around it, and gets exactly
  // the cap the whole board would give it.
  let largest = 0;
  for (const node of nodes) if (node.ringPx !== undefined) largest = Math.max(largest, node.ringPx);
  if (largest === 0) return caps;
  const reach = RING_SCALE_MAX * largest * RING_FOOTPRINT + RING_GAP;
  const cells = new Map<string, number[]>();
  const wide: number[] = [];
  const key = (cx: number, cy: number): string => `${String(cx)},${String(cy)}`;
  nodes.forEach((node, index) => {
    if (node.ringPx !== undefined) {
      const [x, y] = centres[index]!;
      const at = key(Math.floor(x / reach), Math.floor(y / reach));
      const list = cells.get(at);
      if (list === undefined) cells.set(at, [index]);
      else list.push(index);
      return;
    }
    const x0 = Math.floor(node.x / reach);
    const y0 = Math.floor(node.y / reach);
    const x1 = Math.floor((node.x + node.width) / reach);
    const y1 = Math.floor((node.y + node.height) / reach);
    // A card wider than the board has nodes is tested for every seat, so no
    // board costs more than the plain pass over every pair.
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > nodes.length) {
      wide.push(index);
      return;
    }
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        const list = cells.get(key(cx, cy));
        if (list === undefined) cells.set(key(cx, cy), [index]);
        else list.push(index);
      }
    }
  });
  nodes.forEach((node, index) => {
    if (node.ringPx === undefined) return;
    const [x, y] = centres[index]!;
    const footprint = node.ringPx * RING_FOOTPRINT;
    let radius = (RING_SCALE_MAX * footprint) / 2;
    const test = (otherIndex: number): void => {
      if (otherIndex === index) return;
      const other = nodes[otherIndex]!;
      const room =
        other.ringPx !== undefined
          ? Math.hypot(centres[otherIndex]![0] - x, centres[otherIndex]![1] - y) / 2 - RING_GAP / 2
          : distanceToRect(x, y, other) - RING_GAP;
      if (room < radius) radius = room;
    };
    const cx = Math.floor(x / reach);
    const cy = Math.floor(y / reach);
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (const other of cells.get(key(cx + dx, cy + dy)) ?? []) test(other);
    for (const other of wide) test(other);
    const cap = (radius * 2) / footprint;
    caps.set(node.id, Math.round(Math.min(RING_SCALE_MAX, Math.max(1, cap)) * 100) / 100);
  });
  return caps;
};

/**
 * One size per region: every ringed seat in a group (its innermost region)
 * takes the group's smallest cap, so the seats of one region read as one
 * size, never a mix of large and small. Seats in no group keep their own.
 */
export const evenRingCaps = (
  caps: ReadonlyMap<string, number>,
  groupOf: (id: string) => string | undefined,
): ReadonlyMap<string, number> => {
  const least = new Map<string, number>();
  for (const [id, cap] of caps) {
    const group = groupOf(id);
    if (group === undefined) continue;
    least.set(group, Math.min(least.get(group) ?? Infinity, cap));
  }
  const out = new Map<string, number>();
  for (const [id, cap] of caps) {
    const group = groupOf(id);
    out.set(id, group === undefined ? cap : (least.get(group) ?? cap));
  }
  return out;
};
