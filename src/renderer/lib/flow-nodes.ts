import type { Node as FlowNodeOf } from "@xyflow/react";
import type { CSSProperties } from "react";
import type { Node, NodeKind, Region } from "@shared/model";
import { regionStack, type Canvas } from "@shared/model/canvas";
import { titleOf } from "@shared/model/title";
import { INSTRUMENT_KINDS, INSTRUMENT_RING_PX, renderedNodeSize, SEAT_RING_PX } from "./node-geometry";
import { regionNameSlot, sameNameSlot, type RegionNameSlot } from "./region-name-slot";
import { evenRingCaps, seatRingCaps, type RoomNode } from "./seat-ring-room";

// A canvas's nodes as React Flow draws them, worked out from the model and
// carrying no node: a card is handed its canvas and id and reads the rest from
// the node store, so a rename or a recolour never passes through here.

// Z bands, as in convert.ts: regions at their nesting depth behind the wires,
// every other card above them.
const REGION_Z_BASE = 0;
const CARD_Z = 32;

/** The far ring's scale that region names plan around (canvas-tier.ts farSeatScale at 0.26). */
const FAR_RING_SLOT_SCALE = 3;

export type ModelNodeData = {
  readonly canvas: string;
  readonly id: string;
  readonly kind: NodeKind;
  readonly blocked: boolean;
  /** Regions only: how many regions contain this one. */
  readonly regionDepth?: number;
  /** Regions only: where the region prints its name when the camera pulls back. */
  readonly nameSlot?: RegionNameSlot;
  /** Ringed seats only: how far the ring may grow without meeting a neighbour. */
  readonly ringCap?: number;
  /** Agent seats only: the innermost region holding the seat, "" for none. */
  readonly seatRegion?: string;
  /** Regions only: the region directly holding this one, when nested. */
  readonly parentRegion?: string;
};

export type ModelFlowNode = FlowNodeOf<ModelNodeData>;

/** Reuses a flow node while everything it was built from is unchanged. */
export type ModelFlowCache = Map<string, { readonly key: string; readonly flow: ModelFlowNode }>;

/** Which React Flow component draws a kind (components/nodes/index.ts). */
const flowType = (kind: NodeKind): "group" | "file" | "link" | "text" =>
  kind === "region" ? "group" : kind === "file" ? "file" : kind === "link" || kind === "page" ? "link" : "text";

const ringPxOf = (kind: NodeKind): number | undefined =>
  kind === "agent" ? SEAT_RING_PX : INSTRUMENT_KINDS.has(kind) ? INSTRUMENT_RING_PX : undefined;

type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

const rectKey = (rect: Rect): string =>
  `${String(rect.x)},${String(rect.y)},${String(rect.width)},${String(rect.height)}`;

type RegionFacts = { readonly depth: number; readonly nameSlot: RegionNameSlot };

/** Name slots by region id, reused while the region's own inputs are unchanged. */
const nameSlotMemo = new Map<string, { readonly key: string; readonly slot: RegionNameSlot }>();

/**
 * Nesting depth and name slot for every region, and the region directly
 * holding each node, in one pass. Only regions contain, so the stacks are
 * read off a canvas of regions alone.
 */
const regionFacts = (
  canvas: Canvas,
  nodes: ReadonlyArray<Node>,
  ringCaps: ReadonlyMap<string, number>,
  parentOf: Map<string, string>,
): ReadonlyMap<string, RegionFacts> => {
  const regions = nodes.filter((node): node is Region => node.kind === "region");
  const regionsOnly: Canvas = {
    name: canvas.name,
    seq: canvas.seq,
    nodes: new Map(regions.map((region) => [region.id, region])),
    wires: new Map(),
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
    const ringPx = ringPxOf(node.kind);
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
    const memo = nameSlotMemo.get(region.id);
    const slot = memo?.key === key ? memo.slot : regionNameSlot(region, kids, cards, label);
    if (memo?.key !== key) nameSlotMemo.set(region.id, { key, slot });
    live.add(region.id);
    facts.set(region.id, { depth: depths.get(region.id) ?? 0, nameSlot: slot });
  }
  for (const id of nameSlotMemo.keys()) if (!live.has(id)) nameSlotMemo.delete(id);
  return facts;
};

