/**
 * The scene (docs/canvas-gpu-architecture.md, section 6).
 *
 * Facts in; fixed-size quad records at stable slots out. Each card owns one
 * slot per quad key (contract `Quad.key`), so a repaint that changes only a
 * style rewrites that key's bytes and nothing else. The paint order is a
 * separate list of slot indices, contiguous by band, rebuilt when the visible
 * set changes; records never move when the order changes.
 *
 * Culling is a grid over whole cards: a frame asks for the cards whose
 * rectangles meet the camera's view, then walks only those. The same grid
 * answers picking, in paint order.
 *
 * Nothing here touches the DOM, a React store or the camera; the engine hands
 * it the view rectangle, the tier and the theme.
 */

import { renderedNodeSize } from "@shared/node-geometry";
import { themeGpu, type GpuTheme, type ThemeMode } from "@shared/theme";
import type {
  CanvasTier,
  CardFact,
  CardPaint,
  CardView,
  Hit,
  NodeId,
  PaintEnv,
  Point,
  Quad,
  QuadMotion,
  ReachMark,
  Rect,
  SceneOp,
  SeatLive,
  SelectionFact,
  SpatialIndex,
  TextRun,
  WireId,
  WireMode,
  WireFact,
} from "../contract";
import { TIER_BIT } from "../contract";
import {
  createQuadBuffer,
  MOTION,
  MOTION_FLAG,
  packColor,
  packDash,
  QUAD_FLOATS,
  QUAD_KIND,
  SCALE_RULE,
  SHAPE,
  writeQuad,
  type PackedQuad,
  type QuadBuffer,
} from "./quad";
import { resolveStyle } from "./color";
import { CARD_CELL, RectGrid } from "./grid";

export type CardPainter = (
  fact: CardFact,
  live: SeatLive | undefined,
  view: CardView,
  env: PaintEnv,
) => CardPaint;

/** What a prepared frame tells the renderer. */
export type Prepared = {
  /** The visible order or the band split changed and must be uploaded. */
  readonly orderChanged: boolean;
  /** Visible quads this frame. */
  readonly visible: number;
};

export type SceneDirty = {
  readonly all: boolean;
  readonly slots: ReadonlyArray<number>;
};

type QuadRef = {
  readonly key: string;
  readonly slot: number;
  readonly z: number;
  readonly band: 0 | 1 | 2;
  readonly motion: QuadMotion | undefined;
  readonly tiers: number;
};

type CardSlot = {
  readonly slot: number;
  readonly id: NodeId;
  fact: CardFact;
  live: SeatLive | undefined;
  view: CardView;
  /** The drawn rectangle in board units (a drag moves this, not the records). */
  rect: Rect;
  /** Stable slot per quad key. */
  quads: Map<string, number>;
  /** The same quads in paint order, rebuilt with every repaint. */
  ordered: QuadRef[];
  dim: CardPaint["dim"];
  lift: number;
};

const BAND_OF: Readonly<Record<Quad["band"], 0 | 1 | 2>> = { regions: 0, cards: 1, lifted: 2 };
const BAND_COUNT = 3;

const compareQuad = (a: Quad, b: Quad): number => {
  const band = BAND_OF[a.band] - BAND_OF[b.band];
  if (band !== 0) return band;
  if (a.z !== b.z) return a.z - b.z;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
};

