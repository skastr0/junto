/**
 * Picking (docs/canvas-gpu-architecture.md, section 15).
 *
 * One function over the engine's spatial index, aware of paint order. A point
 * in board units becomes the topmost card and the part of it under the point,
 * or a wire, or the empty pane. The parts are the ones a gesture can start
 * from: a resize corner, a connect handle, a verb landing zone, the tasks
 * card's enqueue, a region's title bar or frame strip, an image, a body.
 *
 * The engine hands in its index and its live rectangles; the feed's facts say
 * what kind each card is and what is selected. Nothing here touches the DOM,
 * a React store, or the camera, so a test drives it with plain data.
 *
 * Distances are board units. The sizes the DOM gives its chrome are CSS
 * pixels inside a card, and a card lives in board space, so the same numbers
 * hold at every zoom, exactly as the DOM hit areas do today.
 */

import { isImageFile, renderedNodeSize } from "@shared/node-geometry";
import type { Node as ModelNode } from "@shared/model/kinds";
import type {
  CardFact,
  CanvasTier,
  Hit,
  NodeId,
  Part,
  Point,
  Rect,
  SelectionFact,
  SpatialIndex,
  WireFact,
  WireId,
  WireMode,
} from "../contract";

/** `.junto-handle` is 9 px with a 9 px bleed; the dot pair sits ~5 px apart. */
const HANDLE_HIT = 12;
const HANDLE_SOURCE_OUT = 2;
const HANDLE_TARGET_OUT = -3;
/** `VERB_ZONE_BLEED` in NodeShell.tsx. */
const VERB_ZONE_BLEED = 16;
/** `NodeResizer`'s `.junto-resize-handle` is 10 px square. */
const RESIZE_HIT = 8;
/** A wire is hit within 20 units in loupe or cone mode (section 13). */
const WIRE_HIT = 20;
/** The tallest part a card owns outside its own rectangle: a verb zone. */
const PART_BLEED = VERB_ZONE_BLEED + HANDLE_HIT;
/** Region chrome, in the same units its CSS uses. */
const REGION_TITLEBAR = 24;
const REGION_FRAME = 12;
/** The tasks card's enqueue: a 20 px pill with a 24 px hit area, end of the name row. */
const ENQUEUE_SIZE = 24;

/** What picking needs to know, all of it supplied by the engine. */
export type PickWorld = {
  readonly index: SpatialIndex;
  readonly card: (id: NodeId) => CardFact | undefined;
  readonly wire: (id: WireId) => WireFact | undefined;
  readonly selection: SelectionFact;
  /** The camera's zoom, for the few distances that mean screen space. */
  readonly scale: number;
  readonly tier: CanvasTier;
  readonly wireMode: WireMode;
  /**
   * A live rectangle, when the card is being dragged or resized and its
   * record has moved away from the feed's row. The engine's records are the
   * truth during a gesture.
   */
  readonly rectOf?: (id: NodeId) => Rect | undefined;
  /**
   * A connect drag in progress: the card it started from and the verbs its
   * kind pair offers. Landing zones exist only while this is set and the pair
   * offers two.
   */
  readonly connecting?: {
    readonly from: NodeId;
    readonly fromKind: string;
    readonly verbs: ReadonlyArray<string>;
  };
  /**
   * The members of the seat cluster whose badge is under a board point, if
   * any. A badge paints above every card, so it is the first thing a press
   * lands on; it has no card id of its own.
   */
  readonly clusterAt?: (at: Point) => ReadonlyArray<NodeId> | undefined;
};

const rectOf = (world: PickWorld, fact: CardFact): Rect => {
  const live = world.rectOf?.(fact.id);
  if (live !== undefined) return live;
  const node = fact.row;
  return { x: node.x, y: node.y, ...renderedNodeSize(node.kind, node) };
};

const contains = (rect: Rect, at: Point): boolean =>
  at.x >= rect.x && at.x <= rect.x + rect.width && at.y >= rect.y && at.y <= rect.y + rect.height;

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

const hitAt = (fact: CardFact, part: Part, at: Point): Hit => ({
  nodeId: fact.id,
  part,
  at,
});

const sidesOf = (rect: Rect): ReadonlyArray<{ readonly side: "top" | "right" | "bottom" | "left"; readonly at: Point; readonly out: Point }> => [
  { side: "top", at: { x: rect.x + rect.width / 2, y: rect.y }, out: { x: 0, y: -1 } },
  { side: "right", at: { x: rect.x + rect.width, y: rect.y + rect.height / 2 }, out: { x: 1, y: 0 } },
  { side: "bottom", at: { x: rect.x + rect.width / 2, y: rect.y + rect.height }, out: { x: 0, y: 1 } },
  { side: "left", at: { x: rect.x, y: rect.y + rect.height / 2 }, out: { x: -1, y: 0 } },
];