/**
 * The React Flow nodes for a canvas, in paint order. `nodes` is the canvas's
 * nodes lowest first; `blocked` is the ids the execution graph holds blocked.
 */
export const flowNodesFromModel = (
  canvas: Canvas,
  nodes: ReadonlyArray<Node>,
  blocked: ReadonlySet<string>,
  cache?: ModelFlowCache,
): ModelFlowNode[] => {
  const room: RoomNode[] = nodes
    .filter((node) => node.kind !== "region")
    .map((node) => {
      const ringPx = ringPxOf(node.kind);
      return { id: node.id, x: node.x, y: node.y, ...renderedNodeSize(node.kind, node), ...(ringPx !== undefined ? { ringPx } : {}) };
    });
  const roomCaps = seatRingCaps(room);
  const parentOf = new Map<string, string>();
  const factsByRegion = regionFacts(canvas, nodes, roomCaps, parentOf);
  const ringCaps = evenRingCaps(roomCaps, (id) => parentOf.get(id));
  const seen = new Set<string>();
  const built = nodes.map((node) => {
    seen.add(node.id);
    const region = node.kind === "region";
    const facts = region ? factsByRegion.get(node.id) : undefined;
    const regionDepth = region ? (facts?.depth ?? 0) : undefined;
    const nameSlot = facts?.nameSlot;
    const ringCap = ringCaps.get(node.id);
    const seatRegion = node.kind === "agent" ? (parentOf.get(node.id) ?? "") : undefined;
    const parentRegion = region ? parentOf.get(node.id) : undefined;
    const isBlocked = blocked.has(node.id);
    const size = renderedNodeSize(node.kind, node);
    const name = titleOf(node);
    // Everything the flow node says. A field of the node that is not here
    // (colour, a seat's harness, a note's text) never remints it.
    const key = [
      node.kind, node.x, node.y, size.width, size.height, isBlocked ? 1 : 0,
      regionDepth ?? "", ringCap ?? "", seatRegion ?? "\u0000", parentRegion ?? "", name,
    ].join("\u0001");
    const cached = cache?.get(node.id);
    if (cached !== undefined && cached.key === key && sameNameSlot(cached.flow.data.nameSlot, nameSlot)) {
      return cached.flow;
    }
    const flow: ModelFlowNode = {
      id: node.id,
      type: flowType(node.kind),
      position: { x: node.x, y: node.y },
      data: {
        canvas: canvas.name,
        id: node.id,
        kind: node.kind,
        blocked: isBlocked,
        ...(regionDepth !== undefined ? { regionDepth } : {}),
        ...(nameSlot ? { nameSlot } : {}),
        ...(ringCap !== undefined ? { ringCap } : {}),
        ...(seatRegion !== undefined ? { seatRegion } : {}),
        ...(parentRegion !== undefined ? { parentRegion } : {}),
      },
      // A ringed seat carries its ring's room to CSS (canvas-lod.css). A
      // region's wrapper is pointer-transparent so a rubber band can start
      // inside it; only its chrome takes the pointer (GroupNode).
      style: region
        ? { ...size, pointerEvents: "none" as const }
        : ringCap !== undefined
          ? ({ ...size, "--ring-cap": String(ringCap) } as CSSProperties)
          : size,
      zIndex: region ? REGION_Z_BASE + (regionDepth ?? 0) : CARD_Z,
      // Regions, bare labels and git cards never grow connectors.
      connectable: !region && node.kind !== "label" && node.kind !== "git",
      ariaLabel: name,
      focusable: true,
      selectable: !region,
      draggable: !region,
    };
    cache?.set(node.id, { key, flow });
    return flow;
  });
  if (cache) for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
  return built;
};