const sameRect = (a: Rect, b: Rect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const rectOfFact = (fact: CardFact): Rect => {
  const size = renderedNodeSize(fact.row.kind, fact.row);
  return { x: fact.row.x, y: fact.row.y, width: size.width, height: size.height };
};

const contains = (rect: Rect, at: Point): boolean =>
  at.x >= rect.x && at.x <= rect.x + rect.width && at.y >= rect.y && at.y <= rect.y + rect.height;

const insetBy = (rect: Rect, by: number): Rect => ({
  x: rect.x - by,
  y: rect.y - by,
  width: rect.width + by * 2,
  height: rect.height + by * 2,
});

/** Motion encoded as the shader's switch reads it. */
const packMotion = (
  motion: QuadMotion | undefined,
): Pick<PackedQuad, "motion" | "motionPeriod" | "motionSince" | "motionFlags"> => {
  if (motion === undefined) return { motion: MOTION.none, motionPeriod: 0, motionSince: 0, motionFlags: 0 };
  switch (motion.kind) {
    case "turn":
      return {
        motion: MOTION.turn,
        motionPeriod: motion.periodMs,
        motionSince: 0,
        motionFlags: (motion.ccw === true ? MOTION_FLAG.ccw : 0) | (motion.fade === true ? MOTION_FLAG.fade : 0),
      };
    case "land":
    case "landed":
      return {
        motion: motion.kind === "land" ? MOTION.land : MOTION.landed,
        motionPeriod: 720,
        motionSince: motion.since,
        motionFlags: 0,
      };
    case "rise":
      return { motion: MOTION.rise, motionPeriod: 200, motionSince: motion.since, motionFlags: 0 };
    default:
      return { motion: MOTION[motion.kind], motionPeriod: motion.periodMs, motionSince: 0, motionFlags: 0 };
  }
};

const packScale = (
  scale: Quad["scale"],
): Pick<PackedQuad, "scaleRule" | "scaleCap" | "anchorX" | "anchorY"> => {
  switch (scale.kind) {
    case "seat":
      return { scaleRule: SCALE_RULE.seat, scaleCap: scale.cap, anchorX: scale.anchor.x, anchorY: scale.anchor.y };
    case "node":
      return { scaleRule: SCALE_RULE.node, scaleCap: 1, anchorX: scale.anchor.x, anchorY: scale.anchor.y };
    default:
      return { scaleRule: SCALE_RULE.board, scaleCap: 1, anchorX: 0, anchorY: 0 };
  }
};

const SHAPE_OF: Readonly<Record<NonNullable<Quad["shape"]>, number>> = {
  rect: SHAPE.rect,
  disc: SHAPE.disc,
  triangle: SHAPE.triangle,
};
const KIND_OF: Readonly<Record<Quad["kind"], number>> = {
  shape: QUAD_KIND.shape,
  shadow: QUAD_KIND.shadow,
  sprite: QUAD_KIND.sprite,
  text: QUAD_KIND.text,
};

export type Scene = ReturnType<typeof createScene>;

const approximateMeasure = (run: TextRun): number => run.text.length * run.size * 0.6;

export const createScene = (options: {
  readonly painter: CardPainter;
  readonly mode?: ThemeMode;
  readonly measure?: (run: TextRun) => number;
}) => {
  let mode: ThemeMode = options.mode ?? "dark";
  let theme: GpuTheme = themeGpu(mode);
  const painter = options.painter;
  const env: PaintEnv = { measure: options.measure ?? approximateMeasure };

  let quads: QuadBuffer = createQuadBuffer(1024);
  let quadCapacity = 1024;
  let quadCount = 0;
  let owners = new Float32Array(256 * 8);
  let ownerCapacity = 256;
  let order = new Uint32Array(1024);
  let orderCount = 0;
  let bandEnds: [number, number, number] = [0, 0, 0];
  let orderDirty = true;

  const slots: Array<CardSlot | undefined> = [];
  const freeSlots: number[] = [];
  const byId = new Map<NodeId, CardSlot>();
  const quadSlotsOf = new Map<number, Set<number>>();
  const freeQuadSlots: number[] = [];

  const dirtyQuads = new Set<number>();
  const dirtyOwners = new Set<number>();
  let allQuadsDirty = false;

  const grid = new RectGrid(CARD_CELL);
  let selection: SelectionFact = { nodeIds: [] };
  let reach: ReadonlyMap<NodeId, ReachMark> = new Map();
  let editing: NodeId | null = null;
  let hovered: NodeId | null = null;
  let dragging = new Set<NodeId>();
  let wireMode: WireMode = "rest";
  let wires = new Map<WireId, WireFact>();
  let motionVisible = false;
  let wallNow = 0;

  const markOrder = (): void => {
    orderDirty = true;
  };

  const ensureQuadCapacity = (needed: number): void => {
    if (needed <= quadCapacity) return;
    let capacity = quadCapacity;
    while (capacity < needed) capacity *= 2;
    const next = createQuadBuffer(capacity);
    next.f32.set(quads.f32);
    quads = next;
    quadCapacity = capacity;
    allQuadsDirty = true;
  };

  const ensureOwnerCapacity = (needed: number): void => {
    if (needed <= ownerCapacity) return;
    let capacity = ownerCapacity;
    while (capacity < needed) capacity *= 2;
    const next = new Float32Array(capacity * 8);
    next.set(owners);
    owners = next;
    ownerCapacity = capacity;
    dirtyOwners.add(-1);
  };

  const ensureOrderCapacity = (needed: number): void => {
    if (needed <= order.length) return;
    let capacity = order.length;
    while (capacity < needed) capacity *= 2;
    order = new Uint32Array(capacity);
  };

  const allocateQuad = (): number => {
    const reused = freeQuadSlots.pop();
    if (reused !== undefined) return reused;
    ensureQuadCapacity(quadCount + 1);
    const slot = quadCount;
    quadCount += 1;
    return slot;
  };

  const freeQuad = (slot: number): void => {
    freeQuadSlots.push(slot);
    dirtyQuads.delete(slot);
  };

  const allocateCard = (): number => {
    const reused = freeSlots.pop();
    if (reused !== undefined) return reused;
    const slot = slots.length;
    slots.push(undefined);
    ensureOwnerCapacity(slots.length);
    return slot;
  };

  const writeOwner = (card: CardSlot): void => {
    const at = card.slot * 8;
    const next = [card.rect.x, card.rect.y, card.lift, card.dim.opacity, card.dim.saturate, 0, 0, 0];
    let changed = owners[at + 5] !== 0;
    for (let index = 0; index < next.length; index += 1) {
      if (owners[at + index] !== next[index]) {
        owners[at + index] = next[index]!;
        changed = true;
      }
    }
    owners[at + 5] = 0;
    if (changed) dirtyOwners.add(card.slot);
  };

  const packQuad = (quad: Quad): PackedQuad => {
    const style = resolveStyle(quad.style, theme);
    const ink = quad.kind === "text" ? style.ink : style.from;
    const radius = typeof quad.radii === "number"
      ? ([quad.radii, quad.radii, quad.radii, quad.radii] as const)
      : quad.radii ?? ([0, 0, 0, 0] as const);
    const dash = quad.style?.stroke?.dash;
    return {
      rect: quad.rect,
      radii: radius,
      fill: packColor(ink),
      fillTo: packColor(style.to),
      stroke: packColor(style.stroke),
      strokeWidth: style.strokeWidth,
      opacity: style.opacity,
      shape: quad.shape === undefined ? SHAPE.rect : SHAPE_OF[quad.shape],
      kind: KIND_OF[quad.kind],
      tiers: quad.tiers,
      ...packScale(quad.scale),
      ...packMotion(quad.motion),
      source: 0xffffffff,
      gradientAngle: style.angle,
      style: 0xffffffff,
      previousStyle: 0xffffffff,
      changeAt: wallNow,
      dash: dash === undefined ? 0 : packDash(dash[0], dash[1]),
    };
  };

  const paint = (card: CardSlot): void => {
    const result = painter(card.fact, card.live, card.view, env);
    const sorted = [...result.quads].sort(compareQuad);
    const keys = new Set(sorted.map((quad) => quad.key));
    const held = quadSlotsOf.get(card.slot) ?? new Set<number>();
    for (const key of card.quads.keys()) {
      if (keys.has(key)) continue;
      const slot = card.quads.get(key)!;
      card.quads.delete(key);
      held.delete(slot);
      freeQuad(slot);
    }
    for (const quad of sorted) {
      let slot = card.quads.get(quad.key);
      if (slot === undefined) {
        slot = allocateQuad();
        card.quads.set(quad.key, slot);
        held.add(slot);
      }
      writeQuad(quads, slot, packQuad(quad));
      dirtyQuads.add(slot);
    }
    quadSlotsOf.set(card.slot, held);
    card.ordered = sorted.map((quad) => ({
      key: quad.key,
      slot: card.quads.get(quad.key)!,
      z: quad.z,
      band: BAND_OF[quad.band],
      motion: quad.motion,
      tiers: quad.tiers,
    }));
    card.dim = result.dim;
    card.lift = result.lift;
    writeOwner(card);
    grid.set(card.slot, insetBy(card.rect, 28));
    markOrder();
  };

  const viewOf = (fact: CardFact): CardView => {
    const focus = selection.focusMode;
    const focusRole = focus === undefined
      ? undefined
      : focus.rootId === fact.id
        ? "root"
        : focus.memberIds.includes(fact.id)
          ? "member"
          : focus.leadIds.includes(fact.id)
            ? "lead"
            : "outsider";
    const reachMark = reach.get(fact.id);
    return {
      selected: selection.nodeIds.includes(fact.id),
      hovered: hovered === fact.id,
      keyboardFocus: selection.focusedNodeId === fact.id,
      editing: editing === fact.id,
      dragging: dragging.has(fact.id),
      ...(reachMark === undefined ? {} : { reach: reachMark }),
      ...(focusRole === undefined ? {} : { focus: { kind: focus!.kind, role: focusRole } }),
      mode,
    };
  };

  const repaint = (card: CardSlot): void => {
    card.view = viewOf(card.fact);
    paint(card);
  };

  const repaintIds = (ids: ReadonlyArray<NodeId>): void => {
    for (const id of ids) {
      const card = byId.get(id);
      if (card !== undefined) repaint(card);
    }
  };

  const putCard = (fact: CardFact): void => {
    const existing = byId.get(fact.id);
    if (existing !== undefined) {
      existing.fact = fact;
      const rect = rectOfFact(fact);
      if (!sameRect(existing.rect, rect)) existing.rect = rect;
      repaint(existing);
      return;
    }
    const slot = allocateCard();
    const card: CardSlot = {
      slot,
      id: fact.id,
      fact,
      live: undefined,
      view: viewOf(fact),
      rect: rectOfFact(fact),
      quads: new Map(),
      ordered: [],
      dim: { opacity: 1, saturate: 1 },
      lift: 0,
    };
    slots[slot] = card;
    byId.set(fact.id, card);
    paint(card);
  };

  const removeCard = (id: NodeId): void => {
    const card = byId.get(id);
    if (card === undefined) return;
    byId.delete(id);
    slots[card.slot] = undefined;
    freeSlots.push(card.slot);
    grid.remove(card.slot);
    for (const slot of quadSlotsOf.get(card.slot) ?? []) freeQuad(slot);
    quadSlotsOf.delete(card.slot);
    dirtyOwners.delete(card.slot);
    markOrder();
  };

  const clearAll = (): void => {
    slots.length = 0;
    freeSlots.length = 0;
    byId.clear();
    quadSlotsOf.clear();
    freeQuadSlots.length = 0;
    quadCount = 0;
    dirtyQuads.clear();
    dirtyOwners.clear();
    allQuadsDirty = true;
    orderCount = 0;
    bandEnds = [0, 0, 0];
    grid.clear();
    wires = new Map();
    markOrder();
  };

  const apply = (op: SceneOp): void => {
    switch (op.kind) {
      case "load":
        clearAll();
        for (const card of op.cards) putCard(card);
        for (const wire of op.wires) wires.set(wire.id, wire);
        return;
      case "card":
        putCard(op.fact);
        return;
      case "removeCard":
        removeCard(op.id);
        return;
      case "seat": {
        const card = byId.get(op.id);
        if (card === undefined) return;
        card.live = op.live;
        repaint(card);
        return;
      }
      case "selection": {
        const before = selection;
        selection = op.fact;
        if (before.focusMode !== undefined || op.fact.focusMode !== undefined) {
          for (const card of byId.values()) repaint(card);
          return;
        }
        const changed = new Set<NodeId>();
        for (const id of before.nodeIds) changed.add(id);
        for (const id of op.fact.nodeIds) changed.add(id);
        if (before.focusedNodeId !== undefined) changed.add(before.focusedNodeId);
        if (op.fact.focusedNodeId !== undefined) changed.add(op.fact.focusedNodeId);
        repaintIds([...changed]);
        return;
      }
      case "reachMarks": {
        const before = reach;
        const next = new Map<NodeId, ReachMark>();
        for (const mark of op.marks ?? []) next.set(mark.id, mark);
        reach = next;
        const changed = new Set<NodeId>();
        for (const id of before.keys()) changed.add(id);
        for (const id of next.keys()) changed.add(id);
        repaintIds([...changed]);
        return;
      }
      case "theme": {
        mode = op.mode;
        theme = themeGpu(mode);
        for (const card of byId.values()) repaint(card);
        return;
      }
      case "wireMode":
        wireMode = op.mode;
        return;
      case "wire":
        wires.set(op.fact.id, op.fact);
        return;
      case "removeWire":
        wires.delete(op.id);
        return;
      case "editing": {
        const before = editing;
        editing = op.id;
        if (before !== null) repaintIds([before]);
        if (op.id !== null) repaintIds([op.id]);
        return;
      }
      default:
        // routes, preview, pulse and reach belong to the wire layer (D).
        return;
    }
  };

  const setHover = (id: NodeId | null): boolean => {
    if (hovered === id) return false;
    const before = hovered;
    hovered = id;
    if (before !== null) repaintIds([before]);
    if (id !== null) repaintIds([id]);
    return true;
  };

  const setDragging = (ids: ReadonlyArray<NodeId> | null): void => {
    const next = new Set(ids ?? []);
    const changed = new Set<NodeId>([...dragging, ...next]);
    dragging = next;
    repaintIds([...changed]);
  };

  /** Move a card's drawn rectangle; its records stay where they are (owner offset). */
  const moveCard = (id: NodeId, at: Point): void => {
    const card = byId.get(id);
    if (card === undefined) return;
    if (card.rect.x === at.x && card.rect.y === at.y) return;
    card.rect = { ...card.rect, x: at.x, y: at.y };
    writeOwner(card);
    grid.set(card.slot, insetBy(card.rect, 28));
    markOrder();
  };

  /** Put a card back on its feed row (a gesture let go before the writer's fact arrives). */
  const restoreCard = (id: NodeId): void => {
    const card = byId.get(id);
    if (card === undefined) return;
    moveCard(id, rectOfFact(card.fact));
  };

  /** A live resize keeps the card's records and moves its owner rectangle. */
  const resizeCard = (id: NodeId, rect: Rect): void => {
    const card = byId.get(id);
    if (card === undefined) return;
    card.rect = rect;
    writeOwner(card);
    grid.set(card.slot, insetBy(card.rect, 28));
    markOrder();
  };

  /** Cards whose rectangles meet a board rectangle, in paint order (the pointer machine's query). */
  const query = (rect: Rect): NodeId[] => {
    const found: number[] = [];
    grid.query(rect, found);
    return orderCards(found).map((card) => card.id);
  };

  const rectOf = (id: NodeId): Rect | undefined => byId.get(id)?.rect;
  const cardOf = (id: NodeId): CardFact | undefined => byId.get(id)?.fact;

  const visibleSlots: number[] = [];
  const previousOrder: number[] = [];

  const orderCards = (found: ReadonlyArray<number>): CardSlot[] => {
    const cards: CardSlot[] = [];
    for (const slot of found) {
      const card = slots[slot];
      if (card !== undefined) cards.push(card);
    }
    cards.sort((a, b) => {
      if (a.fact.derived.z !== b.fact.derived.z) return a.fact.derived.z - b.fact.derived.z;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return cards;
  };

  const prepare = (view: Rect, tier: CanvasTier): Prepared => {
    visibleSlots.length = 0;
    grid.query(insetBy(view, 140), visibleSlots);
    const cards = orderCards(visibleSlots);
    let needed = 0;
    for (const card of cards) needed += card.ordered.length;
    ensureOrderCapacity(needed);

    const mask = TIER_BIT[tier];
    const counts = [0, 0, 0];
    let moving = false;
    for (let band = 0; band < BAND_COUNT; band += 1) {
      for (const card of cards) {
        for (const quad of card.ordered) {
          if (quad.band !== band) continue;
          order[counts[0]! + counts[1]! + counts[2]!] = quad.slot;
          counts[band] = counts[band]! + 1;
          if (quad.motion !== undefined && (quad.tiers & mask) !== 0) moving = true;
        }
      }
    }
    bandEnds = [counts[0]!, counts[0]! + counts[1]!, counts[0]! + counts[1]! + counts[2]!];
    orderCount = bandEnds[2];
    motionVisible = moving;

    let changed = orderCount !== previousOrder.length;
    if (!changed) {
      for (let index = 0; index < orderCount; index += 1) {
        if (order[index] !== previousOrder[index]) {
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      previousOrder.length = orderCount;
      for (let index = 0; index < orderCount; index += 1) previousOrder[index] = order[index]!;
    }
    orderDirty = false;
    return { orderChanged: changed, visible: orderCount };
  };

  const hasMotion = (): boolean => motionVisible;

  const index: SpatialIndex = {
    cardsAt: (at) => {
      const found: number[] = [];
      grid.query({ x: at.x, y: at.y, width: 0, height: 0 }, found);
      return orderCards(found)
        .filter((card) => contains(card.rect, at))
        .map((card) => card.id);
    },
    cardsNear: (at, slop) => {
      const found: number[] = [];
      grid.query({ x: at.x - slop, y: at.y - slop, width: slop * 2, height: slop * 2 }, found);
      return orderCards(found).map((card) => card.id);
    },
    wiresAt: () => [],
  };

  const takeQuadDirty = (): SceneDirty => {
    const all = allQuadsDirty;
    allQuadsDirty = false;
    const sorted = [...dirtyQuads].sort((a, b) => a - b);
    dirtyQuads.clear();
    return { all, slots: sorted };
  };

  const takeOwnerDirty = (): SceneDirty => {
    const all = dirtyOwners.delete(-1);
    const sorted = [...dirtyOwners].sort((a, b) => a - b);
    dirtyOwners.clear();
    return { all, slots: sorted };
  };

  return {
    apply,
    setHover,
    setDragging,
    moveCard,
    restoreCard,
    resizeCard,
    query,
    rectOf,
    cardOf,
    prepare,
    hasMotion,
    index,
    takeQuadDirty,
    takeOwnerDirty,
    setWallClock: (now: number): void => {
      wallNow = now;
    },
    selection: (): SelectionFact => selection,
    wire: (id: WireId): WireFact | undefined => wires.get(id),
    ids: (): NodeId[] => [...byId.keys()],
    get mode(): ThemeMode {
      return mode;
    },
    get theme(): GpuTheme {
      return theme;
    },
    get quadBuffer(): QuadBuffer {
      return quads;
    },
    get quadCapacity(): number {
      return quadCapacity;
    },
    get quadCount(): number {
      return quadCount;
    },
    get ownerBuffer(): Float32Array {
      return owners;
    },
    get ownerCapacity(): number {
      return ownerCapacity;
    },
    get orderBuffer(): Uint32Array {
      return order;
    },
    get orderCount(): number {
      return orderCount;
    },
    get bandEnds(): readonly [number, number, number] {
      return bandEnds;
    },
    get wireMode(): WireMode {
      return wireMode;
    },
  };
};