/** A card that takes no wire today: a region, a bare label, git and Files (model-edits `wireable`). */
const takesHandles = (node: ModelNode): boolean =>
  node.kind !== "region" && node.kind !== "label" && node.kind !== "git" && node.kind !== "files";

/** The kinds a seat draws at its fixed ring footprint; the rest keep their stored rectangle. */
const isFixedSeat = (node: ModelNode): boolean => {
  const holds = renderedNodeSize(node.kind, node);
  return holds.width !== node.width || holds.height !== node.height;
};

/** NodeShell: regions always, cards unless they are a fixed seat, an image or a page. */
const resizable = (node: ModelNode): boolean => {
  if (node.kind === "region") return true;
  if (node.kind === "file" && isImageFile(node.path)) return false;
  if (node.kind === "link" || node.kind === "page") return false;
  return !isFixedSeat(node);
};

const handlePart = (rect: Rect, at: Point): Part | null => {
  let best: { readonly distance: number; readonly part: Part } | null = null;
  for (const side of sidesOf(rect)) {
    // Source sits a little outside the border, target a little inside, as
    // NodeShell's stylesheet offsets them; the nearer one is the one hit.
    const candidates: ReadonlyArray<{ readonly role: "source" | "target"; readonly out: number }> = [
      { role: "source", out: HANDLE_SOURCE_OUT },
      { role: "target", out: HANDLE_TARGET_OUT },
    ];
    for (const candidate of candidates) {
      const centre = {
        x: side.at.x + side.out.x * candidate.out,
        y: side.at.y + side.out.y * candidate.out,
      };
      const away = distance(centre, at);
      if (away > HANDLE_HIT) continue;
      if (best !== null && best.distance <= away) continue;
      best = { distance: away, part: { kind: "handle", side: side.side, role: candidate.role, id: `${candidate.role === "source" ? "s" : "t"}-${side.side}` } };
    }
  }
  return best?.part ?? null;
};

const verbZonePart = (world: PickWorld, rect: Rect, at: Point): Part | null => {
  const connecting = world.connecting;
  if (connecting === undefined || connecting.verbs.length !== 2) return null;
  const top = rect.y - VERB_ZONE_BLEED;
  const bottom = rect.y + rect.height + VERB_ZONE_BLEED;
  if (at.y < top || at.y > bottom) return null;
  const middle = rect.x + rect.width / 2;
  const leftEdge = rect.x - VERB_ZONE_BLEED;
  const rightEdge = rect.x + rect.width + VERB_ZONE_BLEED;
  if (at.x < leftEdge || at.x > rightEdge) return null;
  const verb = at.x <= middle ? connecting.verbs[0] : connecting.verbs[1];
  return verb === undefined ? null : { kind: "verbZone", verb };
};

const resizePart = (rect: Rect, at: Point): Part | null => {
  const corners: ReadonlyArray<{ readonly corner: "nw" | "ne" | "se" | "sw"; readonly x: number; readonly y: number }> = [
    { corner: "nw", x: rect.x, y: rect.y },
    { corner: "ne", x: rect.x + rect.width, y: rect.y },
    { corner: "se", x: rect.x + rect.width, y: rect.y + rect.height },
    { corner: "sw", x: rect.x, y: rect.y + rect.height },
  ];
  let best: { readonly away: number; readonly part: Part } | null = null;
  for (const corner of corners) {
    const away = distance({ x: corner.x, y: corner.y }, at);
    if (away > RESIZE_HIT) continue;
    if (best !== null && best.away <= away) continue;
    best = { away, part: { kind: "resize", corner: corner.corner } };
  }
  if (best !== null) return best.part;
  // The four edge lines (rf-system:3115-3116): one axis each, a narrow band
  // along that side. A corner already answered; these only reach the middle.
  const withinX = at.x >= rect.x && at.x <= rect.x + rect.width;
  const withinY = at.y >= rect.y && at.y <= rect.y + rect.height;
  const edges: ReadonlyArray<{ readonly edge: "n" | "e" | "s" | "w"; readonly hit: boolean }> = [
    { edge: "n", hit: withinX && Math.abs(at.y - rect.y) <= RESIZE_HIT },
    { edge: "e", hit: withinY && Math.abs(at.x - (rect.x + rect.width)) <= RESIZE_HIT },
    { edge: "s", hit: withinX && Math.abs(at.y - (rect.y + rect.height)) <= RESIZE_HIT },
    { edge: "w", hit: withinY && Math.abs(at.x - rect.x) <= RESIZE_HIT },
  ];
  const edge = edges.find((candidate) => candidate.hit);
  return edge === undefined ? null : { kind: "resizeEdge", edge: edge.edge };
};

