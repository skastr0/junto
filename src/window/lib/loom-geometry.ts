/**
 * The loom's pure geometry: what the planner is fed and how a wire's ends are
 * worked out. No React, no React Flow, no observable, so the old canvas
 * (`CanvasLoom`) and the GPU canvas's loom (`canvas/feed/loom.ts`) plan with
 * the same code. Paint and geometry only.
 */
import { MIN_FAN } from "./wire-loom";
import type { LoomEdgeInput, LoomObstacle } from "./wire-loom";
import type { LoomLane } from "./loom-view";
import { nodeBounds } from "@shared/wire-route";
import type { WireDirection, WirePoint } from "@shared/wire-route";
import { wireSides } from "@shared/wire-sides";

/** One measured node: its bounds, whether it is furniture, whether it moves. */
export type LoomNode = {
  readonly nodeId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Groups are geography, not furniture to route around — edges live inside. */
  readonly obstacle: boolean;
  readonly dragging: boolean;
};

/** Shallow geometry key so we don't rebuild on every unrelated store tick. */
export function sameGeometry(a: LoomNode[], b: LoomNode[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.nodeId !== y.nodeId ||
      x.x !== y.x ||
      x.y !== y.y ||
      x.width !== y.width ||
      x.height !== y.height ||
      x.obstacle !== y.obstacle ||
      x.dragging !== y.dragging
    ) {
      return false;
    }
  }
  return true;
}

/** Topology and the side each end leaves from. */
export type EdgeSpec = {
  readonly id: string;
  readonly sourceNodeId: string;
  readonly sourceSide: WireDirection;
  readonly targetNodeId: string;
  readonly targetSide: WireDirection;
};

/** A wire as the loom reads it: its two cards and the sides it holds now. */
export type LoomWire = {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  /** The side each end is held at; null opts the wire out (no known socket). */
  readonly heldSource: WireDirection | null;
  readonly heldTarget: WireDirection | null;
};

/**
 * The wires to plan. A wire's sides are worked out here from where its two
 * cards are now, by the same rule the window uses for its sockets
 * (wireSides). The sockets themselves only move when the model has taken the
 * move, a moment after the drop; reading them would plan every moved wire
 * twice, once on the drop with the old sides and again when the new ones
 * arrive. A wire with an end the loom cannot see keeps the sides it holds.
 */
export function specsOf(
  wires: ReadonlyArray<LoomWire>,
  geometry: ReadonlyArray<LoomNode>,
): EdgeSpec[] {
  const byId = new Map(geometry.map((node) => [node.nodeId, node] as const));
  const out: EdgeSpec[] = [];
  for (const wire of wires) {
    if (!wire.heldSource || !wire.heldTarget) continue;
    const from = byId.get(wire.source);
    const to = byId.get(wire.target);
    const sides = from && to ? wireSides(from, to) : undefined;
    out.push({
      id: wire.id,
      sourceNodeId: wire.source,
      sourceSide: sides?.source ?? wire.heldSource,
      targetNodeId: wire.target,
      targetSide: sides?.target ?? wire.heldTarget,
    });
  }
  return out;
}

export function specKeyOf(spec: EdgeSpec): string {
  return `${spec.id}|${spec.sourceNodeId}|${spec.sourceSide}|${spec.targetNodeId}|${spec.targetSide}`;
}

export function specsKeyOf(specs: ReadonlyArray<EdgeSpec>): string {
  return specs.map(specKeyOf).join(";");
}

/** Handle centre, node-derived. Stitching corrects to the DOM-measured point. */
export function anchorOn(bounds: LoomNode, side: WireDirection): WirePoint {
  switch (side) {
    case "left":
      return { x: bounds.x, y: bounds.y + bounds.height / 2 };
    case "right":
      return { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 };
    case "top":
      return { x: bounds.x + bounds.width / 2, y: bounds.y };
    case "bottom":
      return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height };
  }
}

