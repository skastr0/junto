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
 * Work scales with the screen, not the board. Every card keeps its facts,
 * rectangle and owner entry for the whole board (picking, clusters and every
 * seat's address need nothing more), but its quads are built only once it
 * comes near the screen, and released once it is well off it. An atlas cell
 * is held by a record only while the quad is live: its card in the view plus
 * margin, its tier drawn (or the tier the zoom is about to cross into, or a
 * camera jump's destination), its motion gate open. Held cells are what the
 * atlas keeps; nothing on screen is ever reclaimed. The draw list keeps only
 * the current tier's quads and is rebuilt when the set of grid cells around
 * the view changes, not on every pan frame.
 *
 * Nothing here touches the DOM, a React store or the camera; the engine hands
 * it the view rectangle, the tier and the theme.
 */

import { farSeatScale, hoverCardScale, nodeScale, seatFloorScale, tierForZoom } from "@shared/canvas-tier";
import { ringKeepsApart } from "@shared/wire/urgency";
import { holdsSeatRing, renderedNodeSize } from "@shared/node-geometry";
import { SEAT_CONTENT_CENTRE_DX } from "../paint/card-spec";
import { DURATION, themeGpu, type GpuTheme, type ThemeMode } from "@shared/theme";
import type {
  CanvasTier,
  CardFact,
  CardPaint,
  CardView,
  HandleSide,
  DrawnCluster,
  DrawnPart,
  MotionPeaks,
  Hit,
  NodeId,
  PaintEnv,
  Part,
  Point,
  Quad,
  QuadMotion,
  QuadStyle,
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
import { ALL_TIERS, CAMERA_MAX_ZOOM, CAMERA_MIN_ZOOM, TIER_BIT } from "../contract";
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
  keepsApart,
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
  /** It draws from the atlas (text or sprite), so its record may hold a cell. */
  readonly atlas: boolean;
};

/** A card's quads split by band, in paint order: the draw list concatenates them. */
type Banded = readonly [ReadonlyArray<QuadRef>, ReadonlyArray<QuadRef>, ReadonlyArray<QuadRef>];
const NO_BANDS: Banded = [[], [], []];

/**
 * What a card's records are wanted for at the last draw-list rebuild: the
 * view (draw now, and the next tier ahead), a camera jump's destination, or
 * nothing. Only a card with a role holds atlas cells.
 */
type Role = { readonly view: boolean; readonly jump: boolean };

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
  /** `ordered` split by band. */
  bands: Banded;
  dim: CardPaint["dim"];
  lift: number;
  /** The size a live resize is drawing at, until the writer's fact lands. */
  size?: { readonly width: number; readonly height: number };
  /** Its quads are built (it has been near the screen). */
  painted: boolean;
  /** A fact or view changed while it was not painted, or painted off screen. */
  stale: boolean;
  /** The rebuild that last gave it a role; a card with an older stamp holds no cells. */
  stamp: number;
  role: Role;
  /** Its place in paint order (z, then id), from the sorted master list. */
  paintIndex: number;
  /**
   * Where its quads sit in the draw list, per band: start and length, three
   * pairs. Valid only when `runsEpoch` is the current rebuild's, so one card's
   * repaint can splice its own runs instead of rebuilding the list (issue 915).
   */
  runs?: number[];
  runsEpoch?: number;
  /**
   * The filled body the card draws at the mid tier, card-local: the seat pill
   * that hugs its name (paint/mid.ts), narrower than the card's own box. Kept
   * across repaints and a hover bloom, since the bloom is a paint effect and
   * the wire's seat is still the pill.
   */
  midBody?: Rect;
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
  /** The rebuild that last found it near the screen; only then does it hold cells. */
  stamp: number;
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

/** How long each one-shot motion runs (contract.ts `QuadMotion`, the shader's ages). */
const ONE_SHOT_MS = { land: 720, landed: 720, rise: 200 } as const;
/** The vertex stage's largest motion growth (send, 1.31) and shift (rise, 3 units). */
const MOTION_GROWTH = 1.31;
const MOTION_SHIFT = 3;

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

const intersects = (a: Rect, b: Rect): boolean =>
  a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;

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
    case "hover":
      return { scaleRule: SCALE_RULE.hover, scaleCap: 1, anchorX: scale.anchor.x, anchorY: scale.anchor.y };
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
  /**
   * The atlas's lookup without references (the older interface): the cell a
   * quad's text or sprite draws from, or NO_ATLAS_CELL. `acquire` wins.
   */
  readonly source?: (quad: Quad, scale: number) => number;
  /**
   * The atlas (scene-to-atlas interface, issue 911/issue 912): a record takes one
   * reference to the cell for this quad at this scale; `previous` is the cell
   * it held, and the atlas settles that reference itself (same key: kept;
   * new key: released once the new image lands). The index is stable while
   * any reference is held, so an atlas event never rewrites a record.
   */
  readonly acquire?: (quad: Quad, scale: number, previous?: number) => number;
  /** The record lets go of a cell it held. */
  readonly release?: (cell: number) => void;
  /** The cell's entry points at pixels: its own, a stand-in or a kept previous. */
  readonly hasImage?: (cell: number) => boolean;
  /** Rasterize the cell now, before the frame is submitted: the last resort for an in-view quad with no image. */
  readonly ensureNow?: (cell: number) => void;
  /**
   * Decode a sprite's source (SVG per theme, media file) ahead, and let it
   * go. The scene holds one per built sprite record: a card's sources are
   * decoded when it enters the shape build range, which is wider than the
   * raster margin, and released when it leaves, so ensureNow draws in frame.
   */
  readonly prepareSource?: (quad: Quad) => void;
  readonly releaseSource?: (quad: Quad) => void;
  /** The frame clock in ms, for the measured margin (camera speed, raster latency). */
  readonly now?: () => number;
  /** Peaks measured in an earlier session: the margin and tier window start from them. */
  readonly peaks?: MotionPeaks;
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
  const acquireCell = (quad: Quad, scale: number, previous: number): number => {
    if (options.acquire !== undefined) return options.acquire(quad, scale, previous === NO_ATLAS_CELL ? undefined : previous);
    return options.source === undefined ? NO_ATLAS_CELL : options.source(quad, scale);
  };
  const releaseCell = (cell: number): void => {
    if (cell !== NO_ATLAS_CELL) options.release?.(cell);
  };
  /** Without the newer interface a held cell is taken to have its image. */
  const hasImage = (cell: number): boolean =>
    cell !== NO_ATLAS_CELL && (options.hasImage === undefined || options.hasImage(cell));

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
      case "hover":
        return hoverCardScale(zoom);
      case "board":
        return 1;
    }
  };

  /** Device pixels per board unit at zoom 1: the camera scale is this times the zoom. */
  const pixelRatioNow = (): number => (options.scale?.() ?? 1) / (options.zoom?.() ?? 1);

  /** The raster scale a quad draws at in `tier` at `zoom`, bucketed as the atlas keys it. */
  const scaleAt = (quad: Quad, tier: CanvasTier, zoom: number): number =>
    atlasScale(pixelRatioNow() * zoom * scaleMultiplier(quad, tier, zoom));

  const sourceScaleFor = (quad: Quad): number => scaleAt(quad, currentTier, options.zoom?.() ?? 1);

  // Initial capacities only: every buffer below doubles on demand.
  let quads: QuadBuffer = createQuadBuffer(1024);
  let heldScale = new Float64Array(1024);
  let quadCapacity = 1024;
  /** Records holding a cell that had no image when last looked at: the per-frame blank check reads only these. */
  const blankCandidates = new Map<number, QuadRef>();
  let quadCount = 0;
  let owners = new Float32Array(256 * 8);
  let ownerCapacity = 256;
  let order = new Uint32Array(1024);
  let orderCount = 0;
  let bandEnds: [number, number, number] = [0, 0, 0];
  let orderDirty = true;
  /** The draw list is culled on the GPU (renderer `setCull("gpu")`): candidates keep every tier. */
  let cullOnGpu = false;

  const slots: Array<CardSlot | undefined> = [];
  const freeSlots: number[] = [];
  const byId = new Map<NodeId, CardSlot>();
  /** Every card, sorted into paint order (z, then id) when `paintIndexDirty`; `paintIndex` is the index. */
  const master: CardSlot[] = [];
  let paintIndexDirty = true;
  /** Cards whose quads are built; a rebuild releases those well off screen. */
  const paintedCards = new Set<CardSlot>();
  /** Badge slots by owner index, for the per-frame blank check. */
  const badgeByOwner = new Map<number, ClusterSlot>();
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
  /**
   * The drawn quads that move, from the last rebuild, with their owners. Each
   * frame tests them against the real view, not the build range's margin: a
   * periodic motion in view keeps the loop running, a one-shot only until it
   * ends (issue 915). Nothing visible stops.
   */
  let movers: Array<{ readonly ref: QuadRef; readonly owner: number }> = [];
  /** Page-clock instant the last one-shot in view ends. */
  let oneShotUntil = 0;
  /** The board rectangles the in-view movers can reach this frame (the damage). */
  const moverRects: Rect[] = [];
  /** Page-clock instant of the last motion test, so a one-shot that ended since is drawn at rest once. */
  let motionTestedAt = 0;
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
  let clusterCache: { readonly signature: string; readonly index: ClusterIndex; readonly byId: Map<NodeId, ClusterSeatFact> } | undefined;
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
  /** Cards whose runs changed since the last frame, for a splice instead of a rebuild. */
  const spliceQueue = new Set<CardSlot>();
  /** Draw-list rebuilds and single-card splices so far. */
  let rebuildCount = 0;
  let spliceCount = 0;

  const ensureQuadCapacity = (needed: number): void => {
    if (needed <= quadCapacity) return;
    let capacity = quadCapacity;
    while (capacity < needed) capacity *= 2;
    const next = createQuadBuffer(capacity);
    next.f32.set(quads.f32);
    quads = next;
    const scales = new Float64Array(capacity);
    scales.set(heldScale);
    heldScale = scales;
    quadCapacity = capacity;
    allQuadsDirty = true;
  };

  // --- atlas cells held by records ---------------------------------------------
  //
  // A record's source word is the cell it holds a reference to, or none. It
  // takes one when its quad goes live and lets go when the quad stops being
  // live or its slot is freed. `heldScale` is the raster scale it was taken at.

  const SOURCE_WORD = 23;
  const cellOf = (slot: number): number => quads.u32[slot * QUAD_FLOATS + SOURCE_WORD]!;

  /** Take (or keep) the cell for `ref` at `scale`, handing the atlas the one held. */
  const holdCell = (ref: QuadRef, scale: number): void => {
    const slot = ref.slot;
    // A repaint hands a new ref: a placeholder restores from the current one.
    if (placeholding.has(slot)) placeholding.set(slot, ref);
    const at = slot * QUAD_FLOATS + SOURCE_WORD;
    const previous = quads.u32[at]!;
    const next = acquireCell(ref.painted, scale, previous);
    heldScale[slot] = scale;
    if (next !== previous) {
      quads.u32[at] = next;
      dirtyQuads.add(slot);
    }
    // Under the older lookup no cell means pending; under references it means
    // nothing to draw. Either way the per-frame check looks at it again.
    const pending = next === NO_ATLAS_CELL ? options.acquire === undefined : !hasImage(next);
    if (pending) {
      blankCandidates.set(slot, ref);
      if (next !== NO_ATLAS_CELL && (next !== previous || !waitingSince.has(slot))) waitingSince.set(slot, waitFrom(nowMs()));
      if (ref.painted.sprite !== undefined) holdPlaceholder(ref);
    } else {
      blankCandidates.delete(slot);
      waitingSince.delete(slot);
      unholdPlaceholder(slot);
    }
  };

  /** Let go of whatever the record holds. */
  const dropCell = (slot: number): void => {
    const at = slot * QUAD_FLOATS + SOURCE_WORD;
    const held = quads.u32[at]!;
    if (held === NO_ATLAS_CELL) return;
    releaseCell(held);
    quads.u32[at] = NO_ATLAS_CELL;
    dirtyQuads.add(slot);
    blankCandidates.delete(slot);
    waitingSince.delete(slot);
    unholdPlaceholder(slot);
  };

  // --- placeholders: a cold sprite draws its declared shape, never nothing ----
  //
  // While a sprite's cell has no image, its record draws as a shape filled
  // with the quad's `placeholder` colour at full opacity: the record's kind
  // and style words are swapped, its shape, rect and scale rule kept. The
  // landing swaps them back. Only records waiting on an image are touched.

  const KIND_WORD = 14;
  const STYLE_WORD = 27;
  const placeholderStyle = new Map<string, number>();
  const placeholding = new Map<number, QuadRef>();

  const styleIdOf = (style: QuadStyle): number => {
    const id = styles.intern(style);
    if (styles.size !== knownStyles) {
      knownStyles = styles.size;
      styleRevision += 1;
    }
    return id;
  };

  const holdPlaceholder = (ref: QuadRef): void => {
    const colour = ref.painted.placeholder;
    if (colour === undefined) return;
    const key = JSON.stringify(colour);
    let style = placeholderStyle.get(key);
    if (style === undefined) {
      style = styleIdOf({ fill: { kind: "flat", color: colour } });
      placeholderStyle.set(key, style);
    }
    const at = ref.slot * QUAD_FLOATS;
    placeholding.set(ref.slot, ref);
    // Idempotent: a repaint rewrites the record, so this runs on every hold.
    if (quads.u32[at + KIND_WORD] === KIND_OF.shape && quads.u32[at + STYLE_WORD] === style) return;
    quads.u32[at + KIND_WORD] = KIND_OF.shape;
    quads.u32[at + STYLE_WORD] = style;
    // No style transition into or out of a placeholder: it is the thing itself.
    quads.u32[at + STYLE_WORD + 1] = style;
    dirtyQuads.add(ref.slot);
  };

  function unholdPlaceholder(slot: number): void {
    const ref = placeholding.get(slot);
    if (ref === undefined) return;
    placeholding.delete(slot);
    const at = slot * QUAD_FLOATS;
    const style = styleIdOf(ref.painted.style);
    quads.u32[at + KIND_WORD] = KIND_OF[ref.painted.kind];
    quads.u32[at + STYLE_WORD] = style;
    quads.u32[at + STYLE_WORD + 1] = style;
    dirtyQuads.add(slot);
  }

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

  // --- decoded sources, held per built sprite record ---------------------------

  const sourceOfSlot = new Map<number, Quad>();
  const sourceKey = (quad: Quad): string | undefined => {
    const ref = quad.sprite;
    if (ref === undefined) return undefined;
    return ref.atlas === "image" ? `i|${ref.key}` : ref.atlas === "media" ? `m|${ref.ref}` : undefined;
  };
  /** The record at `slot` now draws `quad`: hold its source, let the old one go. */
  const holdSource = (slot: number, quad: Quad): void => {
    if (options.prepareSource === undefined) return;
    const before = sourceOfSlot.get(slot);
    const next = sourceKey(quad);
    if (before !== undefined && sourceKey(before) === next) return;
    // Take the new one first, so a source both share is never let go between.
    if (next !== undefined) {
      options.prepareSource(quad);
      sourceOfSlot.set(slot, quad);
    } else {
      sourceOfSlot.delete(slot);
    }
    if (before !== undefined) options.releaseSource?.(before);
  };
  const dropSource = (slot: number): void => {
    const before = sourceOfSlot.get(slot);
    if (before === undefined) return;
    sourceOfSlot.delete(slot);
    options.releaseSource?.(before);
  };

  const freeQuad = (slot: number): void => {
    dropSource(slot);
    dropCell(slot);
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
      // The cell the record already holds; `settleQuad` takes or drops one
      // once the record is written, by whether the quad is live.
      source: fresh ? NO_ATLAS_CELL : (quads.u32[at + SOURCE_WORD] ?? NO_ATLAS_CELL),
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

  /** What `prepare` last drew with: the tier mask, the next tier's, a jump's, and the motion gate. */
  let liveMask = 0;
  /** Tiers the zoom could reach before a raster lands, in or out: their cells are taken ahead. */
  let aheadTiers: ReadonlyArray<CanvasTier> = [];
  let jumpMask = 0;
  let jumpTier: CanvasTier | undefined;
  let jumpZoom = 1;
  let liveMotion = true;
  /** Bumped by every draw-list rebuild; a card or badge stamped with it is near the screen. */
  let liveEpoch = 0;

  const gateOpen = (quad: Quad): boolean => quad.gate === undefined || (quad.gate === "live") === liveMotion;

  /**
   * Take or drop a record's cell by what its quad is wanted for. Drawn now:
   * the current tier's scale (inside a gesture the cell in hand is kept, so
   * nothing re-rasterizes mid-gesture; at rest it is made exact). The next
   * tier or a jump's destination: that tier's scale, ahead of time. Wanted for
   * nothing: dropped, so the atlas may reclaim it.
   */
  const settleQuad = (ref: QuadRef, role: Role, gathered: boolean, exact: boolean): void => {
    if (!ref.atlas) return;
    const quad = ref.painted;
    const slot = ref.slot;
    if (gathered || !gateOpen(quad)) {
      dropCell(slot);
      return;
    }
    let scale: number | undefined;
    if (role.view && (quad.tiers & liveMask) !== 0) scale = sourceScaleFor(quad);
    else if (role.view) {
      for (const ahead of aheadTiers) {
        if ((quad.tiers & TIER_BIT[ahead]) === 0) continue;
        scale = scaleAt(quad, ahead, options.zoom?.() ?? 1);
        break;
      }
    }
    if (scale === undefined && role.jump && jumpTier !== undefined && (quad.tiers & jumpMask) !== 0) scale = scaleAt(quad, jumpTier, jumpZoom);
    if (scale === undefined) {
      dropCell(slot);
      return;
    }
    const held = cellOf(slot);
    if (held === NO_ATLAS_CELL || (exact && heldScale[slot] !== scale)) holdCell(ref, scale);
  };

  /** A repainted record whose key or text may have changed: re-ask the atlas, keeping the scale in hand mid-gesture. */
  const refreshQuad = (ref: QuadRef, role: Role, gathered: boolean): void => {
    if (!ref.atlas) {
      dropCell(ref.slot);
      return;
    }
    const held = cellOf(ref.slot);
    settleQuad(ref, role, gathered, options.settled?.() ?? true);
    // Same cell and scale: the quad may still carry new words (a status line);
    // the atlas answers by key, so ask again with the cell in hand.
    if (held !== NO_ATLAS_CELL && cellOf(ref.slot) === held) holdCell(ref, heldScale[ref.slot]!);
  };

  const refOf = (quad: Quad, slot: number): QuadRef => ({
    key: quad.key,
    slot,
    z: quad.z,
    band: BAND_OF[quad.band],
    motion: quad.motion,
    tiers: quad.tiers,
    painted: quad,
    atlas: quad.text !== undefined || quad.sprite !== undefined,
  });

  const bandsOf = (ordered: ReadonlyArray<QuadRef>): Banded => {
    const out: [QuadRef[], QuadRef[], QuadRef[]] = [[], [], []];
    for (const ref of ordered) out[ref.band].push(ref);
    return out;
  };

  const NO_ROLE: Role = { view: false, jump: false };
  const roleOf = (card: CardSlot): Role => (card.stamp === liveEpoch ? card.role : NO_ROLE);

  const paint = (card: CardSlot): void => {
    card.view = viewOf(card.fact);
    card.painted = true;
    card.stale = false;
    paintedCards.add(card);
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
    const midShell = sorted.find((quad) => quad.key === "shell.mid");
    if (midShell !== undefined) card.midBody = midShell.rect;
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
      holdSource(slot, quad);
      dirtyQuads.add(slot);
    }
    quadSlotsOf.set(card.slot, held);
    const previous = card.ordered;
    const ordered = sorted.map((quad) => refOf(quad, card.quads.get(quad.key)!));
    card.ordered = ordered;
    card.bands = bandsOf(ordered);
    card.dim = result.dim;
    card.lift = result.lift;
    writeOwner(card);
    const role = roleOf(card);
    const gathered = gatheredSeats.has(card.id);
    for (const ref of ordered) refreshQuad(ref, role, gathered);
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
    if (orderChanged) {
      // A card the current list holds, with paint order unchanged, splices
      // its own runs; anything else rebuilds.
      if (orderReady && !orderDirty && !paintIndexDirty && card.runsEpoch === liveEpoch) spliceQueue.add(card);
      else markOrder();
    }
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

  /**
   * A fact or view changed. A card near the screen repaints now; any other
   * card only remembers it is stale and paints when it next comes near, so a
   * theme switch, a connect or a report on a big board costs what is on
   * screen, not the board.
   */
  const repaint = (card: CardSlot): void => {
    if (card.stamp === liveEpoch && orderReady) {
      paint(card);
      return;
    }
    // Off screen: nothing draws it, so the draw list stands.
    card.stale = true;
  };

  /** Free a card's quads and cells; its facts, rectangle and owner entry stay. */
  const releaseShapes = (card: CardSlot): void => {
    if (!card.painted) return;
    const held = quadSlotsOf.get(card.slot);
    if (held !== undefined) for (const slot of held) freeQuad(slot);
    quadSlotsOf.delete(card.slot);
    card.quads.clear();
    card.ordered = [];
    card.bands = NO_BANDS;
    card.painted = false;
    card.stale = true;
    paintedCards.delete(card);
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
    // A released badge has no quads; its next plan must paint it again.
    card.signature = "";
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
      holdSource(quadSlot, quad);
      dirtyQuads.add(quadSlot);
    }
    slot.ordered = sorted.map((quad) => refOf(quad, slot.quads.get(quad.key)!));
    const role = slot.stamp === liveEpoch ? VIEW_ROLE : NO_ROLE;
    for (const ref of slot.ordered) refreshQuad(ref, role, false);
  };

  const VIEW_ROLE: Role = { view: true, jump: false };

  /** The badge each gathered seat stands in, from the last plan. */
  let badgeOfSeat = new Map<NodeId, string>();
  /** Badges a member's ring or portrait changed under, repainted at the next frame. */
  const badgeDirty = new Set<string>();

  const keptApart = (live: SeatLive | undefined): boolean => live !== undefined && ringKeepsApart(live.ring.ring);

  /**
   * A seat report. The plan reads a seat's centre, region and whether it
   * stays apart (selected, or a ring that calls); a report that changes none
   * of those regroups nothing. If the seat stands in a badge, the badge reads
   * its ring and portrait, and only that badge repaints.
   */
  const seatChanged = (card: CardSlot, was: SeatLive | undefined, now: SeatLive): void => {
    if (was === undefined || keptApart(was) !== keptApart(now)) {
      clusterDirty = true;
      return;
    }
    const cached = clusterCache?.byId.get(card.id);
    if (cached !== undefined) {
      clusterCache!.byId.set(card.id, {
        ...cached,
        ring: now.ring,
        ringSince: now.ringSince,
        ...(now.portrait === undefined ? {} : { portrait: now.portrait }),
      });
    }
    const badge = badgeOfSeat.get(card.id);
    if (badge !== undefined) badgeDirty.add(badge);
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
      // Where the seat's row puts it, not where a pointer holds it: a drag
      // regroups once, on drop, when the writer's fact lands (issue 915).
      const rect = rectOfFact(card.fact);
      seats.push({
        id: card.id,
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        region: card.fact.derived.regionId ?? "",
        ring: card.live.ring,
        ringSince: card.live.ringSince,
        selected: selected.has(card.id),
        ...(card.live.portrait === undefined ? {} : { portrait: card.live.portrait }),
      });
    }
    seats.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // What the grouping depends on: where a seat is, its region, whether it
    // stays apart (selected, or a ring that calls) and its identity. Not the
    // ring's form itself: a seat going from work to rest regroups nothing.
    const signature = seats
      .map((seat) => `${seat.id}:${String(Math.round(seat.x))},${String(Math.round(seat.y))}:${seat.region}:${keepsApart(seat) ? 1 : 0}`)
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
      clusterPlan = undefined;
      badgeOfSeat = new Map();
      badgeDirty.clear();
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
    if (!dirty && held === clusterHeld) {
      // The plan holds; a member's report repaints only its own badge.
      if (badgeDirty.size > 0) {
        const input = clusterInput(cache, zoom, screen);
        for (const key of badgeDirty) {
          const slot = clusterSlots.get(key);
          const cluster = clusterPlan?.clusters.find((c) => c.key === key);
          if (slot === undefined || cluster === undefined || slot.ordered.length === 0) continue;
          const signature = clusterSignature(cluster, cache.byId);
          if (slot.signature === signature) continue;
          slot.signature = signature;
          paintClusterSlot(slot, cluster, cache.byId, input);
          clusterVersion += 1;
        }
        badgeDirty.clear();
      }
      return clusterVersion;
    }
    badgeDirty.clear();
    clusterHeld = held;
    const plan = clustersFor(cache.index, held);
    clusterPlan = plan;
    const seatsToBadge = new Map<NodeId, string>();
    for (const cluster of plan.clusters) for (const id of cluster.members) seatsToBadge.set(id, cluster.key);
    badgeOfSeat = seatsToBadge;
    const input = clusterInput(cache, zoom, screen);
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
          stamp: -1,
        };
        clusterSlots.set(cluster.key, slot);
        badgeByOwner.set(slot.owner, slot);
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
      clusterVersion += 1;
    }
    // The hovered badge rides above the rest, as the DOM's z says.
    active.sort((a, b) => (a.key === hoveredCluster ? 1 : 0) - (b.key === hoveredCluster ? 1 : 0) || (a.key < b.key ? -1 : 1));
    clustersActive = active;
    gatheredSeats = plan.gathered;
    return clusterVersion;
  };

  /** The plan the badges were laid out from. */
  let clusterPlan: { readonly clusters: ReadonlyArray<SeatCluster> } | undefined;

  const clusterInput = (
    cache: { readonly byId: ReadonlyMap<NodeId, ClusterSeatFact> },
    zoom: number,
    screen: { readonly width: number; readonly height: number },
  ): ClusterInput => ({
    seats: [...cache.byId.values()],
    zoom,
    view: screen,
    mode,
    ...(hoveredCluster === null ? {} : { hoveredKey: hoveredCluster }),
  });

  /** The badge under a board point, if any (the disc; badges paint above cards). */
  const clusterSlotAt = (at: Point): ClusterSlot | undefined => {
    for (let index = clustersActive.length - 1; index >= 0; index -= 1) {
      const slot = clustersActive[index];
      if (slot !== undefined && contains(slot.rect, at)) return slot;
    }
    return undefined;
  };

  const putCard = (fact: CardFact): void => {
    const existing = byId.get(fact.id);
    if (existing !== undefined) {
      const was = existing.fact;
      existing.fact = fact;
      existing.size = undefined;
      if (was.derived.z !== fact.derived.z) paintIndexDirty = true;
      const rect = rectOfFact(fact);
      if (!sameRect(existing.rect, rect)) {
        existing.rect = rect;
        writeOwner(existing);
        grid.set(existing.slot, insetBy(rect, 28));
        markOrder();
      }
      // The grouping reads a seat's centre and region; a card op that moves
      // neither leaves the plan as it is.
      if (fact.row.kind === "agent" && (!sameRect(rectOfFact(was), rect) || was.derived.regionId !== fact.derived.regionId)) clusterDirty = true;
      repaint(existing);
      return;
    }
    if (fact.row.kind === "agent") clusterDirty = true;
    const slot = allocateCard();
    const rect = rectOfFact(fact);
    const card: CardSlot = {
      slot,
      id: fact.id,
      fact,
      live: undefined,
      view: viewOf(fact),
      rect,
      quads: new Map(),
      ordered: [],
      bands: NO_BANDS,
      dim: { opacity: 1, saturate: 1 },
      lift: 0,
      painted: false,
      stale: true,
      stamp: -1,
      role: NO_ROLE,
      paintIndex: 0,
    };
    slots[slot] = card;
    byId.set(fact.id, card);
    master.push(card);
    paintIndexDirty = true;
    // Its place is known now (picking, clusters, the minimap); its quads are
    // built when it first comes near the screen.
    writeOwner(card);
    grid.set(slot, insetBy(rect, 28));
    markOrder();
  };

  const removeCard = (id: NodeId): void => {
    const card = byId.get(id);
    if (card === undefined) return;
    if (card.fact.row.kind === "agent") clusterDirty = true;
    releaseShapes(card);
    byId.delete(id);
    slots[card.slot] = undefined;
    freeSlots.push(card.slot);
    grid.remove(card.slot);
    dirtyOwners.delete(card.slot);
    const at = master.indexOf(card);
    if (at >= 0) master.splice(at, 1);
    paintIndexDirty = true;
    markOrder();
  };

  const clearAll = (): void => {
    // Every held cell goes back to the atlas before the records are forgotten.
    for (const card of byId.values()) releaseShapes(card);
    master.length = 0;
    paintIndexDirty = true;
    blankCandidates.clear();
    waitingSince.clear();
    placeholding.clear();
    // Badges' records go with the board: their sources go back too.
    for (const quad of sourceOfSlot.values()) options.releaseSource?.(quad);
    sourceOfSlot.clear();
    for (const slot of clusterSlots.values()) releaseCluster(slot);
    clusterSlots.clear();
    badgeByOwner.clear();
    paintedCards.clear();
    clustersActive = [];
    gatheredSeats = NO_SEATS;
    clusterPlan = undefined;
    badgeOfSeat = new Map();
    badgeDirty.clear();
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
        const was = card.live;
        card.live = op.live;
        if (card.fact.row.kind === "agent") seatChanged(card, was, op.live);
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
    // A card dragged in from off screen (a group drag) must join the list
    // the moment it reaches the cells around the view.
    if (card.stamp !== liveEpoch && intersects(card.rect, lastRangeRect)) markOrder();
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
   * The visible body a card draws at this tier, in board units, when that body
   * is narrower than the card's own box: the mid tier's name-hugging seat
   * pill. Undefined at every other tier and for cards that draw their whole
   * box, where a wire's end is already on the card. The wire layer attaches to
   * this body so a wire never stops short of the seat the operator can see.
   */
  const surfaceOf = (id: NodeId): Rect | undefined => {
    if (currentTier !== "mid") return undefined;
    const card = byId.get(id);
    const body = card?.midBody;
    if (card === undefined || body === undefined) return undefined;
    return { x: card.rect.x + body.x, y: card.rect.y + body.y, width: body.width, height: body.height };
  };

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
  /** Cards and badges the last rebuild gave a role, so the next can drop what left. */
  let liveCards: CardSlot[] = [];
  let liveBadges: ClusterSlot[] = [];
  let lastRange = "";
  /**
   * Design values for the range's hysteresis: a new range reaches an eighth
   * of its side past the need on each edge, and is kept until it is half as
   * wide again as the need (a zoom in of a third, or a pan of an eighth).
   */
  const RANGE_SLACK = 1 / 8;
  const RANGE_KEEP = 1.5;
  let lastAhead = "";
  let lastRangeRect: Rect = { x: 0, y: 0, width: -1, height: -1 };
  let lastTier: CanvasTier | undefined;
  let lastExactEpoch = "";
  let lastAtlasRevision = -1;
  let lastMotionLive: boolean | undefined;
  /** The badge version the last prepared frame drew. */
  let lastClusters = -1;
  let orderReady = false;
  /** A camera jump's destination: its cards take cells for where the camera lands. */
  let jump: { readonly view: Rect; readonly zoom: number } | undefined;
  let jumpDirty = false;
  /** In-view quads drawn with no image on the last presented frame (zero is the bar). */
  let visibleBlank = 0;
  /** In-view sprites drawing their placeholder on the last presented frame. */
  let visiblePlaceholders = 0;
  /** Cells rasterized in the frame because an in-view quad had no image. */
  let ensuredNow = 0;

  // --- the margin and the tier window, measured -------------------------------
  //
  // The margin is how far the camera actually travelled, in screen pixels,
  // while a raster was on its way: each landing is a sample of what that
  // resolve needed. The tier window is the same in octaves of zoom. The
  // camera's travel is an odometer (pans and pinches, never cuts), and a
  // record that takes a cell notes it; when the image lands, the difference
  // is the need. Neither is a chosen number: before anything has landed in
  // motion both are zero, and the frame's own blank check (ensureNow) covers
  // the first reveal.
  //
  // They decay: the margin is the largest need among the last landings, as
  // many as the frame draws quads, one screen's worth of evidence. A slow
  // raster or a fast fling is forgotten once a screen's worth of landings
  // has shown it no longer happens. And they are bounded by reality: the
  // window by the camera's zoom range, the margin by the board.

  /** The camera's whole zoom range, in octaves: no window can reach past it. */
  const ZOOM_RANGE_OCTAVES = Math.log2(CAMERA_MAX_ZOOM / CAMERA_MIN_ZOOM);
  const measured = (value: unknown, max: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max ? value : 0;
  /** Screen pixels and octaves the camera has travelled this session. */
  let travelPx = 0;
  let travelOctaves = 0;
  let lastMotion: { readonly cx: number; readonly cy: number; readonly zoom: number; readonly width: number; readonly height: number } | undefined;
  type Wait = { readonly at: number; readonly px: number; readonly octaves: number };
  /** When, and at what travel, each record without an image took its cell. */
  const waitingSince = new Map<number, Wait>();
  const waitFrom = (at: number): Wait => ({ at, px: travelPx, octaves: travelOctaves });
  /** The needs of recent landings, oldest first, from `needStart`. */
  const needPx: number[] = [];
  const needOctaves: number[] = [];
  const needLatency: number[] = [];
  let needStart = 0;
  let needsDirty = true;
  let marginPx = 0;
  let windowOctaves = 0;
  let latencyMs = 0;
  const addNeed = (px: number, octaves: number, latency: number): void => {
    needPx.push(px);
    needOctaves.push(octaves);
    needLatency.push(latency);
    needsDirty = true;
  };
  // The last session's measure stands as one landing until this one's replace it.
  {
    const kept = options.peaks as Partial<Record<keyof MotionPeaks, unknown>> | undefined;
    const px = measured(kept?.marginPx, Number.MAX_VALUE);
    const octaves = measured(kept?.octaves, ZOOM_RANGE_OCTAVES);
    const latency = measured(kept?.latencyMs, Number.MAX_VALUE);
    if (px > 0 || octaves > 0 || latency > 0) addNeed(px, octaves, latency);
  }

  /** Landings the window holds: as many as the last frame drew quads. */
  let needKeep = 1;
  /** Recompute the window's maxima over the last `needKeep` landings, when they changed. */
  const refreshNeeds = (): void => {
    const keep = needKeep;
    const count = needPx.length - needStart;
    if (count > keep) {
      needStart += count - keep;
      needsDirty = true;
    }
    if (!needsDirty) return;
    needsDirty = false;
    if (needStart > 1024 && needStart * 2 > needPx.length) {
      needPx.splice(0, needStart);
      needOctaves.splice(0, needStart);
      needLatency.splice(0, needStart);
      needStart = 0;
    }
    marginPx = 0;
    windowOctaves = 0;
    latencyMs = 0;
    for (let index = needStart; index < needPx.length; index += 1) {
      if (needPx[index]! > marginPx) marginPx = needPx[index]!;
      if (needOctaves[index]! > windowOctaves) windowOctaves = needOctaves[index]!;
      if (needLatency[index]! > latencyMs) latencyMs = needLatency[index]!;
    }
    windowOctaves = Math.min(windowOctaves, ZOOM_RANGE_OCTAVES);
  };

  const nowMs = (): number => options.now?.() ?? (typeof performance === "undefined" ? Date.now() : performance.now());

  /** Add this frame's camera travel to the odometers. */
  const observeCamera = (view: Rect, zoom: number): void => {
    const cx = view.x + view.width / 2;
    const cy = view.y + view.height / 2;
    const was = lastMotion;
    lastMotion = { cx, cy, zoom, width: view.width, height: view.height };
    if (was === undefined) return;
    const dx = Math.abs(cx - was.cx);
    const dy = Math.abs(cy - was.cy);
    // More than a whole view in one frame is a cut, not a pan: no margin
    // could have held it, and the jump prefetch is what serves it.
    if (dx > Math.max(view.width, was.width) || dy > Math.max(view.height, was.height)) return;
    travelPx += Math.hypot(dx, dy) * zoom;
    if (zoom > 0 && was.zoom > 0) {
      // The same cut in zoom terms: the view more than doubling (or halving)
      // in one frame reveals more than a whole view.
      const octaves = Math.abs(Math.log2(zoom / was.zoom));
      if (octaves <= 1) travelOctaves += octaves;
    }
  };

  /** Screen pixels around the view a card is built and holds cells in. */
  const marginScreenPx = (): number => {
    refreshNeeds();
    return marginPx;
  };
  /** The margin in board units at `zoom`, never past the board itself. */
  const marginAt = (zoom: number): number => {
    const extent = grid.extent();
    const board = extent === undefined ? 0 : Math.max(extent.width, extent.height);
    return Math.min(marginScreenPx() / zoom, board);
  };
  /** Octaves either side of the zoom whose tiers take cells ahead. */
  const tierWindowOctaves = (): number => {
    refreshNeeds();
    return windowOctaves;
  };

  const ensurePaintIndex = (): void => {
    if (!paintIndexDirty) return;
    master.sort((a, b) => {
      if (a.fact.derived.z !== b.fact.derived.z) return a.fact.derived.z - b.fact.derived.z;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    for (let index = 0; index < master.length; index += 1) master[index]!.paintIndex = index;
    paintIndexDirty = false;
  };

  const byPaintIndex = (a: CardSlot, b: CardSlot): number => a.paintIndex - b.paintIndex;

  const orderCards = (found: ReadonlyArray<number>): CardSlot[] => {
    ensurePaintIndex();
    const cards: CardSlot[] = [];
    for (const slot of found) {
      const card = slots[slot];
      if (card !== undefined) cards.push(card);
    }
    cards.sort(byPaintIndex);
    return cards;
  };

  /**
   * The range the order list covers for this view (issue 915). A range is
   * kept while it holds the view and its margin and is no more than
   * RANGE_KEEP of their side: a pan or zoom at far crossed a cell edge almost
   * every frame, and each crossing rebuilt the list. A new range takes
   * RANGE_SLACK of the side on each edge before snapping to cells, so the
   * next rebuild waits for that much travel.
   */
  const rangeFor = (view: Rect, zoom: number): { readonly key: string; readonly rect: Rect } => {
    const need = insetBy(view, marginAt(zoom));
    const kept = lastRangeRect;
    if (
      lastRange !== "" &&
      kept.x <= need.x &&
      kept.y <= need.y &&
      kept.x + kept.width >= need.x + need.width &&
      kept.y + kept.height >= need.y + need.height &&
      kept.width <= need.width * RANGE_KEEP + 2 * CARD_CELL &&
      kept.height <= need.height * RANGE_KEEP + 2 * CARD_CELL
    ) {
      return { key: lastRange, rect: kept };
    }
    const dx = need.width * RANGE_SLACK;
    const dy = need.height * RANGE_SLACK;
    return cellRange({ x: need.x - dx, y: need.y - dy, width: need.width + 2 * dx, height: need.height + 2 * dy });
  };

  /** The grid cells a rectangle covers, as the rectangle of their union. */
  const cellRange = (rect: Rect): { readonly key: string; readonly rect: Rect } => {
    const left = Math.floor(rect.x / CARD_CELL);
    const top = Math.floor(rect.y / CARD_CELL);
    const right = Math.floor((rect.x + rect.width) / CARD_CELL);
    const bottom = Math.floor((rect.y + rect.height) / CARD_CELL);
    return {
      key: `${String(left)},${String(top)},${String(right)},${String(bottom)}`,
      rect: { x: left * CARD_CELL, y: top * CARD_CELL, width: (right - left + 1) * CARD_CELL - 1, height: (bottom - top + 1) * CARD_CELL - 1 },
    };
  };

  /** The tiers a zoom within the measured window of this one would draw, other than `tier`. */
  const tiersAhead = (zoom: number, tier: CanvasTier): CanvasTier[] => {
    const out: CanvasTier[] = [];
    const window = tierWindowOctaves();
    if (!(window > 0)) return out;
    const step = 2 ** window;
    for (const probe of [zoom * step, zoom / step]) {
      const next = tierForZoom(probe);
      if (next !== tier && !out.includes(next)) out.push(next);
    }
    return out;
  };

  /** Hand the scene a camera jump's destination ahead of the camera, or clear it. */
  const prefetch = (target: { readonly view: Rect; readonly zoom: number } | null): void => {
    const next = target ?? undefined;
    if (next === undefined && jump === undefined) return;
    if (next !== undefined && jump !== undefined && sameRect(next.view, jump.view) && next.zoom === jump.zoom) return;
    jump = next;
    jumpDirty = true;
  };

  /** Settle every live record's cell: exact at rest, the cell in hand inside a gesture. */
  const settleLive = (exact: boolean, reask: boolean, fresh?: ReadonlySet<CardSlot>): void => {
    for (const card of liveCards) {
      // A card painted in this rebuild took its cells as it painted.
      if (fresh?.has(card)) continue;
      const gathered = gatheredSeats.has(card.id);
      for (const ref of card.ordered) {
        settleQuad(ref, card.role, gathered, exact);
        if (reask && ref.atlas && cellOf(ref.slot) !== NO_ATLAS_CELL) holdCell(ref, heldScale[ref.slot]!);
        else if (reask && ref.atlas && card.role.view && (ref.tiers & liveMask) !== 0 && gateOpen(ref.painted) && !gathered) holdCell(ref, sourceScaleFor(ref.painted));
      }
    }
    for (const badge of liveBadges) {
      for (const ref of badge.ordered) {
        settleQuad(ref, VIEW_ROLE, false, exact);
        if (reask && ref.atlas && cellOf(ref.slot) !== NO_ATLAS_CELL) holdCell(ref, heldScale[ref.slot]!);
      }
    }
  };

  /**
   * Rebuild what is near the screen: which cards are built and hold cells,
   * and the draw list. Runs when the grid cells around the view change, the
   * tier or motion gate changes, a card or badge changed what it draws, or a
   * jump's destination arrives.
   */
  /** Write a card's draw-list run for one band at `at`; returns the end. */
  const writeRun = (card: CardSlot, band: number, mask: number, at: number, moved: Array<{ readonly ref: QuadRef; readonly owner: number }>): number => {
    for (const ref of card.bands[band]!) {
      if ((ref.tiers & mask) === 0) continue;
      // Motion's gate: a ring's rest pose draws only while motion is off,
      // its moving parts only while it runs (contract, `Quad.gate`).
      if (!gateOpen(ref.painted)) continue;
      order[at] = ref.slot;
      at += 1;
      if (ref.motion !== undefined && (ref.tiers & liveMask) !== 0) moved.push({ ref, owner: card.slot });
    }
    return at;
  };

  /**
   * One card's runs, rewritten in place (issue 915): its new quads go where its
   * old run was, the tail moves by the difference, and every later run's
   * start with it. No query, no sort, no other card touched.
   */
  const spliceCard = (card: CardSlot): void => {
    const runs = card.runs!;
    const mask = cullOnGpu ? ALL_TIERS : liveMask;
    const gathered = gatheredSeats.has(card.id);
    const moved: Array<{ readonly ref: QuadRef; readonly owner: number }> = [];
    for (let band = 0; band < BAND_COUNT; band += 1) {
      const start = runs[band * 2]!;
      const length = runs[band * 2 + 1]!;
      let fresh = 0;
      if (!gathered) for (const ref of card.bands[band]!) if ((ref.tiers & mask) !== 0 && gateOpen(ref.painted)) fresh += 1;
      const delta = fresh - length;
      if (delta !== 0) {
        if (orderCount + delta > order.length) {
          let capacity = order.length;
          while (capacity < orderCount + delta) capacity *= 2;
          const grown = new Uint32Array(capacity);
          grown.set(order.subarray(0, orderCount));
          order = grown;
        }
        order.copyWithin(start + fresh, start + length, orderCount);
        orderCount += delta;
        bandEnds = [
          bandEnds[0] + (band <= 0 ? delta : 0),
          bandEnds[1] + (band <= 1 ? delta : 0),
          bandEnds[2] + delta,
        ];
        // Later runs move: later cards in this band, every card in later bands.
        for (const other of visibleCards) {
          if (other === card || other.runsEpoch !== liveEpoch) continue;
          const theirs = other.runs!;
          if (other.paintIndex > card.paintIndex) theirs[band * 2] = theirs[band * 2]! + delta;
          for (let later = band + 1; later < BAND_COUNT; later += 1) theirs[later * 2] = theirs[later * 2]! + delta;
        }
        for (let later = band + 1; later < BAND_COUNT; later += 1) runs[later * 2] = runs[later * 2]! + delta;
      }
      if (!gathered) writeRun(card, band, mask, start, moved);
      runs[band * 2 + 1] = fresh;
    }
    movers = movers.filter((mover) => mover.owner !== card.slot).concat(moved);
  };

  const rebuild = (view: Rect, tier: CanvasTier, zoom: number, exact: boolean): void => {
    rebuildCount += 1;
    liveEpoch += 1;
    spliceQueue.clear();
    ensurePaintIndex();
    const range = rangeFor(view, zoom);
    lastRange = range.key;
    lastRangeRect = range.rect;
    visibleSlots.length = 0;
    grid.query(range.rect, visibleSlots);
    visibleCards.length = 0;
    for (const slot of visibleSlots) {
      const card = slots[slot];
      if (card === undefined) continue;
      card.stamp = liveEpoch;
      card.role = VIEW_ROLE;
      visibleCards.push(card);
    }
    visibleCards.sort(byPaintIndex);
    const jumpCards: CardSlot[] = [];
    if (jump !== undefined) {
      const found: number[] = [];
      grid.query(insetBy(jump.view, marginAt(jump.zoom)), found);
      for (const slot of found) {
        const card = slots[slot];
        if (card === undefined) continue;
        if (card.stamp === liveEpoch) {
          card.role = { view: true, jump: true };
          continue;
        }
        card.stamp = liveEpoch;
        card.role = { view: false, jump: true };
        jumpCards.push(card);
      }
    }
    // Build what came near; a stale card repaints with its role in force, so
    // its cells are taken in the same pass.
    const fresh = new Set<CardSlot>();
    for (const card of visibleCards) {
      if (card.painted && !card.stale) continue;
      paint(card);
      fresh.add(card);
    }
    for (const card of jumpCards) {
      if (card.painted && !card.stale) continue;
      paint(card);
      fresh.add(card);
    }
    // What left the view drops its cells; what left the keep ring (a screen
    // beyond the view on every side) lets go of its quads too.
    const keep = insetBy(view, Math.max(view.width, view.height));
    for (const card of liveCards) {
      if (card.stamp === liveEpoch) continue;
      for (const ref of card.ordered) if (ref.atlas) dropCell(ref.slot);
    }
    for (const card of paintedCards) {
      if (card.stamp === liveEpoch || intersects(card.rect, keep)) continue;
      releaseShapes(card);
    }
    liveCards = jumpCards.length === 0 ? visibleCards.slice() : [...visibleCards, ...jumpCards];

    // Badges near the screen draw and hold cells; the rest only answer the pointer.
    const badges: ClusterSlot[] = [];
    for (const badge of clustersActive) {
      if (!intersects(badge.rect, range.rect)) continue;
      badge.stamp = liveEpoch;
      badges.push(badge);
    }
    for (const badge of liveBadges) {
      if (badge.stamp === liveEpoch) continue;
      for (const ref of badge.ordered) if (ref.atlas) dropCell(ref.slot);
    }
    liveBadges = badges;
    settleLive(exact, false, fresh);

    // The draw list: the current tier's quads with their gate open, bands in
    // order, cards in paint index, badges over every card.
    let needed = 0;
    for (const card of visibleCards) if (!gatheredSeats.has(card.id)) needed += card.ordered.length;
    for (const badge of badges) needed += badge.ordered.length;
    ensureOrderCapacity(needed);
    // With the cull on the GPU, every tier's quads are candidates: the
    // compute pass filters by tier and view per quad, each frame.
    const mask = cullOnGpu ? ALL_TIERS : liveMask;
    const counts = [0, 0, 0];
    let at = 0;
    const moved: Array<{ readonly ref: QuadRef; readonly owner: number }> = [];
    for (const card of visibleCards) {
      card.runs ??= [0, 0, 0, 0, 0, 0];
      card.runsEpoch = liveEpoch;
    }
    for (let band = 0; band < BAND_COUNT; band += 1) {
      for (const card of visibleCards) {
        const start = at;
        // A gathered seat draws nothing: its badge stands for it.
        if (!gatheredSeats.has(card.id)) at = writeRun(card, band, mask, at, moved);
        card.runs![band * 2] = start;
        card.runs![band * 2 + 1] = at - start;
        counts[band] = counts[band]! + (at - start);
      }
      // Badges paint in the lifted band, over every card (DOM z 3000).
      if (band === 2) {
        for (const badge of badges) {
          for (const ref of badge.ordered) {
            if ((ref.tiers & mask) === 0) continue;
            order[at] = ref.slot;
            at += 1;
            counts[2] = counts[2]! + 1;
            if (ref.motion !== undefined && (ref.tiers & liveMask) !== 0) moved.push({ ref, owner: badge.owner });
          }
        }
      }
    }
    bandEnds = [counts[0]!, counts[0]! + counts[1]!, counts[0]! + counts[1]! + counts[2]!];
    orderCount = bandEnds[2];
    movers = moved;
  };

  /**
   * Whether anything that moves is on screen this frame, and until when a
   * one-shot there runs. Each quad is widened by the vertex stage's largest
   * turn, growth and shift, so a part moving into view counts.
   */
  const refreshMotion = (view: Rect): void => {
    let periodic = false;
    let until = 0;
    moverRects.length = 0;
    for (const { ref, owner } of movers) {
      const motion = ref.motion!;
      const oneShot = motion.kind === "land" || motion.kind === "landed" || motion.kind === "rise";
      let end = 0;
      if (oneShot) {
        // `since` is a wall instant; the loop's clock is the page's.
        end = clockNow + (motion.since + ONE_SHOT_MS[motion.kind] - wallNow);
        // Ended before the last test: at rest and already drawn so.
        if (end <= motionTestedAt) continue;
      }
      // Turned, grown and shifted at most this far from its centre.
      const rect = placedRect(ref, owner);
      const half = Math.hypot(rect.width, rect.height) * 0.5 * MOTION_GROWTH + MOTION_SHIFT;
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const reach = { x: cx - half, y: cy - half, width: half * 2, height: half * 2 };
      if (!intersects(reach, view)) continue;
      moverRects.push(reach);
      if (!oneShot) periodic = true;
      else if (end > clockNow) until = Math.max(until, end);
    }
    motionTestedAt = clockNow;
    motionVisible = periodic;
    oneShotUntil = until;
  };

  /**
   * The last line of the guarantee: an in-view quad whose cell has no image
   * is rasterized now, before the frame is submitted, and counted if it still
   * has none. It reads the record's own cell word, the one the renderer draws
   * from, against the actual view, every presented frame. Only records that
   * had no image when last looked at are checked, so a steady frame costs a
   * walk over an empty set.
   */
  /** A record's cell got its image: the wait is a raster latency sample. */
  const landed = (slot: number, at: number): void => {
    blankCandidates.delete(slot);
    unholdPlaceholder(slot);
    const since = waitingSince.get(slot);
    waitingSince.delete(slot);
    if (since !== undefined) addNeed(travelPx - since.px, travelOctaves - since.octaves, at - since.at);
  };

  const checkBlank = (view: Rect, at: number): void => {
    let blank = 0;
    let held = 0;
    for (const [slot, ref] of blankCandidates) {
      const cell = cellOf(slot);
      if (cell === NO_ATLAS_CELL && options.acquire !== undefined) {
        blankCandidates.delete(slot);
        waitingSince.delete(slot);
        continue;
      }
      if (cell !== NO_ATLAS_CELL && hasImage(cell)) {
        landed(slot, at);
        continue;
      }
      if (!drawnInView(slot, ref, view)) continue;
      if (cell === NO_ATLAS_CELL) {
        // The older lookup answers a raster once it lands: ask again.
        holdCell(ref, sourceScaleFor(ref.painted));
        if (!blankCandidates.has(slot)) continue;
      } else if (options.ensureNow !== undefined) {
        options.ensureNow(cell);
        ensuredNow += 1;
        if (hasImage(cell)) {
          // Rasterized in the frame: not a latency the margin should carry.
          blankCandidates.delete(slot);
          waitingSince.delete(slot);
          unholdPlaceholder(slot);
          continue;
        }
      }
      // A cold sprite with a placeholder draws its shape: not empty, but counted.
      if (placeholding.has(slot)) {
        held += 1;
        continue;
      }
      blank += 1;
    }
    visibleBlank = blank;
    visiblePlaceholders = held;
  };

  /** The view the last prepare checked, for `seatStats`. */
  let seatCheckView: Rect | undefined;

  /** A quad this tier draws, and whether its image is in. */
  const liveRef = (ref: QuadRef): boolean => (ref.tiers & liveMask) !== 0 && gateOpen(ref.painted);
  const imageIn = (ref: QuadRef): boolean => {
    const cell = cellOf(ref.slot);
    return cell !== NO_ATLAS_CELL && hasImage(cell);
  };

  /**
   * What the operator can reach and see of the seats in view, on the last
   * prepared frame (issue 912, rulings 3 and 6). `visibleBlank` counts quads
   * waiting on an image; these count what that misses. A seat is unshown
   * when neither its own quads nor a drawn badge stand for it: nothing picks
   * it. A portrait is missing when the seat's (or its badge's) portrait quad
   * is not drawn at all, and waiting when it is drawn with no image yet (a
   * placeholder stands in). Read on demand: a frame pays nothing for it.
   */
  const seatStats = (): {
    readonly inView: number;
    readonly unshown: number;
    readonly portraitsMissing: number;
    readonly portraitsWaiting: number;
    readonly badgesInView: number;
    readonly unshownIds: ReadonlyArray<NodeId>;
  } => {
    const view = seatCheckView;
    let inView = 0;
    let portraitsMissing = 0;
    let portraitsWaiting = 0;
    const unshownIds: NodeId[] = [];
    const badges = new Set<ClusterSlot>();
    if (view !== undefined) {
      for (const card of byId.values()) {
        if (card.fact.row.kind !== "agent" || card.live === undefined || !intersects(card.rect, view)) continue;
        inView += 1;
        if (gatheredSeats.has(card.id)) {
          const key = badgeOfSeat.get(card.id);
          const badge = key === undefined ? undefined : clusterSlots.get(key);
          if (badge === undefined || badge.stamp !== liveEpoch || !clustersActive.includes(badge) || !badge.ordered.some(liveRef)) unshownIds.push(card.id);
          else badges.add(badge);
          continue;
        }
        const drawn = card.stamp === liveEpoch && card.role.view ? card.ordered.filter(liveRef) : [];
        if (drawn.length === 0) {
          unshownIds.push(card.id);
          continue;
        }
        const portrait = drawn.find((ref) => ref.key.endsWith("portrait"));
        if (portrait === undefined) portraitsMissing += 1;
        else if (portrait.atlas && !imageIn(portrait)) portraitsWaiting += 1;
      }
      for (const badge of badges) {
        const portrait = badge.ordered.find((ref) => liveRef(ref) && ref.key.endsWith("portrait"));
        if (portrait === undefined) portraitsMissing += 1;
        else if (portrait.atlas && !imageIn(portrait)) portraitsWaiting += 1;
      }
    }
    return { inView, unshown: unshownIds.length, portraitsMissing, portraitsWaiting, badgesInView: badges.size, unshownIds };
  };

  /** The record is in the draw list and its owner meets the view. */
  const drawnInView = (slot: number, ref: QuadRef, view: Rect): boolean => {
    if ((ref.tiers & liveMask) === 0 || !gateOpen(ref.painted)) return false;
    const owner = quads.u32[slot * QUAD_FLOATS + 15]!;
    const card = slots[owner];
    if (card !== undefined) {
      if (card.stamp !== liveEpoch || !card.role.view || gatheredSeats.has(card.id)) return false;
      return intersects(card.rect, view);
    }
    const badge = badgeByOwner.get(owner);
    return badge !== undefined && badge.stamp === liveEpoch && intersects(badge.rect, view);
  };

  const prepare = (view: Rect, tier: CanvasTier): Prepared => {
    currentTier = tier;
    const motionOn = options.motionLive?.() ?? true;
    const zoom = options.zoom?.() ?? 1;
    const exact = options.settled?.() ?? true;
    // Region watermarks are a style on the region's name quads, not a raster:
    // they step with the zoom. A step waits for the camera's rest, so the
    // text is never re-rasterized inside a gesture (section 8 rule 2).
    const glance = options.glance?.(zoom);
    if (glance !== undefined && (glance.region !== glanceNow.region || glance.sub !== glanceNow.sub)) {
      if (exact) {
        glanceNow = { region: glance.region, sub: glance.sub };
        for (const card of byId.values()) {
          if (card.fact.row.kind === "region") repaint(card);
        }
      }
    }
    // Grouping comes before the order: a badge that appeared, parted or
    // repainted rewrites the visible list's tail.
    const clusters = refreshClusters(view, tier);
    liveMask = TIER_BIT[tier];
    liveMotion = motionOn;
    const frameAt = nowMs();
    observeCamera(view, zoom);
    needKeep = Math.max(1, orderCount);
    aheadTiers = tiersAhead(zoom, tier);
    if (jump !== undefined) {
      jumpTier = tierForZoom(jump.zoom);
      jumpMask = TIER_BIT[jumpTier];
      jumpZoom = jump.zoom;
    } else {
      jumpTier = undefined;
      jumpMask = 0;
    }
    const range = rangeFor(view, zoom).key;
    const rebuilt =
      !orderReady ||
      orderDirty ||
      jumpDirty ||
      tier !== lastTier ||
      motionOn !== lastMotionLive ||
      clusters !== lastClusters ||
      range !== lastRange ||
      aheadTiers.join() !== lastAhead;
    // A raster scale is right for one camera bucket, one tier and one zoom
    // (the scale rules read the zoom). Inside a gesture the cell in hand is
    // kept (section 8 rule 2); at rest every live record is made exact.
    const exactEpoch = `${String(atlasScaleNow())}|${String(zoom)}|${tier}`;
    const settle = exact && exactEpoch !== lastExactEpoch;
    // The older lookup answers a landed raster only when asked again; under
    // references a landing never touches a record.
    const revision = atlasRevisionNow();
    const reask = options.acquire === undefined && lastAtlasRevision >= 0 && revision !== lastAtlasRevision && exact;
    if (rebuilt) {
      rebuild(view, tier, zoom, exact);
      orderDirty = false;
      jumpDirty = false;
      lastTier = tier;
      lastMotionLive = motionOn;
      lastClusters = clusters;
      lastAhead = aheadTiers.join();
      orderReady = true;
    }
    let spliced = false;
    if (!rebuilt && spliceQueue.size > 0) {
      for (const card of spliceQueue) {
        if (card.runsEpoch !== liveEpoch) continue;
        spliceCard(card);
        spliceCount += 1;
      }
      spliceQueue.clear();
      spliced = true;
    }
    if ((settle && !rebuilt) || reask) settleLive(exact, reask);
    if (exact) {
      lastExactEpoch = exactEpoch;
      lastAtlasRevision = revision;
    }
    checkBlank(view, frameAt);
    seatCheckView = view;
    refreshMotion(view);

    let changed = false;
    if (rebuilt || spliced) {
      changed = orderCount !== previousOrder.length;
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
    }
    return { orderChanged: changed, visible: orderCount, atlasRevision: revision };
  };

  // --- drawn parts, for the proof's part-level ink check (test hook only) ----

  /** A quad's board rectangle as the shader places it this frame, motion aside (renderer.ts vs). */
  const placedRect = (ref: QuadRef, owner: number): Rect => {
    const quad = ref.painted;
    const at = owner * 8;
    const ox = owners[at]!;
    const oy = owners[at + 1]!;
    const boxW = owners[at + 5]!;
    const boxH = owners[at + 6]!;
    const centreDx = owners[at + 7]!;
    const zoom = options.zoom?.() ?? 1;
    const tier = currentTier;
    const farOrOverview = tier === "far" || tier === "overview";
    const { rect } = quad;
    const relCentre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    const sized = (scale: number, cx: number, cy: number): Rect => ({
      x: cx - (rect.width * scale) / 2,
      y: cy - (rect.height * scale) / 2,
      width: rect.width * scale,
      height: rect.height * scale,
    });
    const boxCentre = { x: boxW * 0.5 + centreDx, y: boxH * 0.5 };
    const rule = quad.scale;
    switch (rule.kind) {
      case "board":
        return { x: ox + rect.x, y: oy + rect.y, width: rect.width, height: rect.height };
      case "seat": {
        const scale = scaleMultiplier(quad, tier, zoom);
        const base = farOrOverview ? boxCentre : rule.anchor;
        return sized(scale, ox + base.x + (relCentre.x - rule.anchor.x) * scale, oy + base.y + (relCentre.y - rule.anchor.y) * scale);
      }
      case "node": {
        const scale = nodeScale(zoom);
        return sized(scale, ox + rule.anchor.x + (relCentre.x - rule.anchor.x) * scale, oy + rule.anchor.y + (relCentre.y - rule.anchor.y) * scale);
      }
      case "hover": {
        const scale = hoverCardScale(zoom);
        const base = tier === "far" ? boxCentre : rule.anchor;
        return sized(scale, ox + base.x + (relCentre.x - rule.anchor.x) * scale, oy + base.y + (relCentre.y - rule.anchor.y) * scale);
      }
      case "seatTag": {
        const far = Math.max(1, Math.min(farSeatScale(zoom), rule.cap));
        const seatScale = tier === "far" ? far : tier === "overview" ? Math.max(seatFloorScale(zoom), Math.min(farSeatScale(zoom), rule.cap)) : 1;
        const base = farOrOverview ? boxCentre : rule.anchor;
        const topX = base.x + (relCentre.x - rule.anchor.x) * seatScale;
        const topY = base.y + (rect.y - rule.anchor.y) * seatScale;
        const scale = farSeatScale(zoom) * 1.4;
        return sized(scale, ox + topX, oy + topY + (rect.height * scale) / 2);
      }
    }
  };

  const partOf = (ref: QuadRef, owner: number, drawnOwner: boolean): DrawnPart => {
    const quad = ref.painted;
    const held = cellOf(ref.slot);
    const ink = quad.style.ink;
    return {
      key: ref.key,
      kind: quad.kind,
      band: quad.band,
      tiers: ref.tiers,
      drawn: drawnOwner && (ref.tiers & liveMask) !== 0 && gateOpen(quad),
      rect: placedRect(ref, owner),
      ...(held === NO_ATLAS_CELL ? {} : { cell: held }),
      ...(ref.atlas ? { hasImage: held !== NO_ATLAS_CELL && hasImage(held) } : {}),
      ...(ink !== undefined && "token" in ink ? { ink: ink.token } : {}),
    };
  };

  const partsOf = (id: NodeId): DrawnPart[] => {
    const card = byId.get(id);
    if (card === undefined) return [];
    const drawn = card.stamp === liveEpoch && card.role.view && !gatheredSeats.has(id);
    return card.ordered.map((ref) => partOf(ref, card.slot, drawn));
  };

  const badgePartsOf = (key: string): DrawnPart[] => {
    const badge = clusterSlots.get(key);
    if (badge === undefined) return [];
    const drawn = badge.stamp === liveEpoch && clustersActive.includes(badge);
    return badge.ordered.map((ref) => partOf(ref, badge.owner, drawn));
  };

  const clusters = (): DrawnCluster[] =>
    clustersActive.map((badge) => ({
      key: badge.key,
      x: badge.rect.x + badge.rect.width / 2,
      y: badge.rect.y + badge.rect.height / 2,
      radius: badge.rect.width / 2,
      memberIds: badge.members,
      drawn: badge.stamp === liveEpoch,
    }));

  const hasMotion = (at: number = clockNow): boolean => motionVisible || at < transitionUntil || at < oneShotUntil;

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
    /** The card the pointer is over, for the hover bloom's pick and rect. */
    hoveredId: (): NodeId | null => hovered,
    setConnectTarget,
    setDragging,
    moveCard,
    restoreCard,
    resizeCard,
    query,
    rectOf,
    cardOf,
    surfaceOf,
    ringAngle,
    /** The members of the badge under a board point, if any (the pointer's cluster hit). */
    clusterAt: (at: Point) => clusterSlotAt(at)?.members,
    prepare,
    prefetch,
    partsOf,
    seatStats,
    badgePartsOf,
    clusters,
    /** Build the draw list for a GPU cull (every tier) or the CPU one (the current tier only). */
    setCullOnGpu: (on: boolean): void => {
      if (on === cullOnGpu) return;
      cullOnGpu = on;
      markOrder();
    },
    /** The peaks measured so far, to keep for the next session. */
    motionPeaks: (): MotionPeaks => {
      refreshNeeds();
      return { marginPx, octaves: windowOctaves, latencyMs };
    },
    /** In-view quads with no image on the last presented frame, and cells rasterized in the frame to prevent one. */
    blankStats: (): {
      readonly visibleBlank: number;
      readonly placeholders: number;
      readonly ensuredNow: number;
      readonly marginScreenPx: number;
      readonly tierWindowOctaves: number;
      /** The slowest raster among the landings the window holds. */
      readonly latencyMs: number;
      /** Landings the window holds: one screen's worth. */
      readonly needSamples: number;
    } => ({
      visibleBlank,
      placeholders: visiblePlaceholders,
      ensuredNow,
      marginScreenPx: marginScreenPx(),
      tierWindowOctaves: tierWindowOctaves(),
      latencyMs: (refreshNeeds(), latencyMs),
      needSamples: needPx.length - needStart,
    }),
    hasMotion,
    /** How the draw list changed so far: whole rebuilds, and one card's runs spliced. */
    orderStats: (): { readonly rebuilds: number; readonly splices: number } => ({ rebuilds: rebuildCount, splices: spliceCount }),
    /**
     * What a frame driven by motion alone must redraw: the board rectangles
     * the in-view movers can reach, or undefined while a style transition
     * runs (it can change any quad).
     */
    motionDamage: (at: number = clockNow): ReadonlyArray<Rect> | undefined => (at < transitionUntil ? undefined : moverRects),
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
    /** Bumps when every style row was rewritten (a theme); otherwise rows only append. */
    get styleThemeEpoch(): number {
      return styles.themeEpoch;
    },
    get shadowCount(): number {
      return styles.shadows.length;
    },
    shadowSnapshot: (): { readonly meta: Uint32Array; readonly layers: Float32Array } => {
      const meta = new Uint32Array(styles.shadows.length * 4);
      const layers: number[] = [];
      styles.shadows.forEach((spec: ShadowSpec, index) => {
        meta[index * 4] = spec.layers.length;
        // The shader indexes vec4s; a layer is two of them.
        meta[index * 4 + 1] = layers.length / 4;
        // Bit i: layer i is inset. The shader reads at most 32 layers.
        let inset = 0;
        spec.layers.forEach((layer, at) => {
          if (layer.inset === true && at < 32) inset |= 1 << at;
        });
        meta[index * 4 + 2] = inset >>> 0;
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
