/**
 * The card layout facts the contract's `CardDerived` carries, derived with
 * no card mounted: each ringed seat's ring cap (`seat-ring-room.ts`, evened
 * per region) and each region's name slot (`region-name-slot.ts`). This is
 * flow-nodes.ts's geometry pass without the React Flow node: same room rects,
 * same region stacks, same memo, so a card op's `derived` says what the DOM
 * canvas's flow node data says.
 */
import type { Node, Region } from "@shared/model";
import { regionStack, type Placed } from "@shared/model/canvas";
import type { RegionNameSlot as ContractNameSlot } from "../contract";
import { holdsSeatRing, renderedNodeSize, SEAT_RING_PX } from "../../lib/node-geometry";
import { regionNameSlot, type RegionNameSlot } from "../../lib/region-name-slot";
import { evenRingCaps, seatRingCaps, type RoomNode } from "../../lib/seat-ring-room";
import { modelStore } from "../../lib/use-model";

/** The far ring's scale that region names plan around (canvas-tier.ts farSeatScale at 0.26). */
const FAR_RING_SLOT_SCALE = 3;

type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

const rectKey = (rect: Rect): string =>
  `${String(rect.x)},${String(rect.y)},${String(rect.width)},${String(rect.height)}`;

const ringPxOf = (node: Node): number | undefined =>
  holdsSeatRing(node.kind, node.kind === "file" ? node.path : undefined) ? SEAT_RING_PX : undefined;

type RegionFacts = { readonly depth: number; readonly nameSlot: RegionNameSlot };

/** Name slots by `${canvas}\n${regionId}`, reused while the region's own inputs are unchanged. */
const nameSlotMemo = new Map<string, { readonly key: string; readonly slot: RegionNameSlot }>();

/**
 * Nesting depth, name slot and parent for every region, and every node's
 * innermost region — flow-nodes.ts's `regionFacts` verbatim, so the feed's
 * `parentOf` is the same map the flow projection builds.
 */
const regionFacts = (
  canvasName: string,
  nodes: ReadonlyArray<Node>,
  ringCaps: ReadonlyMap<string, number>,
  parentOf: Map<string, string>,
): ReadonlyMap<string, RegionFacts> => {
  const regions = nodes.filter((node): node is Region => node.kind === "region");
  const regionsOnly: Placed = {
    nodes: new Map(regions.map((region) => [region.id, region])),
  };
  const depths = new Map<string, number>();
  const children = new Map<string, Region[]>();
  const members = new Map<string, Rect[]>();
  for (const region of regions) {
    const stack = regionStack(regionsOnly, region.id);
    depths.set(region.id, stack.length);
    const parent = stack[stack.length - 1];
    if (parent !== undefined) {
      children.set(parent.id, [...(children.get(parent.id) ?? []), region]);
      parentOf.set(region.id, parent.id);
    }
  }
  for (const node of nodes) {
    if (node.kind === "region") continue;
    const stack = regionStack(regionsOnly, node);
    const parent = stack[stack.length - 1];
    if (parent === undefined) continue;
    parentOf.set(node.id, parent.id);
    const size = renderedNodeSize(node.kind, node);
    const list = members.get(parent.id) ?? [];
    list.push({ x: node.x, y: node.y, width: size.width, height: size.height });
    // A far seat's ring reaches past its card: the name keeps clear of the
    // ring as drawn mid-way through the far tier, or of its room if less.
    const ringPx = ringPxOf(node);
    const cap = ringCaps.get(node.id);
    if (ringPx !== undefined && cap !== undefined) {
      const side = ringPx * Math.min(cap, FAR_RING_SLOT_SCALE);
      list.push({ x: node.x + size.width / 2 - side / 2, y: node.y + size.height / 2 - side / 2, width: side, height: side });
    }
    members.set(parent.id, list);
  }
  const facts = new Map<string, RegionFacts>();
  const live = new Set<string>();
  for (const region of regions) {
    const label = region.label ?? "";
    const kids = children.get(region.id) ?? [];
    const cards = members.get(region.id) ?? [];
    const key = [label, rectKey(region), ...kids.map(rectKey), "|", ...cards.map(rectKey)].join(";");
    const memoKey = `${canvasName}\n${region.id}`;
    const memo = nameSlotMemo.get(memoKey);
    const slot = memo?.key === key ? memo.slot : regionNameSlot(region, kids, cards, label);
    if (memo?.key !== key) nameSlotMemo.set(memoKey, { key, slot });
    live.add(region.id);
    facts.set(region.id, { depth: depths.get(region.id) ?? 0, nameSlot: slot });
  }
  for (const memoKey of [...nameSlotMemo.keys()]) {
    if (memoKey.startsWith(`${canvasName}\n`) && !live.has(memoKey.slice(canvasName.length + 1))) nameSlotMemo.delete(memoKey);
  }
  return facts;
};

export type CardLayout = {
  /** Every node's innermost region (regions included), as flow-nodes' parentOf. */
  readonly parentOf: ReadonlyMap<string, string>;
  /** Ringed seats' evened ring caps; absent means the seat keeps its own room cap of 1. */
  readonly ringCaps: ReadonlyMap<string, number>;
  /** Regions' name slots, in the contract's shape. */
  readonly nameSlots: ReadonlyMap<string, ContractNameSlot>;
};

/**
 * The layout pass for one canvas, read inside `observe`: every node's rect
 * and kind is tracked, so a move, resize, restack or membership change
 * re-derives it. Mirrors flowNodesFromModel's room and regionFacts.
 */
export const cardLayout = (canvasName: string): CardLayout => {
  const model = modelStore.canvas$(canvasName);
  const nodes = new Map<string, Node>();
  for (const id of model.nodeIds.get()) {
    const node = model.nodes[id].get();
    if (node !== undefined) nodes.set(id, node);
  }
  const list = [...nodes.values()];
  const room: RoomNode[] = list
    .filter((node) => node.kind !== "region")
    .map((node) => {
      const ringPx = ringPxOf(node);
      return { id: node.id, x: node.x, y: node.y, ...renderedNodeSize(node.kind, node), ...(ringPx !== undefined ? { ringPx } : {}) };
    });
  const roomCaps = seatRingCaps(room);
  const parentOf = new Map<string, string>();
  const factsByRegion = regionFacts(canvasName, list, roomCaps, parentOf);
  const ringCaps = evenRingCaps(roomCaps, (id) => parentOf.get(id));
  const nameSlots = new Map<string, ContractNameSlot>();
  for (const [id, facts] of factsByRegion) {
    const slot = facts.nameSlot;
    nameSlots.set(id, {
      rect: { x: slot.x, y: slot.y, width: slot.width, height: slot.height },
      fontSize: slot.fontSize,
      nested: facts.depth >= 1,
    });
  }
  return { parentOf, ringCaps, nameSlots };
};