/**
 * Two wires on one handle: give them a lane each.
 *
 * A cable starts at three, so below `MIN_FAN` the loom lanes nothing — and two
 * edges pinned to the same handle are measured off the same point, run the same
 * final approach, and the second one paints over the first. Around a tasks card
 * that is `manages` disappearing underneath `contributes`: the operator sees one
 * wire reaching the card and one that stops in open space. A pair therefore
 * arrives on two points instead of one, spread across the side it enters.
 *
 * Only pairs. A fan of three and up is the loom's own work, and its members are
 * stitched back onto the live handle, which would throw a lane away and leave a
 * jog where the wire meets the card.
 *
 * The lane is published as well as applied. `routeWire` answers `null` for an
 * open field — a plain run is not a routing failure, it is the ordinary case —
 * and that wire is painted by smooth-step off the live handle coordinates, so
 * an anchor shift alone would reach only the wires that happen to need a
 * detour.
 */
const PAIR_LANE = 7;
/** Keep a lane off the card's own corner, however small the card is. */
const PAIR_LANE_MARGIN = 10;
/** Below this the split is not worth the geometry — the card has no room. */
const PAIR_LANE_MIN = 2;

type LaneEnd = "source" | "target";

/** `${end}|${nodeId}|${side}` — one handle, the same key the loom fans on. */
function laneKey(end: LaneEnd, nodeId: string, side: WireDirection): string {
  return `${end === "source" ? "s" : "t"}|${nodeId}|${side}`;
}

/** Lanes run across the side they leave from, never along it. */
function laneAxisOf(side: WireDirection): "x" | "y" {
  return side === "left" || side === "right" ? "y" : "x";
}

function sideExtentOf(bounds: LoomNode, side: WireDirection): number {
  return side === "left" || side === "right" ? bounds.height : bounds.width;
}

function laned(point: WirePoint, axis: "x" | "y", offset: number): WirePoint {
  return axis === "x"
    ? { x: point.x + offset, y: point.y }
    : { x: point.x, y: point.y + offset };
}

const NO_SHIFT: WirePoint = { x: 0, y: 0 };

/** A perpendicular offset, expressed on the axis the side actually moves on. */
function shiftOn(side: WireDirection, offset: number): WirePoint {
  return laneAxisOf(side) === "x" ? { x: offset, y: 0 } : { x: 0, y: offset };
}

export function laneOffsets(
  inputs: ReadonlyArray<LoomEdgeInput>,
  byId: ReadonlyMap<string, LoomNode>,
): Map<string, LoomLane> {
  const lanes = new Map<string, LoomLane>();
  if (inputs.length < 2) return lanes;

  const groups = new Map<string, number[]>();
  const gather = (key: string, index: number): void => {
    const held = groups.get(key);
    if (held) held.push(index);
    else groups.set(key, [index]);
  };
  inputs.forEach((edge, index) => {
    gather(laneKey("source", edge.sourceNodeId, edge.sourceSide), index);
    gather(laneKey("target", edge.targetNodeId, edge.targetSide), index);
  });

  for (const [key, members] of groups) {
    if (members.length !== 2) continue;
    const end: LaneEnd = key.startsWith("s|") ? "source" : "target";
    const otherKeyOf = (edge: LoomEdgeInput): string =>
      end === "source"
        ? laneKey("target", edge.targetNodeId, edge.targetSide)
        : laneKey("source", edge.sourceNodeId, edge.sourceSide);
    // A member that is a strand at its far end gets stitched to the live
    // handle, which discards the lane. Leave such a pair coincident.
    const standalone = members.every(
      (index) => (groups.get(otherKeyOf(inputs[index]!))?.length ?? 0) < MIN_FAN,
    );
    if (!standalone) continue;

    const first = inputs[members[0]!]!;
    const side = end === "source" ? first.sourceSide : first.targetSide;
    const nodeId = end === "source" ? first.sourceNodeId : first.targetNodeId;
    const bounds = byId.get(nodeId);
    if (!bounds) continue;
    const axis = laneAxisOf(side);
    const lane = Math.min(
      PAIR_LANE,
      sideExtentOf(bounds, side) / 2 - PAIR_LANE_MARGIN,
    );
    if (lane < PAIR_LANE_MIN) continue;

    // Ordered by where the far end sits across the same axis, so the two lanes
    // never cross each other on the way in.
    const farAcross = (index: number): number => {
      const edge = inputs[index]!;
      return (end === "source" ? edge.targetAnchor : edge.sourceAnchor)[axis];
    };
    const ordered = [...members].sort((a, b) => {
      const delta = farAcross(a) - farAcross(b);
      if (delta !== 0) return delta;
      return inputs[a]!.id < inputs[b]!.id ? -1 : 1;
    });
    ordered.forEach((index, order) => {
      const edge = inputs[index]!;
      const held = lanes.get(edge.id) ?? { source: NO_SHIFT, target: NO_SHIFT };
      const shift = shiftOn(
        end === "source" ? edge.sourceSide : edge.targetSide,
        order === 0 ? -lane : lane,
      );
      lanes.set(
        edge.id,
        end === "source"
          ? { source: shift, target: held.target }
          : { source: held.source, target: shift },
      );
    });
  }

  return lanes;
}