/** The region's own chrome: a title bar across the top, then the frame strips. */
const regionPart = (rect: Rect, at: Point, selected: boolean): Part | null => {
  if (at.y >= rect.y && at.y <= rect.y + REGION_TITLEBAR) {
    if (at.x >= rect.x && at.x <= rect.x + rect.width) return { kind: "regionTitle" };
  }
  if (selected) return null; // NodeResizer owns the edges; the strips step aside.
  const inBody = at.y >= rect.y + REGION_TITLEBAR && at.y <= rect.y + rect.height;
  if (!inBody) return null;
  if (at.x >= rect.x && at.x <= rect.x + REGION_FRAME) return { kind: "regionFrame" };
  if (at.x >= rect.x + rect.width - REGION_FRAME && at.x <= rect.x + rect.width) return { kind: "regionFrame" };
  if (at.y >= rect.y + rect.height - REGION_FRAME) return { kind: "regionFrame" };
  return null;
};

/** The tasks card's enqueue instrument, at the end of its name row. */
const enqueuePart = (node: ModelNode, rect: Rect, at: Point): Part | null => {
  if (node.kind !== "task") return null;
  const x = rect.x + rect.width - ENQUEUE_SIZE;
  const y = rect.y;
  return at.x >= x && at.x <= rect.x + rect.width && at.y >= y && at.y <= y + ENQUEUE_SIZE
    ? { kind: "taskEnqueue" }
    : null;
};

/**
 * The topmost card part under a board point, without wires or the pane. Used
 * by `pickAt` and, while a connection is dragged, to know what it would land
 * on.
 */
export const pickCard = (world: PickWorld, at: Point): Hit | null => {
  // Handles are hidden from far and overview (canvas-lod.css:142-144), so
  // they are not there to be pressed either; every other part still is.
  const drawnHandles = world.tier === "near" || world.tier === "mid";
  const near = world.index.cardsNear(at, PART_BLEED);
  for (let index = near.length - 1; index >= 0; index -= 1) {
    const id = near[index];
    if (id === undefined) continue;
    const fact = world.card(id);
    if (fact === undefined) continue;
    const node = fact.row;
    const rect = rectOf(world, fact);
    const selected = world.selection.nodeIds.includes(id);

    if (node.kind === "region") {
      // Region resize corners come before its chrome, as the resizer paints
      // over the strips at the corners.
      if (selected) {
        const resize = resizePart(rect, at);
        if (resize !== null) return hitAt(fact, resize, at);
      }
      const chrome = regionPart(rect, at, selected);
      if (chrome !== null) return hitAt(fact, chrome, at);
      // The interior is geography, not a target: a press there is the pane's.
      continue;
    }

    // A selected card's resize grip straddles the border, and a point read
    // at a corner can land a float outside it. It is tested before the
    // contains guard, as the region branch does, or that grip is the pane.
    if (selected) {
      const resize = resizePart(rect, at);
      if (resize !== null && resizable(node)) return hitAt(fact, resize, at);
    }

    if (!contains(rect, at)) {
      // Handles and verb zones bleed past the rectangle; nothing else does.
      if (!drawnHandles) continue;
      const part = verbZonePart(world, rect, at) ?? (takesHandles(node) ? handlePart(rect, at) : null);
      if (part !== null) return hitAt(fact, part, at);
      continue;
    }
    if (drawnHandles && takesHandles(node) && world.connecting?.from !== id) {
      const part = verbZonePart(world, rect, at) ?? handlePart(rect, at);
      if (part !== null) return hitAt(fact, part, at);
    }
    const enqueue = enqueuePart(node, rect, at);
    if (enqueue !== null) return hitAt(fact, enqueue, at);
    if (node.kind === "file" && isImageFile(node.path)) return hitAt(fact, { kind: "image" }, at);
    return hitAt(fact, { kind: "body" }, at);
  }
  return null;
};

/**
 * The topmost thing under a board point: a card part, then a wire (only in
 * loupe or cone mode, where the wires are loud enough to aim at), then the
 * pane.
 */
export const pickAt = (world: PickWorld, at: Point): Hit => {
  const cluster = world.clusterAt?.(at);
  if (cluster !== undefined) return { part: { kind: "cluster", memberIds: cluster }, at };
  const card = pickCard(world, at);
  if (card !== null) return card;
  if (world.wireMode === "loupe" || world.wireMode === "cone") {
    const wires = world.index.wiresAt(at, WIRE_HIT);
    for (let index = wires.length - 1; index >= 0; index -= 1) {
      const id = wires[index];
      if (id === undefined) continue;
      const fact = world.wire(id);
      if (fact !== undefined) return { wireId: id, part: { kind: "wire" }, at };
    }
  }
  return { part: { kind: "pane" }, at };
};
