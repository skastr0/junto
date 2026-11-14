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
import { DURATION, themeGpu, type GpuTheme, type ThemeMode } from "@shared/theme";
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
  QUAD_FLOATS,
  QUAD_KIND,
  SCALE_RULE,
  NO_ATLAS_CELL,
  SHAPE,
  writeQuad,
  type PackedQuad,
  type QuadBuffer,
} from "./quad";
import { createStyleTable, type ShadowSpec } from "./styles";
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
  /** The atlas's cell table revision, so the renderer re-uploads the UVs. */
  readonly atlasRevision: number;
};

/**
 * The scale a run is rasterized at, quantized to half powers of two. The
 * atlas keys a text cell by this scale, so a zoom gesture re-rasterizes at a
 * few steps instead of on every wheel tick, and a record names a cell that
 * exists at its bucket. `scale` is device pixels per board unit.
 */
export const atlasScale = (scale: number): number => {
  const clamped = Math.max(0.0625, Math.min(16, scale));
  return 2 ** (Math.round(Math.log2(clamped) * 2) / 2);
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
  /** The quad as painted, so a scale bucket or atlas revision re-resolves its cell. */
  readonly painted: Quad;
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
  /** The size a live resize is drawing at, until the writer's fact lands. */
  size?: { readonly width: number; readonly height: number };
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

/** Two motions with the same tempo and the same one-shot start. */
const sameMotion = (a: QuadMotion | undefined, b: QuadMotion | undefined): boolean => {
  if (a === b) return true;
  if (a === undefined || b === undefined || a.kind !== b.kind) return false;
  const period = (motion: QuadMotion): number => ("periodMs" in motion ? motion.periodMs : motion.since);
  const flags = (motion: QuadMotion): string =>
    "ccw" in motion ? `${motion.ccw === true ? 1 : 0}${motion.fade === true ? 1 : 0}` : "";
  return period(a) === period(b) && flags(a) === flags(b);
};

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

/**
 * Motion encoded as the shader's switch reads it.
 *
 * The shader's clock is the page-relative one (`clock()`, a few thousand
 * milliseconds), because a float32 uniform cannot hold `Date.now()` at
 * sub-frame precision: at 1.7e12 the nearest representable step is about two
 * minutes, so every phase and every 180 ms style fade stood still. `since` is
 * therefore a page-relative instant, and a periodic motion's phase is anchored
 * to the wall clock the DOM ring reads: `now - (wall % period)` advances at
 * the same rate and lands on the same phase as `fract(wall / period)`.
 */
const packMotion = (
  motion: QuadMotion | undefined,
  now: number,
  wall: number,
): Pick<PackedQuad, "motion" | "motionPeriod" | "motionSince" | "motionFlags"> => {
  if (motion === undefined) return { motion: MOTION.none, motionPeriod: 0, motionSince: 0, motionFlags: 0 };
  switch (motion.kind) {
    case "turn":
      return {
        motion: MOTION.turn,
        motionPeriod: motion.periodMs,
        motionSince: now - (wall % motion.periodMs),
        motionFlags: (motion.ccw === true ? MOTION_FLAG.ccw : 0) | (motion.fade === true ? MOTION_FLAG.fade : 0),
      };
    case "land":
    case "landed":
      return {
        motion: motion.kind === "land" ? MOTION.land : MOTION.landed,
        motionPeriod: 720,
        motionSince: now - (wall - motion.since),
        motionFlags: 0,
      };
    case "rise":
      return { motion: MOTION.rise, motionPeriod: 200, motionSince: now - (wall - motion.since), motionFlags: 0 };
    default:
      return {
        motion: MOTION[motion.kind],
        motionPeriod: motion.periodMs,
        motionSince: now - (wall % Math.max(1, motion.periodMs)),
        motionFlags: 0,
      };
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
    case "seatTag":
      return { scaleRule: SCALE_RULE.seatTag, scaleCap: scale.cap, anchorX: scale.anchor.x, anchorY: scale.anchor.y };
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

/** How long a same-key style change eases; the shader holds the other half. */
export const STYLE_TRANSITION_MS = DURATION.state;

const approximateMeasure = (run: TextRun): number => run.text.length * run.size * 0.6;

export const createScene = (options: {
  readonly painter: CardPainter;
  readonly mode?: ThemeMode;
  readonly measure?: (run: TextRun) => number;
  /** The shell's atlas: the cell a quad's text or sprite draws from, or NO_ATLAS_CELL. */
  readonly source?: (quad: Quad, scale: number) => number;
  /** Device pixels per board unit, at the camera right now. */
  readonly scale?: () => number;
  /** The atlas's cell-table revision; a change re-uploads the UVs. */
  readonly atlasRevision?: () => number;
}) => {
  let mode: ThemeMode = options.mode ?? "dark";
  let theme: GpuTheme = themeGpu(mode);
  let styles = createStyleTable(theme);
  let styleRevision = 0;
  let knownStyles = 0;
  const painter = options.painter;
  const env: PaintEnv = { measure: options.measure ?? approximateMeasure };

  const atlasRevisionNow = (): number => options.atlasRevision?.() ?? 0;
  const atlasScaleNow = (): number => atlasScale(options.scale?.() ?? 1);
  const resolveSource = (quad: Quad, scale: number): number =>
    options.source === undefined ? NO_ATLAS_CELL : options.source(quad, scale);

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
  /** The wall time the last style transition ends; the loop draws until then. */
  let transitionUntil = 0;
  /** Page-relative milliseconds, the shader's clock (small enough for f32). */
  let clockNow = 0;
  /** Epoch milliseconds, the wall clock the DOM ring's phase reads. */
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

  const packQuad = (quad: Quad, slot: number, fresh: boolean): PackedQuad => {
    const style = styles.intern(quad.style);
    if (styles.size !== knownStyles) {
      knownStyles = styles.size;
      styleRevision += 1;
    }
    // A style change on the same key is a transition: the record keeps the
    // style it left and when. A repaint with the same style keeps a running
    // transition's start. A fresh slot starts already at its style.
    const at = slot * QUAD_FLOATS;
    const oldStyle = quads.u32[at + 27];
    const previous = fresh
      ? { previousStyle: style, changeAt: clockNow }
      : oldStyle === style
        ? { previousStyle: quads.u32[at + 28] ?? style, changeAt: quads.f32[at + 29] ?? clockNow }
        : { previousStyle: oldStyle ?? style, changeAt: clockNow };
    if (!fresh && oldStyle !== style) transitionUntil = Math.max(transitionUntil, clockNow + STYLE_TRANSITION_MS);
    const radius = typeof quad.radii === "number"
      ? ([quad.radii, quad.radii, quad.radii, quad.radii] as const)
      : quad.radii ?? ([0, 0, 0, 0] as const);
    return {
      rect: quad.rect,
      radii: radius,
      // Colours live in the style table (B); a record names its style and
      // nothing else, so a theme switch rewrites no record.
      fill: 0,
      fillTo: 0,
      stroke: 0,
      strokeWidth: 0,
      opacity: 1,
      shape: quad.shape === undefined ? SHAPE.rect : SHAPE_OF[quad.shape],
      kind: KIND_OF[quad.kind],
      tiers: quad.tiers,
      ...packScale(quad.scale),
      ...packMotion(quad.motion, clockNow, wallNow),
      source: resolveSource(quad, atlasScaleNow()),
      gradientAngle: 0,
      style,
      ...previous,
      dash: 0,
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
      let fresh = false;
      if (slot === undefined) {
        slot = allocateQuad();
        card.quads.set(quad.key, slot);
        held.add(slot);
        fresh = true;
      }
      writeQuad(quads, slot, packQuad(quad, slot, fresh), card.slot);
      dirtyQuads.add(slot);
    }
    quadSlotsOf.set(card.slot, held);
    const previous = card.ordered;
    const ordered = sorted.map((quad) => ({
      key: quad.key,
      slot: card.quads.get(quad.key)!,
      z: quad.z,
      band: BAND_OF[quad.band],
      motion: quad.motion,
      tiers: quad.tiers,
      painted: quad,
    }));
    card.ordered = ordered;
    card.dim = result.dim;
    card.lift = result.lift;
    writeOwner(card);
    grid.set(card.slot, insetBy(card.rect, 28));
    // A style-only repaint (a seat report, a selection) leaves the order
    // list alone; a new key, a restack or a band move rewrites it.
    let orderChanged = previous.length !== ordered.length;
    if (!orderChanged) {
      for (let index = 0; index < ordered.length; index += 1) {
        const a = previous[index]!;
        const b = ordered[index]!;
        if (a.slot !== b.slot || a.band !== b.band || a.z !== b.z || a.tiers !== b.tiers || !sameMotion(a.motion, b.motion)) {
          orderChanged = true;
          break;
        }
      }
    }
    if (orderChanged) markOrder();
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
      connecting: wireMode === "connecting",
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
      existing.size = undefined;
      const rect = rectOfFact(fact);
      if (!sameRect(existing.rect, rect)) {
        existing.rect = rect;
        markOrder();
      }
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
    transitionUntil = 0;
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
        // A theme switch rewrites the style table's colour channels in place;
        // records keep their style ids, so no record changes there.
        mode = op.mode;
        theme = themeGpu(mode);
        styles.setTheme(theme);
        styleRevision += 1;
        // Generated art (portraits, icons, bands, glyph masks) bakes the mode
        // into its SVG at paint time, and the atlas keys every sprite cell by
        // mode, so each card repaints to hand the atlas the new refs.
        for (const card of byId.values()) repaint(card);
        return;
      }
      case "wireMode": {
        const wasConnecting = wireMode === "connecting";
        wireMode = op.mode;
        // The source handles show only while a connect runs, so every card
        // repaints on the way in and out of it.
        if (wasConnecting !== (op.mode === "connecting")) {
          for (const card of byId.values()) repaint(card);
        }
        return;
      }
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
    if (next.size === dragging.size && [...next].every((id) => dragging.has(id))) return;
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
    const resized = card.size !== undefined;
    card.size = undefined;
    moveCard(id, rectOfFact(card.fact));
    if (resized) paint(card);
  };

  /** A live resize draws the card at its new size until the writer's fact lands. */
  const resizeCard = (id: NodeId, rect: Rect): void => {
    const card = byId.get(id);
    if (card === undefined) return;
    card.rect = rect;
    card.size = { width: rect.width, height: rect.height };
    writeOwner(card);
    grid.set(card.slot, insetBy(card.rect, 28));
    paint(card);
  };

  /** Cards whose rectangles meet a board rectangle, in paint order (the pointer machine's query). */
  const query = (rect: Rect): NodeId[] => {
    const found: number[] = [];
    grid.query(rect, found);
    return orderCards(found).map((card) => card.id);
  };

  const rectOf = (id: NodeId): Rect | undefined => byId.get(id)?.rect;
  const cardOf = (id: NodeId): CardFact | undefined => byId.get(id)?.fact;

  /**
   * The turning ring's angle as the DOM's rotate() shows it at `wall`. The
   * ring's own spin answers first: a card can carry another turning quad (a
   * band's chase, a cluster ring), and those have their own periods, so
   * answering whichever turn quad came first made the phase test read a
   * different lap than the mark it compares against.
   */
  const ringAngle = (id: NodeId, wall: number): number | undefined => {
    const card = byId.get(id);
    if (card === undefined) return undefined;
    let chosen: Extract<QuadMotion, { kind: "turn" }> | undefined;
    for (const quad of card.ordered) {
      const motion = quad.motion;
      if (motion === undefined || motion.kind !== "turn") continue;
      if (quad.key.endsWith(".spin")) {
        chosen = motion;
        break;
      }
      chosen ??= motion;
    }
    if (chosen === undefined) return undefined;
    const lap = chosen.periodMs > 0 ? chosen.periodMs : 1;
    const phase = (((wall % lap) + lap) % lap) / lap;
    const angle = 360 * (chosen.ccw === true ? 1 - phase : phase);
    return angle === 360 ? 0 : angle;
  };

  const visibleSlots: number[] = [];
  const visibleCards: CardSlot[] = [];
  const previousOrder: number[] = [];
  let lastView: Rect = { x: 0, y: 0, width: -1, height: -1 };
  let lastTier: CanvasTier | undefined;
  let lastAtlasScale = -1;
  let lastAtlasRevision = -1;
  let orderReady = false;

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
    const sourceScale = atlasScaleNow();
    const revision = atlasRevisionNow();
    // A still camera and an unchanged scene reuse the list: a turning ring
    // draws every tick without re-culling the board. A new atlas revision or
    // raster scale is a source change, not an order change, and is handled
    // below before this shortcut.
    if (
      orderReady &&
      !orderDirty &&
      tier === lastTier &&
      sameRect(view, lastView) &&
      sourceScale === lastAtlasScale &&
      revision === lastAtlasRevision
    ) {
      return { orderChanged: false, visible: orderCount, atlasRevision: revision };
    }
    visibleSlots.length = 0;
    grid.query(insetBy(view, 140), visibleSlots);
    // Fill the reusable visible list, in paint order, without a per-frame array.
    visibleCards.length = 0;
    for (const slot of visibleSlots) {
      const card = slots[slot];
      if (card !== undefined) visibleCards.push(card);
    }
    visibleCards.sort((a, b) => {
      if (a.fact.derived.z !== b.fact.derived.z) return a.fact.derived.z - b.fact.derived.z;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const cards = visibleCards;
    let needed = 0;
    for (const card of cards) needed += card.ordered.length;
    ensureOrderCapacity(needed);

    // Text and sprites name the atlas cell they draw from. When the raster
    // scale bucket changes (a zoom) or a raster lands (a revision), the
    // visible records take their new cell; the cell index changes with the
    // key, so the record's source word is rewritten in place.
    if (sourceScale !== lastAtlasScale || revision !== lastAtlasRevision) {
      lastAtlasScale = sourceScale;
      lastAtlasRevision = revision;
      for (const card of cards) {
        for (const ref of card.ordered) {
          if (ref.painted.text === undefined && ref.painted.sprite === undefined) continue;
          const source = resolveSource(ref.painted, sourceScale);
          const at = ref.slot * QUAD_FLOATS + 23;
          if (quads.u32[at] !== source) {
            quads.u32[at] = source;
            dirtyQuads.add(ref.slot);
          }
        }
      }
    }

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
    lastView = view;
    lastTier = tier;
    orderReady = true;
    return { orderChanged: changed, visible: orderCount, atlasRevision: revision };
  };

  const hasMotion = (at: number = clockNow): boolean => motionVisible || at < transitionUntil;

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
    ringAngle,
    prepare,
    hasMotion,
    index,
    takeQuadDirty,
    takeOwnerDirty,
    setClocks: (next: { readonly now: number; readonly wall: number }): void => {
      clockNow = next.now;
      wallNow = next.wall;
    },
    /** One clock for both, for a caller (a test) that does not split them. */
    setWallClock: (now: number): void => {
      clockNow = now;
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
    get styleBuffer(): Float32Array {
      return styles.buffer;
    },
    get styleCount(): number {
      return styles.size;
    },
    get styleRevision(): number {
      return styleRevision;
    },
    shadowSnapshot: (): { readonly meta: Uint32Array; readonly layers: Float32Array } => {
      const meta = new Uint32Array(styles.shadows.length * 4);
      const layers: number[] = [];
      styles.shadows.forEach((spec: ShadowSpec, index) => {
        meta[index * 4] = spec.layers.length;
        meta[index * 4 + 1] = layers.length / 8;
        for (const layer of spec.layers) {
          const named = layer.color === undefined ? undefined : theme.colors[layer.color];
          const colour = named ?? spec.tint ?? { r: 0, g: 0, b: 0, a: 0 };
          const alpha = layer.alpha === undefined ? colour.a : colour.a * layer.alpha;
          layers.push(layer.dx, layer.dy, layer.blur, layer.spread);
          layers.push(colour.r, colour.g, colour.b, alpha);
        }
      });
      return { meta, layers: new Float32Array(layers) };
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