/** The published lane, applied to the anchors the planner routes between. */
function laneApplied(
  edge: LoomEdgeInput,
  lane: LoomLane | undefined,
): LoomEdgeInput {
  if (!lane) return edge;
  return {
    ...edge,
    sourceAnchor: laned(
      laned(edge.sourceAnchor, "x", lane.source.x),
      "y",
      lane.source.y,
    ),
    targetAnchor: laned(
      laned(edge.targetAnchor, "x", lane.target.x),
      "y",
      lane.target.y,
    ),
  };
}

export function buildInputs(
  specs: ReadonlyArray<EdgeSpec>,
  geometry: ReadonlyArray<LoomNode>,
): { inputs: LoomEdgeInput[]; lanes: Map<string, LoomLane> } {
  const byId = new Map(geometry.map((node) => [node.nodeId, node] as const));
  const centred: LoomEdgeInput[] = [];
  for (const spec of specs) {
    const from = byId.get(spec.sourceNodeId);
    const to = byId.get(spec.targetNodeId);
    if (!from || !to) continue;
    centred.push({
      id: spec.id,
      sourceNodeId: spec.sourceNodeId,
      sourceSide: spec.sourceSide,
      sourceAnchor: anchorOn(from, spec.sourceSide),
      targetNodeId: spec.targetNodeId,
      targetSide: spec.targetSide,
      targetAnchor: anchorOn(to, spec.targetSide),
    });
  }
  const lanes = laneOffsets(centred, byId);
  return {
    inputs: centred.map((edge) => laneApplied(edge, lanes.get(edge.id))),
    lanes,
  };
}

/** Every node that is new, gone, or not the rectangle it was. */
export function movedNodeIds(before: ReadonlyArray<LoomNode>, after: ReadonlyArray<LoomNode>): Set<string> {
  const was = new Map(before.map((node) => [node.nodeId, node] as const));
  const out = new Set<string>();
  for (const node of after) {
    const prior = was.get(node.nodeId);
    was.delete(node.nodeId);
    if (
      !prior ||
      prior.x !== node.x ||
      prior.y !== node.y ||
      prior.width !== node.width ||
      prior.height !== node.height
    ) {
      out.add(node.nodeId);
    }
  }
  for (const nodeId of was.keys()) out.add(nodeId);
  return out;
}

export function collectObstacles(geometry: ReadonlyArray<LoomNode>): LoomObstacle[] {
  const obstacles: LoomObstacle[] = [];
  for (const node of geometry) {
    if (!node.obstacle) continue;
    obstacles.push({
      nodeId: node.nodeId,
      ...nodeBounds({ x: node.x, y: node.y }, { width: node.width, height: node.height }),
    });
  }
  return obstacles;
}
