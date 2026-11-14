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

import { farSeatScale, nodeScale, seatFloorScale } from "@shared/canvas-tier";
import { holdsSeatRing, renderedNodeSize } from "@shared/node-geometry";
import { SEAT_CONTENT_CENTRE_DX } from "../paint/card-spec";
import { DURATION, themeGpu, type GpuTheme, type ThemeMode } from "@shared/theme";
import type {
  CanvasTier,
  CardFact,
  CardPaint,
  CardView,
  HandleSide,
  Hit,
  NodeId,
  PaintEnv,
  Part,
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
import { HALO_BLUR, haloPadDevice } from "./text";
import { CARD_CELL, RectGrid } from "./grid";
// A badge has no card, so the scene composes the pure cluster painter itself:
// the plan's geometry is `seat-clusters.ts`, its quads are `paint/cluster.ts`.
import {
  CLUSTER,
  clusterHeldAt,
  clusterIndexOf,
  clustersFor,
  paintClusterBadge,
  type ClusterInput,
  type ClusterSeatFact,
} from "../paint/cluster";
import type { ClusterIndex, SeatCluster } from "../../lib/seat-clusters";

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

/** A cluster badge's slot: an owner entry and quads of its own, with no card. */
type ClusterSlot = {
  readonly key: string;
  members: ReadonlyArray<NodeId>;
  /** Its own owner-buffer entry: the badge's disc, the box the ring scales about. */
  readonly owner: number;
  /** The disc in board units; the quads are stored relative to it. */
  rect: Rect;
  quads: Map<string, number>;
  ordered: QuadRef[];
  /** What the badge draws; a change is what repaints it. */
  signature: string;
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
  /** The camera zoom, for the multiplier a quad's scale rule adds. */
  readonly zoom?: () => number;
  /** The atlas's cell-table revision; a change re-uploads the UVs. */
  readonly atlasRevision?: () => number;
  /**
   * Whether motion is running (the app's surface motion gate): a `paused`
   * quad draws only while it is not, a `live` quad only while it is. Absent:
   * live, the way a ring draws in a window nobody paused.
   */
  readonly motionLive?: () => boolean;
  /**
   * Whether the camera has come to rest. While it moves, a record keeps the
   * raster scale it already holds (section 8 rule 2: the existing raster is
   * scaled during a gesture, every visible run is exact once it rests).
   */
  readonly settled?: () => boolean;
  /**
   * Region watermarks at this zoom (`region-glance.ts`): 0 to 1 each, the
   * outer regions' and the nested ones'. A region repaints on a glance step
   * once the camera rests, so the name fades in at a far zoom without
   * re-rasterizing its text inside the gesture.
   */
  readonly glance?: (zoom: number) => { readonly region: number; readonly sub: number };
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

  /**
   * The multiplier a quad's scale rule adds on top of the camera's device
   * pixels per board unit: a far ring is drawn at `farSeat` times its board
   * size, a tag at `farSeat * 1.4`, a node at `nodeScale`. A cell rasterized
   * at the camera scale alone is upscaled on screen and reads blurry.
   */
  const scaleMultiplier = (quad: Quad, tier: CanvasTier, zoom: number): number => {
    switch (quad.scale.kind) {
      case "seat": {
        const far = Math.max(1, Math.min(farSeatScale(zoom), quad.scale.cap));
        if (tier === "far") return far;
        if (tier === "overview") return Math.max(seatFloorScale(zoom), Math.min(farSeatScale(zoom), quad.scale.cap));
        return 1;
      }
      case "seatTag":
        return farSeatScale(zoom) * 1.4;
      case "node":
        return nodeScale(zoom);
      case "board":
        return 1;
    }
  };

  const sourceScaleFor = (quad: Quad): number =>
    atlasScale((options.scale?.() ?? 1) * scaleMultiplier(quad, currentTier, options.zoom?.() ?? 1));

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
  let hoveredPart: Part["kind"] | undefined;
  let hoveredHandle: CardView["hoveredHandle"] | undefined;
  /** The handle a connect gesture would land on: one dotted side, never all four. */
  let connectTarget: CardView["connectTarget"] | undefined;
  let dragging = new Set<NodeId>();
  let wireMode: WireMode = "rest";
  let wires = new Map<WireId, WireFact>();
  let motionVisible = false;
  /** The empty set a board with no clusters gathers. */
  const NO_SEATS: ReadonlySet<NodeId> = new Set();
  /** Badge slots by cluster key: their quads and owner entries. */
  const clusterSlots = new Map<string, ClusterSlot>();
  /** The badges this frame draws, hovered last. */
  let clustersActive: ClusterSlot[] = [];
  /** Seats a badge stands for this frame: hidden from the order and from picking. */
  let gatheredSeats: ReadonlySet<NodeId> = NO_SEATS;
  let hoveredCluster: string | null = null;
  /** The grouping index and the seat facts it was built from; held across frames. */
  let clusterCache: { readonly signature: string; readonly index: ClusterIndex; readonly byId: ReadonlyMap<NodeId, ClusterSeatFact> } | undefined;
  /** Links held at the last planned zoom; a zoom that changes it regroups. */
  let clusterHeld = -1;
  /** A seat, its ring, its selection or the theme changed since the last frame. */
  let clusterDirty = true;
  /** The active badges or their quads changed: the order list must be rebuilt. */
  let clusterVersion = 0;
  /** The wall time the last style transition ends; the loop draws until then. */
  let transitionUntil = 0;
  /** Page-relative milliseconds, the shader's clock (small enough for f32). */
  let clockNow = 0;
  /** Epoch milliseconds, the wall clock the DOM ring's phase reads. */
  let wallNow = 0;
  /** The tier the last prepared frame drew at; a quad's raster scale needs it. */
  let currentTier: CanvasTier = "near";
  /** The region watermarks in force (0 to 1): applied, not merely requested. */
  let glanceNow = { region: 0, sub: 0 };

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

  const writeOwnerAt = (slot: number, rect: Rect, lift: number, dim: CardPaint["dim"], centreDx = 0): void => {
    const at = slot * 8;
    // Words 5 and 6 carry the drawn box size and word 7 the point the far
    // seat rule centres on: the card box for a badge, the seat's content box
    // (the sheet pads it `1px 10px 1px 1px`) for a card that holds a ring.
    const next = [rect.x, rect.y, lift, dim.opacity, dim.saturate, rect.width, rect.height, centreDx];
    let changed = false;
    for (let index = 0; index < next.length; index += 1) {
      if (owners[at + index] !== next[index]) {
        owners[at + index] = next[index]!;
        changed = true;
      }
    }
    if (changed) dirtyOwners.add(slot);
  };

  const writeOwner = (card: CardSlot): void => {
    const row = card.fact.row;
    const path = "path" in row ? row.path : undefined;
    const centreDx = holdsSeatRing(row.kind, path) ? SEAT_CONTENT_CENTRE_DX : 0;
    writeOwnerAt(card.slot, card.rect, card.lift, card.dim, centreDx);
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
      source: resolveSource(quad, sourceScaleFor(quad)),
      gradientAngle: 0,
      hole: quad.hole ?? 0,
      style,
      ...previous,
      dash: 0,
    };
  };

  /**
   * The wash behind a `halo` run's words: the same run, soft, in the ground's
   * ink, on a quad grown by the halo's own padding so the shader's UV stretch
   * stays exact. Its cell is keyed by the blurred run, so it never shares the
   * sharp glyphs' coverage.
   */
  const haloPassOf = (quad: Quad): Quad | undefined => {
    const run = quad.text;
    if (quad.kind !== "text" || run === undefined || run.halo !== true) return undefined;
    const scale = sourceScaleFor(quad);
    const pad = haloPadDevice(scale) / scale; // board units, exact at this scale
    return {
      ...quad,
      key: `halo:${quad.key}`,
      // The wash sits under its own words, and above whatever was under them: a
      // hair under the glyph quad's z keeps that true whatever the key is.
      z: quad.z - 0.001,
      rect: {
        x: quad.rect.x - pad,
        y: quad.rect.y - pad,
        width: quad.rect.width + 2 * pad,
        height: quad.rect.height + 2 * pad,
      },
      style: { ...quad.style, ink: { token: "ground" } },
      // Same text, same wrap width: the wash must break and ellipsize with the
      // words it sits behind, so only the mask softens.
      text: { ...run, halo: false, blur: HALO_BLUR },
      // Picking still answers for the words' own box, never the wash's growth.
      part: undefined,
    };
  };

  const paint = (card: CardSlot): void => {
    // A live resize draws the size the pointer holds; the writer's fact still
    // carries the old row until the drop, and painters read the row.
    const drawn: CardFact =
      card.size === undefined
        ? card.fact
        : { ...card.fact, row: { ...card.fact.row, width: card.size.width, height: card.size.height } };
    const result = painter(drawn, card.live, card.view, env);
    // A halo run lays down its wash first, as the DOM's text-shadow does. The
    // cell stays one colour each: the halo is a ground-tinted coverage cell and
    // the glyphs are an ink-tinted one, so the text path's single tint holds.
    const painted = result.quads.flatMap((quad) => {
      const halo = haloPassOf(quad);
      return halo === undefined ? [quad] : [halo, quad];
    });
    const sorted = painted.sort(compareQuad);
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
      ...(hovered === fact.id && hoveredPart !== undefined ? { hoveredPart } : {}),
      ...(hovered === fact.id && hoveredHandle !== undefined ? { hoveredHandle } : {}),
      connecting: wireMode === "connecting",
      ...(connectTarget?.nodeId === fact.id ? { connectTarget } : {}),
      keyboardFocus: selection.focusedNodeId === fact.id,
      editing: editing === fact.id,
      dragging: dragging.has(fact.id),
      ...(reachMark === undefined ? {} : { reach: reachMark }),
      ...(focusRole === undefined ? {} : { focus: { kind: focus!.kind, role: focusRole } }),
      glance: glanceNow,
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

  // --- seat clusters: badges have no card ------------------------------------
  //
  // At far and overview two seats too close to draw as rings are one badge: a
  // portrait in a turning ring, a stack of rings and a count. The grouping is
  // `seat-clusters.ts`; the quads are `paint/cluster.ts`. A badge is given an
  // owner-buffer entry of its own (its disc), so its records are relative to
  // the disc and a moving centroid rewrites one owner entry. Gathered seats
  // draw nothing at all and answer no pointer, as the DOM's hidden nodes do.

  /** An owner entry with no card and no grid cell; card and badge slots share one index space. */
  const allocateOwnerSlot = (): number => {
    const slot = slots.length;
    slots.push(undefined);
    ensureOwnerCapacity(slots.length);
    return slot;
  };

  /** The disc a badge's owner box is: its ring grows about this box's centre. */
  const clusterRect = (cluster: SeatCluster): Rect => ({
    x: cluster.x - CLUSTER.disc / 2,
    y: cluster.y - CLUSTER.disc / 2,
    width: CLUSTER.disc,
    height: CLUSTER.disc,
  });

  /** A badge quad as its owner stores it: the disc is the origin. */
  const relativeTo = (quad: Quad, origin: Rect): Quad => {
    const rect = { ...quad.rect, x: quad.rect.x - origin.x, y: quad.rect.y - origin.y };
    if (quad.scale.kind === "board") return { ...quad, rect };
    const anchor = quad.scale.anchor;
    return { ...quad, rect, scale: { ...quad.scale, anchor: { x: anchor.x - origin.x, y: anchor.y - origin.y } } };
  };

  const releaseCluster = (card: ClusterSlot): void => {
    for (const slot of card.quads.values()) freeQuad(slot);
    card.quads.clear();
    card.ordered = [];
  };

  /** The badge's quads under its owner slot; keys keep their records across repaints. */
  const paintClusterSlot = (
    slot: ClusterSlot,
    cluster: SeatCluster,
    seats: ReadonlyMap<NodeId, ClusterSeatFact>,
    input: ClusterInput,
  ): void => {
    const origin = clusterRect(cluster);
    slot.members = cluster.members;
    slot.rect = origin;
    writeOwnerAt(slot.owner, origin, 0, { opacity: 1, saturate: 1 });
    const sorted = paintClusterBadge(cluster, seats, input, env).map((quad) => relativeTo(quad, origin)).sort(compareQuad);
    const keys = new Set(sorted.map((quad) => quad.key));
    for (const key of [...slot.quads.keys()]) {
      if (keys.has(key)) continue;
      freeQuad(slot.quads.get(key)!);
      slot.quads.delete(key);
    }
    for (const quad of sorted) {
      let quadSlot = slot.quads.get(quad.key);
      const fresh = quadSlot === undefined;
      if (quadSlot === undefined) {
        quadSlot = allocateQuad();
        slot.quads.set(quad.key, quadSlot);
      }
      writeQuad(quads, quadSlot, packQuad(quad, quadSlot, fresh), slot.owner);
      dirtyQuads.add(quadSlot);
    }
    slot.ordered = sorted.map((quad) => ({
      key: quad.key,
      slot: slot.quads.get(quad.key)!,
      z: quad.z,
      band: BAND_OF[quad.band],
      motion: quad.motion,
      tiers: quad.tiers,
      painted: quad,
    }));
  };

  /** What a badge draws: its members and their rings, its portrait, its count, its hover. */
  const clusterSignature = (cluster: SeatCluster, seats: ReadonlyMap<NodeId, ClusterSeatFact>): string =>
    `${cluster.members.join(",")}|${cluster.members
      .map((id) => {
        const seat = seats.get(id);
        return seat === undefined ? "-" : `${seat.ring.ring}:${seat.ring.hue}:${seat.ring.stale ? 1 : 0}:${String(seat.ringSince)}`;
      })
      .join(",")}|${JSON.stringify(seats.get(cluster.members[0] ?? "")?.portrait ?? null)}|${hoveredCluster === cluster.key ? "h" : ""}`;

  /** Every seat the plan reads: its card centre, region, ring, selection and portrait. */
  const clusterSeats = (): { readonly seats: ClusterSeatFact[]; readonly signature: string } => {
    const selected = new Set(selection.nodeIds);
    const seats: ClusterSeatFact[] = [];
    for (const card of byId.values()) {
      if (card.fact.row.kind !== "agent" || card.live === undefined) continue;
      seats.push({
        id: card.id,
        x: card.rect.x + card.rect.width / 2,
        y: card.rect.y + card.rect.height / 2,
        region: card.fact.derived.regionId ?? "",
        ring: card.live.ring,
        ringSince: card.live.ringSince,
        selected: selected.has(card.id),
        ...(card.live.portrait === undefined ? {} : { portrait: card.live.portrait }),
      });
    }
    seats.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // What the grouping depends on: where a seat is, its region, whether it
    // stays apart (selected, or a ring that calls) and its identity.
    const signature = seats
      .map((seat) => `${seat.id}:${String(Math.round(seat.x))},${String(Math.round(seat.y))}:${seat.region}:${seat.selected ? 1 : 0}:${seat.ring.ring}`)
      .join("|");
    return { seats, signature };
  };

  /**
   * Regroup and repaint the badges for this frame, at far and overview only.
   * Returns a version that changes whenever the order list must be rebuilt:
   * a badge appeared, left the plan, or repainted, or a seat gathered.
   */
  const refreshClusters = (view: Rect, tier: CanvasTier): number => {
    if (tier !== "far" && tier !== "overview") {
      if (clustersActive.length > 0 || gatheredSeats.size > 0) {
        for (const slot of clustersActive) releaseCluster(slot);
        clustersActive = [];
        gatheredSeats = NO_SEATS;
        clusterVersion += 1;
      }
      clusterCache = undefined;
      clusterHeld = -1;
      clusterDirty = false;
      return clusterVersion;
    }
    const dirty = clusterDirty;
    clusterDirty = false;
    if (dirty || clusterCache === undefined) {
      const { seats, signature } = clusterSeats();
      if (clusterCache === undefined || clusterCache.signature !== signature) {
        clusterCache = { signature, index: clusterIndexOf(seats), byId: new Map(seats.map((seat) => [seat.id, seat] as const)) };
        clusterHeld = -1;
      } else {
        clusterCache = { signature, index: clusterCache.index, byId: new Map(seats.map((seat) => [seat.id, seat] as const)) };
      }
    }
    const cache = clusterCache;
    if (cache === undefined) return clusterVersion;
    const zoom = options.zoom?.() ?? 1;
    const screen = { width: view.width * zoom, height: view.height * zoom };
    const held = clusterHeldAt(cache.index, zoom, screen);
    if (!dirty && held === clusterHeld) return clusterVersion;
    clusterHeld = held;
    const plan = clustersFor(cache.index, held);
    const input: ClusterInput = {
      seats: [...cache.byId.values()],
      zoom,
      view: screen,
      mode,
      ...(hoveredCluster === null ? {} : { hoveredKey: hoveredCluster }),
    };
    const active: ClusterSlot[] = [];
    const live = new Set<string>();
    for (const cluster of plan.clusters) {
      live.add(cluster.key);
      let slot = clusterSlots.get(cluster.key);
      if (slot === undefined) {
        slot = {
          key: cluster.key,
          members: cluster.members,
          owner: allocateOwnerSlot(),
          rect: clusterRect(cluster),
          quads: new Map(),
          ordered: [],
          signature: "",
        };
        clusterSlots.set(cluster.key, slot);
      }
      const signature = clusterSignature(cluster, cache.byId);
      if (slot.signature !== signature) {
        slot.signature = signature;
        paintClusterSlot(slot, cluster, cache.byId, input);
        clusterVersion += 1;
      } else {
        // The badge holds still; only its owner follows the centroid.
        slot.members = cluster.members;
        const rect = clusterRect(cluster);
        if (!sameRect(slot.rect, rect)) {
          slot.rect = rect;
          writeOwnerAt(slot.owner, rect, 0, { opacity: 1, saturate: 1 });
        }
      }
      active.push(slot);
    }
    for (const [key, slot] of clusterSlots) {
      if (live.has(key) || slot.ordered.length === 0) continue;
      releaseCluster(slot);
      slot.signature = "";
      clusterVersion += 1;
    }
    // The hovered badge rides above the rest, as the DOM's z says.
    active.sort((a, b) => (a.key === hoveredCluster ? 1 : 0) - (b.key === hoveredCluster ? 1 : 0) || (a.key < b.key ? -1 : 1));
    clustersActive = active;
    gatheredSeats = plan.gathered;
    return clusterVersion;
  };

  /** The badge under a board point, if any (the disc; badges paint above cards). */
  const clusterSlotAt = (at: Point): ClusterSlot | undefined => {
    for (let index = clustersActive.length - 1; index >= 0; index -= 1) {
      const slot = clustersActive[index];
      if (slot !== undefined && contains(slot.rect, at)) return slot;
    }
    return undefined;
  };

  const putCard = (fact: CardFact): void => {
    clusterDirty = true;
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
    clusterDirty = true;
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
    for (const slot of clusterSlots.values()) releaseCluster(slot);
    clusterSlots.clear();
    clustersActive = [];
    gatheredSeats = NO_SEATS;
    hoveredCluster = null;
    clusterCache = undefined;
    clusterHeld = -1;
    clusterDirty = true;
    clusterVersion += 1;
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
        if (card.fact.row.kind === "agent") clusterDirty = true;
        repaint(card);
        return;
      }
      case "selection": {
        const before = selection;
        selection = op.fact;
        clusterDirty = true;
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
        // A badge's portrait, ring and count art bake the mode too.
        for (const slot of clusterSlots.values()) slot.signature = "";
        clusterDirty = true;
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

  const setHover = (
    id: NodeId | null,
    part?: Part["kind"],
    at?: Point,
    handle?: CardView["hoveredHandle"],
  ): boolean => {
    // A badge has no card id: the point names the cluster under the pointer.
    const nextCluster = part === "cluster" && at !== undefined ? (clusterSlotAt(at)?.key ?? null) : null;
    const clusterChanged = nextCluster !== hoveredCluster;
    hoveredCluster = nextCluster;
    if (clusterChanged) clusterDirty = true;
    const sameHandle =
      hoveredHandle?.side === handle?.side && hoveredHandle?.role === handle?.role;
    if (hovered === id && hoveredPart === part && sameHandle && !clusterChanged) return false;
    const before = hovered;
    hovered = id;
    hoveredPart = id === null ? undefined : part;
    hoveredHandle = id === null ? undefined : handle;
    if (before !== null) repaintIds([before]);
    if (id !== null) repaintIds([id]);
    return true;
  };

  const setConnectTarget = (target: { readonly nodeId: NodeId; readonly handle: string } | null): void => {
    const match = target === null ? null : /^([st])-(top|right|bottom|left)$/.exec(target.handle);
    const next: CardView["connectTarget"] =
      target === null || match === null
        ? undefined
        : { nodeId: target.nodeId, side: match[2] as HandleSide, role: match[1] === "s" ? "source" : "target" };
    const was = connectTarget;
    if (was?.nodeId === next?.nodeId && was?.side === next?.side && was?.role === next?.role) return;
    connectTarget = next;
    if (was !== undefined) repaintIds([was.nodeId]);
    if (next !== undefined) repaintIds([next.nodeId]);
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
    if (card.fact.row.kind === "agent") clusterDirty = true;
    // A move is an owner offset: the records keep their order, so a drag
    // frame must not rebuild the order list (it stuttered on the first drag).
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
    if (card.fact.row.kind === "agent") clusterDirty = true;
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
  let lastSourceEpoch = "";
  let lastAtlasRevision = -1;
  let lastMotionLive: boolean | undefined;
  /** The badge version the last prepared frame drew. */
  let lastClusters = -1;
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
    currentTier = tier;
    const motionOn = options.motionLive?.() ?? true;
    const zoom = options.zoom?.() ?? 1;
    // Region watermarks are a style on the region's name quads, not a raster:
    // they step with the zoom. A step waits for the camera's rest, so the
    // text is never re-rasterized inside a gesture (section 8 rule 2).
    const glance = options.glance?.(zoom);
    if (glance !== undefined && (glance.region !== glanceNow.region || glance.sub !== glanceNow.sub)) {
      if (options.settled?.() ?? true) {
        glanceNow = { region: glance.region, sub: glance.sub };
        for (const card of byId.values()) {
          if (card.fact.row.kind === "region") repaint(card);
        }
      }
    }
    // A source is right for one camera bucket, one tier and one zoom (the
    // scale rules read the zoom), plus one atlas revision.
    const sourceEpoch = `${String(atlasScaleNow())}|${String(options.zoom?.() ?? 1)}|${tier}`;
    const revision = atlasRevisionNow();
    // Grouping comes before the order: a badge that appeared, parted or
    // repainted rewrites the visible list's tail.
    const clusters = refreshClusters(view, tier);
    // A still camera and an unchanged scene reuse the list: a turning ring
    // draws every tick without re-culling the board. A new atlas revision or
    // raster scale is a source change, not an order change, and is handled
    // below before this shortcut.
    if (
      orderReady &&
      !orderDirty &&
      tier === lastTier &&
      sameRect(view, lastView) &&
      motionOn === lastMotionLive &&
      clusters === lastClusters &&
      sourceEpoch === lastSourceEpoch &&
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
    for (const card of cards) {
      if (gatheredSeats.has(card.id)) continue;
      needed += card.ordered.length;
    }
    for (const slot of clustersActive) needed += slot.ordered.length;
    ensureOrderCapacity(needed);

    // Text and sprites name the atlas cell they draw from. When the raster
    // scale bucket changes (a zoom) or a raster lands (a revision), the
    // visible records take their new cell; the cell index changes with the
    // key, so the record's source word is rewritten in place.
    if (sourceEpoch !== lastSourceEpoch || revision !== lastAtlasRevision) {
      // Section 8 rule 2: during a gesture the raster already in hand is
      // scaled; every run becomes exact once the camera rests. Resolving the
      // whole visible board here on every wheel tick ran canvas2d, measureText
      // and SVG decode for hundreds of runs inside the gesture and dropped its
      // frames. A record with no cell yet is still resolved at once, so a card
      // that arrives mid-gesture is never blank.
      const exact = options.settled?.() ?? true;
      if (exact) {
        lastSourceEpoch = sourceEpoch;
        lastAtlasRevision = revision;
      }
      for (const card of cards) {
        for (const ref of card.ordered) {
          if (ref.painted.text === undefined && ref.painted.sprite === undefined) continue;
          const at = ref.slot * QUAD_FLOATS + 23;
          if (!exact && quads.u32[at] !== NO_ATLAS_CELL) continue;
          const source = resolveSource(ref.painted, sourceScaleFor(ref.painted));
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
        // A gathered seat draws nothing: its badge stands for it.
        if (gatheredSeats.has(card.id)) continue;
        for (const quad of card.ordered) {
          if (quad.band !== band) continue;
          // Motion's gate: a ring's rest pose draws only while motion is off,
          // its moving parts only while it runs (contract, `Quad.gate`).
          if (quad.painted.gate !== undefined && (quad.painted.gate === "live") !== motionOn) continue;
          order[counts[0]! + counts[1]! + counts[2]!] = quad.slot;
          counts[band] = counts[band]! + 1;
          if (quad.motion !== undefined && (quad.tiers & mask) !== 0) moving = true;
        }
      }
      // Badges paint in the lifted band, over every card (DOM z 3000).
      if (band === 2) {
        for (const slot of clustersActive) {
          for (const quad of slot.ordered) {
            order[counts[0]! + counts[1]! + counts[2]!] = quad.slot;
            counts[2] = counts[2]! + 1;
            if (quad.motion !== undefined && (quad.tiers & mask) !== 0) moving = true;
          }
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
    lastMotionLive = motionOn;
    lastClusters = clusters;
    orderReady = true;
    return { orderChanged: changed, visible: orderCount, atlasRevision: revision };
  };

  const hasMotion = (at: number = clockNow): boolean => motionVisible || at < transitionUntil;

  const index: SpatialIndex = {
    cardsAt: (at) => {
      const found: number[] = [];
      grid.query({ x: at.x, y: at.y, width: 0, height: 0 }, found);
      return orderCards(found)
        .filter((card) => !gatheredSeats.has(card.id) && contains(card.rect, at))
        .map((card) => card.id);
    },
    cardsNear: (at, slop) => {
      const found: number[] = [];
      grid.query({ x: at.x - slop, y: at.y - slop, width: slop * 2, height: slop * 2 }, found);
      return orderCards(found)
        .filter((card) => !gatheredSeats.has(card.id))
        .map((card) => card.id);
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
    setConnectTarget,
    setDragging,
    moveCard,
    restoreCard,
    resizeCard,
    query,
    rectOf,
    cardOf,
    ringAngle,
    /** The members of the badge under a board point, if any (the pointer's cluster hit). */
    clusterAt: (at: Point) => clusterSlotAt(at)?.members,
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
        // The shader indexes vec4s; a layer is two of them.
        meta[index * 4 + 1] = layers.length / 4;
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
