/**
 * The wire scene (architecture section 13), on the CPU: every wire's route as
 * a strip in a pool, one small record per wire, and what changes them. No GPU
 * object is touched here, so a test drives it with a table of card rectangles
 * and a frozen clock.
 *
 * A wire's route comes from the loom's fact while the wire's ends still sit
 * where the plan put them; otherwise it is the fallback elbow between the
 * cards' live rectangles (a card is being dragged, or the model has not yet
 * taken a move). The scene reads rectangles each frame and rebuilds only the
 * wires whose ends moved. A mode, a selection or a hover rewrites records, not
 * strips. A pulse rewrites two numbers in one record a frame.
 *
 * The motion law: nothing here slows, steps or throttles. Phases are functions
 * of the wall clock; transitions ease on the theme's own curves; `frame`
 * reports `busy` for as long as anything visible moves.
 */

import { wireSides } from "@shared/wire-sides";
import type { WireDirection } from "@shared/wire-route";
import { themeRuntime, type ThemeMode } from "@shared/theme";
import type { Camera, CanvasTier, NodeId, Point, Rect, SceneOp, SelectionFact, WireFact, WireId, WireMode, WireRouteFact } from "../../contract";
import {
  buildStrip,
  buildTrackStrip,
  cubicBezier,
  glowHalfWidth,
  handleEnd,
  isTrackVerb,
  lineBounds,
  pickWire,
  pointAt,
  pulseHold,
  pulseSpan,
  pulseToken,
  routeOfElbow,
  trackFits,
  trackLayout,
  trackPhase,
  tokenRgba,
  viewOfMode,
  wireLine,
  wirePaint,
  tierHide,
  tierScale,
  WIRE_HALF_WIDTH,
  WIRE_TRANSITIONS,
  FULL_OPACITY,
  HIT_WIDTH,
  PULSE_HOLD_OPACITY,
  PULSE_HOLD_WIDTH,
  PULSE_HALF_WIDTH,
  ROUTE_RADIUS,
  SPINE_RADIUS,
  WIRE_PULSE_MAX_ACTIVE,
  WIRE_PULSE_MS,
  STRAND_HIT_WIDTH,
  STRIP_FLOATS,
  WIRE_UNSET_TOKEN,
  OUTSIDE_CONE_OPACITY,
  type GlowPass,
  type PickCandidate,
  type Rgba,
  type TrackRun,
  type WireLine,
  type WireLook,
  type WirePaint,
  type WireRoute,
  type WireStrip,
  type WireView,
} from "../../paint/wires";
import { createStripPool, RESTART, type Slice, type StripPool } from "./pool";
import { createDirty, createRangeAllocator, type Dirty, type RangeAllocator } from "./ranges";

/** Floats in one wire's record: five `vec4f`. */
export const RECORD_FLOATS = 20;
export const RECORD_BYTES = RECORD_FLOATS * 4;

/**
 * The record, as the shader reads it:
 *   0..3    colour, straight alpha
 *   4       hairline opacity now (eased)
 *   5       centreline length
 *   6       track kind: 0 none, 1 flows, 2 derives
 *   7       track alpha now
 *   8, 9    pulse span along the wire, from and to (to <= from: none)
 *   10      pulse half width
 *   11      reserved
 *   12..15  pulse colour, alpha folded in
 *   16..19  glow passes: sigma, alpha, sigma, alpha (alpha eased)
 */
const R = { colour: 0, opacity: 4, length: 5, track: 6, trackAlpha: 7, pulseFrom: 8, pulseTo: 9, pulseHalf: 10, pulseColour: 12, glow: 16 } as const;

/** The connection preview lives in the pool under this id, in the first record. */
export const PREVIEW_ID = "\u0000preview";
const PREVIEW_SLOT = 0;
/** Samples along the preview's curve. */
const PREVIEW_STEPS = 48;
/** React Flow's `getBezierPath` curvature. */
const BEZIER_CURVATURE = 0.25;

type Tween = { from: number; to: number; since: number; ms: number };

const tweenAt = (tween: Tween, now: number, ease: (x: number) => number): number => {
  if (tween.ms <= 0 || now >= tween.since + tween.ms) return tween.to;
  if (now <= tween.since) return tween.from;
  return tween.from + (tween.to - tween.from) * ease((now - tween.since) / tween.ms);
};

const tweenDone = (tween: Tween, now: number): boolean => tween.ms <= 0 || now >= tween.since + tween.ms;

const easeOf = {
  opacity: cubicBezier(WIRE_TRANSITIONS.opacity.easing),
  glow: cubicBezier(WIRE_TRANSITIONS.glow.easing),
};

type Entry = {
  readonly id: WireId;
  readonly slot: number;
  fact: WireFact;
  /**
   * The live rectangles the route was built against, as eight numbers, then
   * the visible body each end attaches to as eight more (NaN when a card is
   * missing or has no body of its own at this tier).
   */
  ends: ReadonlyArray<number>;
  route: WireRoute | undefined;
  line: WireLine | undefined;
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | undefined;
  /** Where the wire's invisible select label sits, in board units. */
  label: Point | undefined;
  /** The label as `labelsInView` hands it out, kept while its point and verb hold. */
  labelView: WireLabel | undefined;
  strip: Slice | undefined;
  /** The card-body strip and the mid pill strip: a tier swap takes one, never rebuilds. */
  stripBody: Slice | undefined;
  stripPill: Slice | undefined;
  glowStrip: Slice | undefined;
  glowKey: string;
  layout: ReadonlyArray<TrackRun>;
  /** The runs a tier was laid at; a crossing swaps them instead of parsing the path again. */
  layoutByTier: Partial<Record<CanvasTier, ReadonlyArray<TrackRun>>>;
  trackStrip: Slice | undefined;
  /** The layout and fits its track strip was built from; a rebuild that changes neither keeps the strip. */
  trackLayoutAt: ReadonlyArray<TrackRun> | undefined;
  fits: ReadonlyArray<number>;
  paint: WirePaint;
  look: WireLook;
  opacity: Tween;
  trackAlpha: Tween;
  glowAlpha: Tween;
  /** The passes the glow strip was built for, kept while it fades out. */
  glowPasses: ReadonlyArray<GlowPass>;
  colour: Rgba;
  /** A transition is running or ended since the record was last written. */
  settling: boolean;
  pulse: { readonly startedAt: number; readonly kind: "notice" | "prompt" | "answer"; readonly reverse: boolean } | undefined;
  /** The fold this member is hidden inside, when its seat is gathered. */
  folded: string | undefined;
  /** A fold entry: the real wires it draws for, and the member whose verb and direction it follows. */
  fold: { readonly key: string; readonly members: ReadonlySet<WireId>; lead: WireId } | undefined;
};

export type WireHost = {
  /** A card's live board rectangle, dragged or not; undefined when it is not on the board. */
  readonly rectOf: (id: NodeId) => Rect | undefined;
  /**
   * The filled body a card actually draws at this tier, when it is smaller
   * than its card (the mid tier's name-hugging seat pill). A wire attaches to
   * that visible edge, never to the card's invisible one. Undefined when the
   * card draws its whole box or has no body.
   */
  readonly surfaceOf?: (id: NodeId) => Rect | undefined;
  /** The badge a seat is gathered into at far and overview, with its disc in board units. */
  readonly gatheredInto?: (id: NodeId) => { readonly key: string; readonly rect: Rect } | undefined;
  /** Seats whose `gatheredInto` answer changed since the last call; drained once a frame. */
  readonly gatheringChanged?: () => ReadonlyArray<NodeId>;
  readonly mode?: ThemeMode;
  /** Reduced motion: tracks hold still, pulses hold the wire, nothing eases. */
  readonly reducedMotion?: () => boolean;
  /**
   * The loom routes every wire (issue 912): a wire draws only once its route
   * fact has landed. Until then it is not drawn and takes no pointer, so no
   * wire is first seen as an elbow and then changes shape by itself; when its
   * fact lands it fades in, as a map tile does. Off for a host with no loom.
   */
  readonly awaitRoutes?: boolean;
};

export type WireFrame = {
  readonly camera: Camera;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly tier: CanvasTier;
  /** Epoch milliseconds: the wall clock every phase reads. */
  readonly wall: number;
  /** Cards whose live rectangle a pointer owns this frame: a drag or a resize. */
  readonly live?: ReadonlySet<NodeId>;
};

/** The numbers the shader reads once a frame, as plain floats (see `shader.ts`). */
export type WireUniforms = {
  readonly camera: readonly [x: number, y: number, zoom: number, pixelRatio: number];
  readonly view: readonly [width: number, height: number, pulseHalf: number, hairHalf: number];
  readonly track: readonly [period: number, flowsOffset: number, derivesOffset: number, derivesOpacity: number];
  readonly tier: readonly [opacityScale: number, overviewHide: number];
};

export type WireScene = {
  readonly apply: (op: SceneOp) => void;
  /** Hover from the pointer: the wire under it, or none. */
  readonly setHover: (id: WireId | undefined) => void;
  /** Once per drawn frame, before `uniforms` and the buffers are read. Returns whether anything visible still moves. */
  readonly frame: (frame: WireFrame) => boolean;
  /** Without advancing: does anything visible move at `wall`. */
  readonly busy: (wall: number) => boolean;
  readonly uniforms: () => WireUniforms;
  /** The wire a board point picks, in paint order, when the view lets wires be picked. */
  readonly pick: (at: Point) => WireId | undefined;
  /** Where a wire's invisible label sits: its midpoint, for the select button and the harness. */
  readonly labelOf: (id: WireId) => Point | undefined;
  /** The labels of the wires the camera can see: what the shell's select buttons follow. */
  readonly labelsInView: () => ReadonlyArray<WireLabel>;
  /** The last label whose 14 px button covers the point, in board units. */
  readonly labelAt: (at: Point, half: number) => WireId | undefined;
  /** Bumped whenever a label point can have moved (a route rebuilt, a wire added or removed). */
  readonly labelsRevision: () => number;
  /** A wire's centreline length and route kind, for tests and the harness. */
  readonly inspect: (id: WireId) => WireInspect | undefined;
  /** Every member of the fold a wire is hidden in, or undefined when it draws itself. */
  readonly foldOf: (id: WireId) => ReadonlyArray<WireId> | undefined;
  /** The folds now drawn, for unit and end-to-end checks. */
  readonly folds: () => ReadonlyArray<WireFoldInspect>;
  /** How many wires have had their strip rebuilt since the scene was made (a measurement). */
  readonly builds: () => number;
  /** How many wires the scene holds, strips or not. */
  readonly wires: () => number;
  /** How many wires have a fact: a wire with none draws nothing. */
  readonly withFact: () => number;
  /** The last tier-crossing repaint, ms. */
  readonly refreshMs: () => number;
  /** The last motion step, ms. */
  readonly stepMs: () => number;
  /** The last labelsInView rebuild, ms. */
  readonly labelsMs: () => number;
  /** Wire ids in load order, for a measurement that pulses them. */
  readonly wireIds: () => ReadonlyArray<WireId>;
  /** Start a pulse on the first `count` in-view wires (a measurement). */
  readonly pulseFirst: (count: number, at: number) => number;
  /** Every strip pool's CPU bytes (vertices and indices). */
  readonly poolBytes: () => number;
  /** Wires the loom has not answered yet, all and those whose ends' box meets the view (a measurement). */
  readonly waiting: () => { readonly total: number; readonly inView: number };
  /** The visible strips' index data, rebuilt when the camera or a strip changes. */
  readonly visibleIndices: () => WireVisibleIndex;
  readonly pool: StripPool;
  readonly glowPool: StripPool;
  readonly trackPool: StripPool;
  /** Record floats, with the span written since the last upload. */
  readonly records: () => Float32Array;
  readonly dirtyRecords: Dirty;
  /** Pulses to draw this frame: their strip's first vertex and count. */
  readonly pulses: () => ReadonlyArray<{ readonly start: number; readonly count: number }>;
  readonly recordsGeneration: () => number;
  /** The tier the tracks were laid for. */
  readonly size: () => number;
};

/** The index data of the wires the camera can see, per pool: what the frame draws. */
export type WireVisibleIndex = {
  readonly main: Uint32Array;
  readonly mainCount: number;
  readonly glow: Uint32Array;
  readonly glowCount: number;
  readonly tracks: Uint32Array;
  readonly tracksCount: number;
  readonly revision: number;
};

export type WireLabel = {
  readonly id: WireId;
  readonly at: Point;
  readonly verb: WireFact["row"]["verb"];
};

export type WireInspect = {
  readonly kind: WireRoute["kind"];
  readonly length: number;
  readonly points: ReadonlyArray<Point>;
  readonly opacity: number;
  readonly pickable: boolean;
};

/** One fold as a test or harness reads it: its lead, members and centreline. */
export type WireFoldInspect = {
  readonly key: string;
  readonly lead: WireId;
  readonly members: ReadonlyArray<WireId>;
  readonly points: ReadonlyArray<Point>;
};

const PULSE_KIND_DEFAULT = "notice" as const;

export const createWireScene = (host: WireHost): WireScene => {
  let mode: ThemeMode = host.mode ?? "dark";
  let wireMode: WireMode = "rest";
  let selection: SelectionFact | undefined;
  let hover: WireId | undefined;
  let preview: { from: Point; fromSide: WireDirection; to: Point } | null = null;
  let tier: CanvasTier = "near";
  let zoom = 1;
  let pixelRatio = 1;
  let camera: Camera = { x: 0, y: 0, zoom: 1 };
  let viewSize = { width: 0, height: 0 };
  let wall = 0;
  let coneWires: ReadonlySet<WireId> | undefined;

  const entries = new Map<WireId, Entry>();
  /** Fold entries by their synthetic id (`\0fold:` + key), separate from the real wires they hide. */
  const foldEntries = new Map<WireId, Entry>();
  const facts = new Map<WireId, WireRouteFact>();
  /** Wires by the card each end names, so a moved card rebuilds only its own wires. */
  const byCard = new Map<NodeId, Set<WireId>>();
  /** The fold each real wire is a member of, by the fold's unordered key. */
  const foldOfWire = new Map<WireId, string>();
  type Fold = { readonly key: string; readonly members: Set<WireId>; inside: boolean; entry: Entry | undefined };
  const folds = new Map<string, Fold>();
  /** Wires whose fold key may have changed; resolved before the dirty folds are rebuilt. */
  const foldWiresDirty = new Set<WireId>();
  /** Folds whose membership, lead or end rectangles may have changed. */
  const foldsDirty = new Set<string>();
  /** Wires whose ends may have changed since the last frame (a card or wire op). */
  const dirty = new Set<WireId>();
  /** Wires with a running tween or pulse: the only ones a frame has to write. */
  const running = new Set<WireId>();
  /** Wires with track runs: the only ones track motion or a fit rebuild reads. */
  const tracked = new Set<WireId>();
  let labelsRevision = 0;
  const pool = createStripPool(1024);
  const glowPool = createStripPool(256);
  const trackPool = createStripPool(256);
  let previewStrip: Slice | undefined;
  let previewLine: WireLine | undefined;

  // Records: slot 0 is the preview's; wires take the rest.
  let records = new Float32Array(64 * RECORD_FLOATS);
  let recordsGeneration = 0;
  const dirtyRecords = createDirty();
  const slots: RangeAllocator = createRangeAllocator(64);
  slots.alloc(1);

  let tracksDirty = false;
  let pickList: Array<PickCandidate<WireId>> | undefined;
  // The pick list in a grid: a pointer reads the wires it could touch, not
  // every pickable wire on the board. Built on the first pick after a change.
  let pickGrid: Map<number, Array<{ candidate: PickCandidate<WireId>; order: number }>> | undefined;
  let pickWide: Array<{ candidate: PickCandidate<WireId>; order: number }> = [];
  // The visible draw: only the strips the camera can see, in one index list
  // per pool, so a freed or off-screen strip costs no vertex work.
  let visibleDirty = true;
  let visibleRevision = 0;
  let mainIndex: Uint32Array = new Uint32Array(4096);
  let mainCount = 0;
  let glowIndex: Uint32Array = new Uint32Array(2048);
  let glowCount = 0;
  let trackIndex: Uint32Array = new Uint32Array(1024);
  let trackCount = 0;
  /** The labels of the last camera, rebuilt only when the camera or a label moved. */
  // The labels in view, kept in one list refilled in place when the camera,
  // the view or a label moves: a pan frame allocates no label.
  const labelsAt = { x: Number.NaN, y: Number.NaN, zoom: Number.NaN };
  const labelsCache: WireLabel[] = [];
  let labelsCacheRevision = -1;
  /** A strip or a wire came or went: `buildVisible` sorts its pool order again. */
  let stripOrderDirty = true;
  const labelsCacheView = { width: 0, height: 0 };
  let pulseDraws: Array<{ start: number; count: number }> = [];
  let activePulses = 0;

  const reduced = (): boolean => host.reducedMotion?.() ?? false;
  const ms = (kind: "opacity" | "glow"): number => (reduced() ? 0 : WIRE_TRANSITIONS[kind].ms);

  const entryOf = (id: WireId): Entry | undefined => entries.get(id) ?? foldEntries.get(id);
  const forEachEntry = (fn: (entry: Entry) => void): void => {
    entries.forEach(fn);
    foldEntries.forEach(fn);
  };

  type EndShape = { readonly token: string; readonly rect: Rect | undefined; readonly gathered: boolean };
  /** The end a fold draws: a gathered seat's badge disc, else the card's drawn body. */
  const endShape = (id: NodeId): EndShape => {
    const gathered = host.gatheredInto?.(id);
    if (gathered !== undefined) return { token: `\u0001${gathered.key}`, rect: gathered.rect, gathered: true };
    return { token: id, rect: host.surfaceOf?.(id) ?? host.rectOf(id), gathered: false };
  };

  /** A wire's unordered fold key; undefined when neither end is gathered. */
  const foldShape = (entry: Entry): { readonly key: string; readonly inside: boolean } | undefined => {
    const from = endShape(entry.fact.row.from);
    const to = endShape(entry.fact.row.to);
    if (!from.gathered && !to.gathered) return undefined;
    const ends = [from.token, to.token].sort();
    return { key: `${ends[0]}\u0002${ends[1]}`, inside: from.token === to.token };
  };

  const foldEntryId = (key: string): WireId => `\0fold:${key}`;

  const ensureRecords = (slot: number): void => {
    if ((slot + 1) * RECORD_FLOATS <= records.length) return;
    let next = records.length / RECORD_FLOATS;
    while (next <= slot) next *= 2;
    const grown = new Float32Array(next * RECORD_FLOATS);
    grown.set(records);
    records = grown;
    slots.grow(next);
    recordsGeneration += 1;
    dirtyRecords.markAll(records.length);
  };

  const takeSlot = (): number => {
    let slot = slots.alloc(1);
    if (slot === undefined) {
      slots.grow(slots.capacity() * 2);
      slot = slots.alloc(1) ?? 0;
    }
    ensureRecords(slot);
    return slot;
  };

  // --- view ---------------------------------------------------------------

  const focusOn = (): boolean => wireMode === "cone" || selection?.focusMode !== undefined;

  const view = (): WireView => {
    const base = viewOfMode(wireMode, tier);
    return { ...base, tier, focus: focusOn(), connecting: base.connecting || preview !== null };
  };

  const coneSet = (): ReadonlySet<WireId> | undefined => {
    if (coneWires !== undefined) return coneWires;
    const focus = selection?.focusMode;
    if (focus === undefined) return undefined;
    if (focus.wireIds !== undefined) {
      coneWires = new Set(focus.wireIds);
      return coneWires;
    }
    const members = new Set<NodeId>([focus.rootId, ...focus.memberIds]);
    const set = new Set<WireId>();
    for (const entry of entries.values()) {
      const { from, to } = entry.fact.row;
      if (members.has(from) && members.has(to)) set.add(entry.id);
    }
    coneWires = set;
    return coneWires;
  };

  /** A wire the loom has not answered yet: drawn as nothing until it does. */
  const waiting = (entry: Entry): boolean => entry.fold === undefined && host.awaitRoutes === true && !facts.has(entry.id);
  /** A waiting wire's paint: nothing drawn, nothing picked. */
  const unseen = (paint: WirePaint): WirePaint => {
    const { track: _track, ...rest } = paint;
    return { ...rest, opacity: 0, glow: [], pickable: false, pulseOpacity: 0 };
  };

  const lookOf = (entry: Entry): WireLook => {
    if (entry.fold !== undefined) {
      let selected = false;
      let hovered = false;
      let inCone = false;
      const cone = coneSet();
      for (const member of entry.fold.members) {
        selected = selected || selection?.wireId === member;
        hovered = hovered || hover === member;
        inCone = inCone || (cone?.has(member) ?? false);
      }
      return { verb: entry.fact.row.verb, selected, hovered, inCone };
    }
    return {
      verb: entry.fact.row.verb,
      selected: selection?.wireId === entry.id,
      hovered: hover === entry.id,
      inCone: coneSet()?.has(entry.id) ?? false,
    };
  };

  // --- records --------------------------------------------------------------

  const writeRecord = (entry: Entry, now: number): void => {
    const o = entry.slot * RECORD_FLOATS;
    const r = records;
    const track = entry.paint.track !== undefined ? (entry.fact.row.verb === "derives" ? 2 : 1) : 0;
    r[o + R.colour] = entry.colour[0];
    r[o + R.colour + 1] = entry.colour[1];
    r[o + R.colour + 2] = entry.colour[2];
    r[o + R.colour + 3] = entry.colour[3];
    r[o + R.opacity] = tweenAt(entry.opacity, now, easeOf.opacity);
    r[o + R.length] = entry.line?.length ?? 0;
    r[o + R.track] = track;
    r[o + R.trackAlpha] = tweenAt(entry.trackAlpha, now, easeOf.opacity);
    const glow = tweenAt(entry.glowAlpha, now, easeOf.glow);
    const a = entry.glowPasses[0];
    const b = entry.glowPasses[1];
    r[o + R.glow] = a?.sigma ?? 0;
    r[o + R.glow + 1] = (a?.alpha ?? 0) * glow;
    r[o + R.glow + 2] = b?.sigma ?? 0;
    r[o + R.glow + 3] = (b?.alpha ?? 0) * glow;
    dirtyRecords.mark(o, o + RECORD_FLOATS);
  };

  const writePulse = (entry: Entry, from: number, to: number, half: number, colour: Rgba, alpha: number): void => {
    const o = entry.slot * RECORD_FLOATS;
    records[o + R.pulseFrom] = from;
    records[o + R.pulseTo] = to;
    records[o + R.pulseHalf] = half;
    records[o + R.pulseColour] = colour[0];
    records[o + R.pulseColour + 1] = colour[1];
    records[o + R.pulseColour + 2] = colour[2];
    records[o + R.pulseColour + 3] = alpha;
    dirtyRecords.mark(o + R.pulseFrom, o + R.pulseColour + 4);
  };

  const clearPulse = (entry: Entry): void => {
    entry.pulse = undefined;
    writePulse(entry, 0, 0, 0, [0, 0, 0, 0], 0);
  };

  // --- glow -----------------------------------------------------------------

  const syncGlowStrip = (entry: Entry): void => {
    const line = entry.line;
    const passes = entry.glowPasses;
    if (line === undefined || passes.length === 0) {
      if (entry.glowStrip !== undefined) {
        glowPool.free(entry.glowStrip);
        entry.glowStrip = undefined;
        entry.glowKey = "";
      }
      return;
    }
    const key = `${passes.map((p) => p.sigma).join(",")}|${line.length}|${line.count}|${line.x[0]}|${line.y[0]}|${line.x[line.count - 1]}|${line.y[line.count - 1]}`;
    if (key === entry.glowKey && entry.glowStrip !== undefined) return;
    const strip = buildStrip(line, glowHalfWidth(passes), { slot: entry.slot });
    entry.glowStrip = strip.count > 0 ? glowPool.put(entry.glowStrip, strip.vertices, strip.count) : undefined;
    entry.glowKey = key;
  };

  // --- paint ----------------------------------------------------------------

  /** Take the wire's paint for the current view, starting a transition where a value changed. */
  const refreshPaint = (entry: Entry, now: number): void => {
    const view$ = view();
    const look = lookOf(entry);
    const drawn = wirePaint(view$, look);
    const paint = waiting(entry) ? unseen(drawn) : drawn;
    entry.look = look;
    entry.paint = paint;
    const shownNow = tweenAt(entry.opacity, now, easeOf.opacity);
    if (paint.opacity !== entry.opacity.to) {
      entry.opacity = { from: shownNow, to: paint.opacity, since: now, ms: ms("opacity") };
    }
    const trackTarget = paint.track === undefined ? 0 : view$.focus && !look.inCone ? OUTSIDE_CONE_OPACITY : 1;
    if (trackTarget !== entry.trackAlpha.to) {
      entry.trackAlpha = { from: tweenAt(entry.trackAlpha, now, easeOf.opacity), to: trackTarget, since: now, ms: ms("opacity") };
    }
    const glowTarget = paint.glow.length > 0 ? 1 : 0;
    if (paint.glow.length > 0) entry.glowPasses = paint.glow;
    if (glowTarget !== entry.glowAlpha.to) {
      entry.glowAlpha = { from: tweenAt(entry.glowAlpha, now, easeOf.glow), to: glowTarget, since: now, ms: ms("glow") };
    }
    entry.settling = true;
    running.add(entry.id);
    syncGlowStrip(entry);
    pickList = undefined;
    pickGrid = undefined;
    writeRecord(entry, now);
  };

  let refreshMs = 0;
  const refreshAll = (now: number): void => {
    const started = performance.now();
    forEachEntry((entry) => refreshPaint(entry, now));
    refreshMs = performance.now() - started;
  };

  // --- routes ---------------------------------------------------------------

  const NAN_ENDS: Entry["ends"] = [NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN];
  const rectNums = (rect: Rect | undefined): ReadonlyArray<number> =>
    rect === undefined ? [NaN, NaN, NaN, NaN] : [rect.x, rect.y, rect.width, rect.height];

  const readEnds = (
    entry: Entry,
  ): {
    ends: Entry["ends"];
    from: Rect | undefined;
    to: Rect | undefined;
    fromSurface: Rect | undefined;
    toSurface: Rect | undefined;
  } => {
    const from = host.rectOf(entry.fact.row.from);
    const to = host.rectOf(entry.fact.row.to);
    const fromSurface = host.surfaceOf?.(entry.fact.row.from);
    const toSurface = host.surfaceOf?.(entry.fact.row.to);
    if (from === undefined || to === undefined) return { ends: NAN_ENDS, from, to, fromSurface, toSurface };
    return {
      ends: [
        from.x, from.y, from.width, from.height, to.x, to.y, to.width, to.height,
        ...rectNums(fromSurface), ...rectNums(toSurface),
      ],
      from,
      to,
      fromSurface,
      toSurface,
    };
  };

  const anchorOn = (rect: Rect, side: WireDirection): Point => {
    switch (side) {
      case "left":
        return { x: rect.x, y: rect.y + rect.height / 2 };
      case "right":
        return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
      case "top":
        return { x: rect.x + rect.width / 2, y: rect.y };
      case "bottom":
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
    }
  };

  /** The plan holds while both anchors, lanes included, sit where the live cards put them. */
  const planHolds = (fact: WireRouteFact, from: Rect, to: Rect): boolean => {
    const live = wireSides(from, to);
    if (live.source !== fact.sourceSide || live.target !== fact.targetSide) return false;
    const s = anchorOn(from, fact.sourceSide);
    const t = anchorOn(to, fact.targetSide);
    return (
      s.x + fact.lane.source.x === fact.source.x &&
      s.y + fact.lane.source.y === fact.source.y &&
      t.x + fact.lane.target.x === fact.target.x &&
      t.y + fact.lane.target.y === fact.target.y
    );
  };

  /**
   * Where a card's drawn body meets a side, on the axis the side's normal runs.
   */
  const faceOf = (surface: Rect, side: WireDirection): number => {
    switch (side) {
      case "left":
        return surface.x;
      case "right":
        return surface.x + surface.width;
      case "top":
        return surface.y;
      case "bottom":
        return surface.y + surface.height;
    }
  };

  /**
   * One end of a route, taken out to the body its card actually draws: the
   * mid tier's pill, narrower than the card's box. The body's face is added
   * at the end, the route's own anchor kept. For a planned route or an elbow
   * the three points are collinear on the side's normal, so the wire simply
   * starts (or stops) on the pill instead of short of it; for a cable strand,
   * whose first leg can run across, the face becomes the short lead out of the
   * pill and the strand's own handle point follows. A side the body does not
   * inset (the pill's left, top and bottom faces are the card's) is untouched.
   */
  const attachEnd = (points: ReadonlyArray<Point>, role: "source" | "target", side: WireDirection, surface: Rect | undefined): ReadonlyArray<Point> => {
    if (surface === undefined || points.length < 2) return points;
    const at = role === "source" ? 0 : points.length - 1;
    const point = points[at];
    if (point === undefined) return points;
    const face = faceOf(surface, side);
    const horizontal = side === "left" || side === "right";
    const anchor = horizontal ? point.x : point.y;
    // Already on or inside the face (or a body that does not inset this side).
    const outside = side === "right" || side === "bottom" ? anchor > face : anchor < face;
    if (!outside) return points;
    const lead: Point = horizontal ? { x: face, y: point.y } : { x: point.x, y: face };
    return role === "source" ? [lead, ...points] : [...points, lead];
  };

  const attach = (
    points: ReadonlyArray<Point>,
    sourceSide: WireDirection,
    targetSide: WireDirection,
    fromSurface: Rect | undefined,
    toSurface: Rect | undefined,
  ): ReadonlyArray<Point> => {
    if (fromSurface === undefined && toSurface === undefined) return points;
    const withSource = attachEnd(points, "source", sourceSide, fromSurface);
    return attachEnd(withSource, "target", targetSide, toSurface);
  };

  const routeFor = (entry: Entry, from: Rect, to: Rect, fromSurface: Rect | undefined, toSurface: Rect | undefined): WireRoute => {
    const fact = facts.get(entry.id);
    const holds = fact !== undefined && planHolds(fact, from, to);
    if (holds && fact.points !== undefined && fact.points.length >= 2) {
      const cable = fact.cable;
      return {
        kind: cable ? "strand" : "route",
        points: attach(fact.points, fact.sourceSide, fact.targetSide, fromSurface, toSurface),
        radius: cable ? SPINE_RADIUS : ROUTE_RADIUS,
        rounding: "orthogonal",
        label: { x: 0, y: 0 },
        hitHalfWidth: (cable ? STRAND_HIT_WIDTH : HIT_WIDTH) / 2,
      };
    }
    const sides = holds ? { source: fact.sourceSide, target: fact.targetSide } : wireSides(from, to);
    const elbow = routeOfElbow(
      {
        source: handleEnd(from, sides.source, "source"),
        sourceSide: sides.source,
        target: handleEnd(to, sides.target, "target"),
        targetSide: sides.target,
      },
      holds ? fact.lane : undefined,
    );
    return { ...elbow, points: attach(elbow.points, sides.source, sides.target, fromSurface, toSurface) };
  };

  let builds = 0;
  /** Wires a tier flip marks: only their new tier changes, other tiers stay kept. */
  const tierOnly = new Set<WireId>();
  // Wires a tier crossing left unbuilt because they were off screen: they are
  // rebuilt only when the view reaches them, a scan at a time.
  const tierStale = new Set<WireId>();
  let tierStaleList: WireId[] = [];
  let tierStaleAt = 0;
  let staleCamera = { x: NaN, y: NaN, zoom: NaN };
  const rebuild = (entry: Entry, now: number): void => {
    builds += 1;
    const keepOtherTiers = tierOnly.delete(entry.id);
    visibleDirty = true;
    const { ends, from, to, fromSurface, toSurface } = readEnds(entry);
    entry.ends = ends;
    if (from === undefined || to === undefined) {
      pool.free(entry.stripBody);
      pool.free(entry.stripPill);
      entry.stripBody = undefined;
      entry.stripPill = undefined;
      tierOnly.delete(entry.id);
      entry.strip = undefined;
      stripOrderDirty = true;
      entry.route = undefined;
      entry.line = undefined;
      entry.bounds = undefined;
      entry.label = undefined;
      syncGlowStrip(entry);
      if (entry.layout.length > 0) {
        entry.layout = [];
        entry.layoutByTier = {};
        tracksDirty = true;
      }
      writeRecord(entry, now);
      pickList = undefined;
      pickGrid = undefined;
      if (entry.folded !== undefined) foldsDirty.add(entry.folded);
      return;
    }
    const route = routeFor(entry, from, to, fromSurface, toSurface);
    const line = wireLine(route);
    entry.route = route;
    entry.line = line;
    entry.bounds = lineBounds(line);
    // An elbow's label is React Flow's, on its longest run; a route's is its midpoint.
    entry.label = route.kind === "elbow" ? route.label : pointAt(line, line.length / 2);
    labelsRevision += 1;
    // The previous strip is handed back to the pool, never dropped: a wire
    // whose route changes must not leave its slice behind, and a zero-length
    // route frees it rather than orphaning it.
    const strip: WireStrip = buildStrip(line, WIRE_HALF_WIDTH, { slot: entry.slot });
    const pill = tier === "mid";
    if (keepOtherTiers) {
      pool.free(pill ? entry.stripPill : entry.stripBody);
      if (pill) entry.stripPill = undefined;
      else entry.stripBody = undefined;
    } else {
      pool.free(entry.stripBody);
      pool.free(entry.stripPill);
      entry.stripBody = undefined;
      entry.stripPill = undefined;
    }
    if (strip.count > 0) {
      const slice = pool.put(undefined, strip.vertices, strip.count);
      entry.strip = slice;
      stripOrderDirty = true;
      if (pill) entry.stripPill = slice;
      else entry.stripBody = slice;
    } else {
      entry.strip = undefined;
      stripOrderDirty = true;
    }
    if (isTrackVerb(entry.fact.row.verb)) {
      entry.layoutByTier = {};
      entry.layout = trackLayout(route, tier);
      entry.layoutByTier[tier] = entry.layout;
      if (entry.layout.length > 0) tracked.add(entry.id);
      else tracked.delete(entry.id);
      tracksDirty = true;
    } else if (entry.layout.length > 0) {
      // A Rewire to a plain verb leaves no track behind.
      entry.layout = [];
      entry.layoutByTier = {};
      tracked.delete(entry.id);
      tracksDirty = true;
    }
    syncGlowStrip(entry);
    writeRecord(entry, now);
    pickList = undefined;
    pickGrid = undefined;
    if (entry.folded !== undefined) foldsDirty.add(entry.folded);
  };

  const rebuildTracks = (): void => {
    visibleDirty = true;
    const layouts: Record<string, ReadonlyArray<TrackRun>> = {};
    forEachEntry((entry) => {
      if (entry.layout.length > 0) layouts[entry.id] = entry.layout;
    });
    const fits = trackFits(layouts, tier);
    forEachEntry((entry) => {
      const runs = entry.layout;
      if (runs.length === 0 || !isTrackVerb(entry.fact.row.verb)) {
        trackPool.free(entry.trackStrip);
        entry.trackStrip = undefined;
        entry.trackLayoutAt = undefined;
        entry.fits = [];
        return;
      }
      const fit = fits[entry.id] ?? [];
      // A rebuild that changes nothing near this track leaves its strip where
      // it is: only a changed layout or fit re-puts vertices.
      if (entry.trackStrip !== undefined && entry.trackLayoutAt === runs && entry.fits.length === fit.length && entry.fits.every((v, i) => v === fit[i])) return;
      const strip = buildTrackStrip(runs, tier, { fits: fit, slot: entry.slot });
      entry.trackStrip = strip.count > 0 ? trackPool.put(entry.trackStrip, strip.vertices, strip.count) : undefined;
      entry.trackLayoutAt = runs;
      entry.fits = fit;
    });
    tracksDirty = false;
  };

  const relayoutTracks = (): void => {
    forEachEntry((entry) => {
      if (!isTrackVerb(entry.fact.row.verb) || entry.route === undefined) return;
      // The runs at a tier are the same every time the camera comes back to
      // it: parse the route once per tier, not once per crossing.
      const cached = entry.layoutByTier[tier];
      entry.layout = cached ?? trackLayout(entry.route, tier);
      entry.layoutByTier[tier] = entry.layout;
      if (entry.layout.length > 0) tracked.add(entry.id);
      else tracked.delete(entry.id);
    });
    tracksDirty = true;
  };

  // --- wires ------------------------------------------------------------------

  const colourOf = (verb: WireFact["row"]["verb"] | undefined): Rgba => tokenRgba(paintToken(verb), mode);
  const paintToken = (verb: WireFact["row"]["verb"] | undefined): string => wirePaint(view(), { verb, selected: false, hovered: false, inCone: false }).token;

  // --- folds ---------------------------------------------------------------

  const removeFoldMember = (entry: Entry): void => {
    const key = foldOfWire.get(entry.id);
    if (key === undefined) return;
    foldOfWire.delete(entry.id);
    const fold = folds.get(key);
    if (fold !== undefined) {
      fold.members.delete(entry.id);
      foldsDirty.add(key);
    }
  };

  /**
   * Put a wire in the fold its gathered ends name, or take it back out. Member
   * strips are kept whole while hidden: unfolding is a visibility swap, never
   * a rebuild. `geometry` marks the fold itself stale even when membership is
   * unchanged (a badge moved, or a non-seat end did).
   */
  const syncFoldWire = (entry: Entry, now: number, geometry = false): void => {
    const shape = foldShape(entry);
    const next = shape?.key;
    const previous = foldOfWire.get(entry.id);
    if (previous !== next) {
      removeFoldMember(entry);
      if (next !== undefined) {
        let fold = folds.get(next);
        if (fold === undefined) {
          fold = { key: next, members: new Set(), inside: shape?.inside ?? false, entry: undefined };
          folds.set(next, fold);
        }
        fold.members.add(entry.id);
        foldOfWire.set(entry.id, next);
        fold.inside = shape?.inside ?? false;
        foldsDirty.add(next);
      }
      entry.folded = next;
      visibleDirty = true;
      pickList = undefined;
      pickGrid = undefined;
      labelsRevision += 1;
      if (next === undefined) {
        // Back on its own strip: settle its paint at the clock, with no replay.
        refreshPaint(entry, now);
      } else {
        if (entry.pulse !== undefined) clearPulse(entry);
        running.delete(entry.id);
      }
      return;
    }
    if (next !== undefined) {
      entry.folded = next;
      if (geometry) foldsDirty.add(next);
    }
  };

  const leadOf = (members: ReadonlySet<WireId>): WireId | undefined => {
    let lead: WireId | undefined;
    let leadRank = 1;
    for (const id of members) {
      const entry = entries.get(id);
      if (entry === undefined) continue;
      const rank = isTrackVerb(entry.fact.row.verb) ? 0 : 1;
      if (lead === undefined || rank < leadRank || (rank === leadRank && id < lead)) {
        lead = id;
        leadRank = rank;
      }
    }
    return lead;
  };

  const foldFact = (id: WireId, lead: Entry): WireFact =>
    ({ id, row: { ...lead.fact.row, id } }) as unknown as WireFact;

  const freeFoldEntry = (fold: Fold): void => {
    const entry = fold.entry;
    if (entry === undefined) return;
    fold.entry = undefined;
    foldEntries.delete(entry.id);
    running.delete(entry.id);
    tracked.delete(entry.id);
    pool.free(entry.strip);
    glowPool.free(entry.glowStrip);
    trackPool.free(entry.trackStrip);
    if (entry.pulse !== undefined) clearPulse(entry);
    slots.release(entry.slot, 1);
    records.fill(0, entry.slot * RECORD_FLOATS, (entry.slot + 1) * RECORD_FLOATS);
    dirtyRecords.mark(entry.slot * RECORD_FLOATS, (entry.slot + 1) * RECORD_FLOATS);
    stripOrderDirty = true;
    visibleDirty = true;
    labelsRevision += 1;
    pickList = undefined;
    pickGrid = undefined;
  };

  const newFoldEntry = (id: WireId, fact: WireFact, meta: Entry["fold"], now: number): Entry => {
    const slot = takeSlot();
    const look: WireLook = { verb: fact.row.verb, selected: false, hovered: false, inCone: false };
    const paint = wirePaint(view(), look);
    return {
      id,
      slot,
      fact,
      ends: NAN_ENDS,
      route: undefined,
      line: undefined,
      bounds: undefined,
      label: undefined,
      labelView: undefined,
      strip: undefined,
      stripBody: undefined,
      stripPill: undefined,
      glowStrip: undefined,
      glowKey: "",
      layout: [],
      layoutByTier: {},
      trackStrip: undefined,
      trackLayoutAt: undefined,
      fits: [],
      paint,
      look,
      opacity: { from: paint.opacity, to: paint.opacity, since: now, ms: 0 },
      trackAlpha: { from: paint.track === undefined ? 0 : 1, to: paint.track === undefined ? 0 : 1, since: now, ms: 0 },
      glowAlpha: { from: 0, to: 0, since: now, ms: 0 },
      glowPasses: [],
      colour: colourOf(fact.row.verb),
      settling: false,
      pulse: undefined,
      folded: undefined,
      fold: meta,
    };
  };

  const clearFoldGeometry = (entry: Entry, now: number): void => {
    pool.free(entry.strip);
    entry.strip = undefined;
    entry.route = undefined;
    entry.line = undefined;
    entry.bounds = undefined;
    entry.label = undefined;
    syncGlowStrip(entry);
    writeRecord(entry, now);
    stripOrderDirty = true;
    visibleDirty = true;
    pickList = undefined;
    pickGrid = undefined;
  };

  /** Build the one elbow a fold draws, its width growing with its member count. */
  const rebuildFoldGeometry = (entry: Entry, now: number): void => {
    builds += 1;
    const fold = entry.fold;
    const lead = fold === undefined ? undefined : entries.get(fold.lead);
    if (fold === undefined || lead === undefined) {
      clearFoldGeometry(entry, now);
      return;
    }
    const from = endShape(lead.fact.row.from);
    const to = endShape(lead.fact.row.to);
    if (from.rect === undefined || to.rect === undefined) {
      clearFoldGeometry(entry, now);
      return;
    }
    const sides = wireSides(from.rect, to.rect);
    const route = routeOfElbow({
      source: handleEnd(from.rect, sides.source, "source"),
      sourceSide: sides.source,
      target: handleEnd(to.rect, sides.target, "target"),
      targetSide: sides.target,
    });
    const line = wireLine(route);
    entry.route = route;
    entry.line = line;
    entry.bounds = lineBounds(line);
    entry.label = route.label;
    labelsRevision += 1;
    const half = WIRE_HALF_WIDTH * Math.min(4, 1 + Math.log2(Math.max(1, fold.members.size)));
    const strip = buildStrip(line, half, { slot: entry.slot });
    pool.free(entry.strip);
    entry.strip = strip.count > 0 ? pool.put(undefined, strip.vertices, strip.count) : undefined;
    stripOrderDirty = true;
    visibleDirty = true;
    if (isTrackVerb(entry.fact.row.verb)) {
      entry.layoutByTier = {};
      entry.layout = trackLayout(route, tier);
      entry.layoutByTier[tier] = entry.layout;
      if (entry.layout.length > 0) tracked.add(entry.id);
      else tracked.delete(entry.id);
      tracksDirty = true;
    } else if (entry.layout.length > 0) {
      entry.layout = [];
      entry.layoutByTier = {};
      tracked.delete(entry.id);
      tracksDirty = true;
    }
    syncGlowStrip(entry);
    writeRecord(entry, now);
    pickList = undefined;
    pickGrid = undefined;
  };

  /** Rebuild one dirty fold in full: membership, lead, paint, geometry. */
  const rebuildFold = (key: string, now: number): void => {
    const fold = folds.get(key);
    if (fold === undefined) return;
    if (fold.members.size === 0) {
      freeFoldEntry(fold);
      folds.delete(key);
      return;
    }
    let first: Entry | undefined;
    for (const id of fold.members) {
      first = entries.get(id);
      if (first !== undefined) break;
    }
    const shape = first === undefined ? undefined : foldShape(first);
    fold.inside = shape?.inside ?? false;
    if (shape === undefined || fold.inside) {
      freeFoldEntry(fold);
      return;
    }
    const leadId = leadOf(fold.members);
    const lead = leadId === undefined ? undefined : entries.get(leadId);
    if (leadId === undefined || lead === undefined) {
      freeFoldEntry(fold);
      return;
    }
    const id = foldEntryId(key);
    const meta = { key, members: fold.members, lead: leadId };
    let entry = fold.entry;
    if (entry === undefined) {
      entry = newFoldEntry(id, foldFact(id, lead), meta, now);
      fold.entry = entry;
      foldEntries.set(id, entry);
    } else {
      entry.fact = foldFact(id, lead);
      entry.fold = meta;
      entry.colour = colourOf(entry.fact.row.verb);
    }
    rebuildFoldGeometry(entry, now);
    refreshPaint(entry, now);
  };

  /** Resolve dirty member keys, then rebuild every dirty fold outside the frame's slicing budget. */
  const syncFolds = (now: number): void => {
    if (foldWiresDirty.size > 0) {
      for (const id of [...foldWiresDirty]) {
        foldWiresDirty.delete(id);
        const entry = entries.get(id);
        if (entry !== undefined) syncFoldWire(entry, now);
      }
    }
    if (foldsDirty.size > 0) {
      for (const key of [...foldsDirty]) {
        foldsDirty.delete(key);
        rebuildFold(key, now);
      }
    }
  };

  const addWire = (fact: WireFact, now: number): void => {
    const existing = entries.get(fact.id);
    if (existing !== undefined) {
      const verbChanged = existing.fact.row.verb !== fact.row.verb;
      const endsChanged = existing.fact.row.from !== fact.row.from || existing.fact.row.to !== fact.row.to;
      if (endsChanged) unindex(existing);
      existing.fact = fact;
      if (endsChanged) index(existing);
      if (verbChanged) existing.colour = colourOf(fact.row.verb);
      existing.ends = NAN_ENDS;
      rebuild(existing, now);
      refreshPaint(existing, now);
      tracksDirty = true;
      foldWiresDirty.add(fact.id);
      return;
    }
    const slot = takeSlot();
    const look: WireLook = { verb: fact.row.verb, selected: false, hovered: false, inCone: false };
    const drawn = wirePaint(view(), look);
    const paint = host.awaitRoutes === true && !facts.has(fact.id) ? unseen(drawn) : drawn;
    const entry: Entry = {
      id: fact.id,
      slot,
      fact,
      ends: NAN_ENDS,
      route: undefined,
      line: undefined,
      bounds: undefined,
      label: undefined,
      labelView: undefined,
      strip: undefined,
      stripBody: undefined,
      stripPill: undefined,
      glowStrip: undefined,
      glowKey: "",
      layout: [],
      layoutByTier: {},
      trackStrip: undefined,
      trackLayoutAt: undefined,
      fits: [],
      paint,
      look,
      // A new wire is at its paint at once; one the loom has not answered
      // yet is at nothing, and fades in when its route lands.
      opacity: { from: paint.opacity, to: paint.opacity, since: now, ms: 0 },
      trackAlpha: { from: paint.track === undefined ? 0 : 1, to: paint.track === undefined ? 0 : 1, since: now, ms: 0 },
      glowAlpha: { from: 0, to: 0, since: now, ms: 0 },
      glowPasses: [],
      colour: colourOf(fact.row.verb),
      settling: false,
      pulse: undefined,
      folded: undefined,
      fold: undefined,
    };
    entries.set(fact.id, entry);
    stripOrderDirty = true;
    index(entry);
    coneWires = undefined;
    rebuild(entry, now);
    refreshPaint(entry, now);
    foldWiresDirty.add(fact.id);
  };

  const index = (entry: Entry): void => {
    for (const card of [entry.fact.row.from, entry.fact.row.to] as const) {
      let wires = byCard.get(card);
      if (wires === undefined) {
        wires = new Set();
        byCard.set(card, wires);
      }
      wires.add(entry.id);
    }
  };

  const unindex = (entry: Entry): void => {
    for (const card of [entry.fact.row.from, entry.fact.row.to] as const) {
      const wires = byCard.get(card);
      if (wires === undefined) continue;
      wires.delete(entry.id);
      if (wires.size === 0) byCard.delete(card);
    }
  };

  /** A card moved or changed: its wires' ends may have moved with it. */
  const markCard = (id: NodeId): void => {
    const wires = byCard.get(id);
    if (wires === undefined) return;
    for (const wire of wires) dirty.add(wire);
  };

  const removeWire = (id: WireId): void => {
    const entry = entries.get(id);
    if (entry === undefined) return;
    removeFoldMember(entry);
    entry.folded = undefined;
    unindex(entry);
    dirty.delete(id);
    tierOnly.delete(id);
    running.delete(id);
    tracked.delete(id);
    pool.free(entry.stripBody);
    pool.free(entry.stripPill);
    glowPool.free(entry.glowStrip);
    trackPool.free(entry.trackStrip);
    if (entry.pulse !== undefined) clearPulse(entry);
    entries.delete(id);
    stripOrderDirty = true;
    labelsRevision += 1;
    slots.release(entry.slot, 1);
    // A freed record must not draw: it is zero.
    records.fill(0, entry.slot * RECORD_FLOATS, (entry.slot + 1) * RECORD_FLOATS);
    dirtyRecords.mark(entry.slot * RECORD_FLOATS, (entry.slot + 1) * RECORD_FLOATS);
    if (entry.layout.length > 0) tracksDirty = true;
    visibleDirty = true;
    coneWires = undefined;
    pickList = undefined;
    pickGrid = undefined;
  };

  // --- the connection preview -----------------------------------------------------

  const OPPOSITE: Record<WireDirection, WireDirection> = { left: "right", right: "left", top: "bottom", bottom: "top" };

  const controlOffset = (distance: number): number =>
    distance >= 0 ? 0.5 * distance : BEZIER_CURVATURE * 25 * Math.sqrt(-distance);

  /** React Flow's `getControlWithCurvature`. */
  const control = (side: WireDirection, from: Point, to: Point): Point => {
    switch (side) {
      case "left":
        return { x: from.x - controlOffset(from.x - to.x), y: from.y };
      case "right":
        return { x: from.x + controlOffset(to.x - from.x), y: from.y };
      case "top":
        return { x: from.x, y: from.y - controlOffset(from.y - to.y) };
      case "bottom":
        return { x: from.x, y: from.y + controlOffset(to.y - from.y) };
    }
  };

  /** The preview as a centreline: React Flow's default cubic from the handle toward the pointer. */
  const previewLineOf = (from: Point, side: WireDirection, to: Point): WireLine => {
    const c1 = control(side, from, to);
    const c2 = control(OPPOSITE[side], to, from);
    const n = PREVIEW_STEPS + 1;
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    const tx = new Float64Array(n);
    const ty = new Float64Array(n);
    const s = new Float64Array(n);
    let walked = 0;
    for (let i = 0; i < n; i += 1) {
      const t = i / PREVIEW_STEPS;
      const u = 1 - t;
      x[i] = u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x;
      y[i] = u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y;
      const dx = 3 * u * u * (c1.x - from.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (to.x - c2.x);
      const dy = 3 * u * u * (c1.y - from.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (to.y - c2.y);
      const len = Math.hypot(dx, dy);
      tx[i] = len > 1e-9 ? dx / len : i > 0 ? tx[i - 1]! : 1;
      ty[i] = len > 1e-9 ? dy / len : i > 0 ? ty[i - 1]! : 0;
      if (i > 0) walked += Math.hypot(x[i]! - x[i - 1]!, y[i]! - y[i - 1]!);
      s[i] = walked;
    }
    return { count: n, x, y, tx, ty, s, length: walked };
  };

  const syncPreview = (): void => {
    visibleDirty = true;
    const o = PREVIEW_SLOT * RECORD_FLOATS;
    if (preview === null) {
      pool.free(previewStrip);
      previewStrip = undefined;
      previewLine = undefined;
      records.fill(0, o, o + RECORD_FLOATS);
      dirtyRecords.mark(o, o + RECORD_FLOATS);
      return;
    }
    const line = previewLineOf(preview.from, preview.fromSide, preview.to);
    previewLine = line;
    const strip = buildStrip(line, WIRE_HALF_WIDTH, { slot: PREVIEW_SLOT });
    previewStrip = strip.count > 0 ? pool.put(previewStrip, strip.vertices, strip.count) : undefined;
    // React Flow draws it in one solid ink; ours is the neutral wire token.
    const colour = tokenRgba(WIRE_UNSET_TOKEN, mode);
    records[o + R.colour] = colour[0];
    records[o + R.colour + 1] = colour[1];
    records[o + R.colour + 2] = colour[2];
    records[o + R.colour + 3] = colour[3];
    records[o + R.opacity] = FULL_OPACITY;
    records[o + R.length] = line.length;
    dirtyRecords.mark(o, o + RECORD_FLOATS);
  };

  // --- ops ------------------------------------------------------------------------

  let now = 0;

  const apply: WireScene["apply"] = (op) => {
    switch (op.kind) {
      case "load": {
        for (const id of [...entries.keys()]) removeWire(id);
        facts.clear();
        for (const fact of op.wires) addWire(fact, now);
        tracksDirty = true;
        return;
      }
      case "wire":
        addWire(op.fact, now);
        return;
      case "removeWire":
        removeWire(op.id);
        facts.delete(op.id);
        return;
      case "card":
        markCard(op.fact.id);
        return;
      case "removeCard":
        markCard(op.id);
        return;
      case "routes": {
        // The wires answered for the first time: they fade in once rebuilt.
        const landed = host.awaitRoutes === true ? op.set.filter((fact) => !facts.has(fact.id)).map((fact) => fact.id) : [];
        for (const id of op.remove) facts.delete(id);
        for (const fact of op.set) facts.set(fact.id, fact);
        for (const id of op.remove) {
          const entry = entries.get(id);
          if (entry !== undefined) rebuild(entry, now);
        }
        for (const fact of op.set) {
          const entry = entries.get(fact.id);
          if (entry !== undefined) rebuild(entry, now);
        }
        for (const id of landed) {
          const entry = entries.get(id);
          if (entry !== undefined) refreshPaint(entry, now);
        }
        if (landed.length > 0) labelsRevision += 1;
        return;
      }
      case "selection":
        selection = op.fact;
        coneWires = undefined;
        refreshAll(now);
        return;
      case "theme": {
        mode = op.mode;
        forEachEntry((entry) => {
          entry.colour = colourOf(entry.fact.row.verb);
          writeRecord(entry, now);
        });
        syncPreview();
        return;
      }
      case "wireMode":
        wireMode = op.mode;
        refreshAll(now);
        return;
      case "preview": {
        const wasConnecting = preview !== null;
        preview = op.preview === null ? null : { from: op.preview.from, fromSide: op.preview.fromSide, to: op.preview.to };
        syncPreview();
        // The preview's own geometry changes each pointer move; the view every
        // wire paints in changes only when a connect starts or ends.
        if (wasConnecting !== (preview !== null)) refreshAll(now);
        return;
      }
      case "pulse": {
        const member = entries.get(op.wireId);
        if (member === undefined) return;
        let entry = member;
        let reverse = op.reverse ?? false;
        if (member.folded !== undefined) {
          const fold = folds.get(member.folded);
          if (fold === undefined || fold.inside || fold.entry === undefined || fold.entry.fold === undefined) return;
          const lead = entries.get(fold.entry.fold.lead);
          if (lead !== undefined) {
            const memberFirst = endShape(member.fact.row.from).token;
            const leadFirst = endShape(lead.fact.row.from).token;
            if (memberFirst !== leadFirst) reverse = !reverse;
          }
          entry = fold.entry;
        }
        // The cap counts the pulses a frame draws: a pulse no one can see
        // takes no slot, and the slot it needs is taken when it comes back.
        if (activePulses >= WIRE_PULSE_MAX_ACTIVE && inView(entry)) return;
        entry.pulse = { startedAt: op.at, kind: op.pulse ?? PULSE_KIND_DEFAULT, reverse };
        running.add(entry.id);
        return;
      }
      default:
        return;
    }
  };

  // --- the frame ------------------------------------------------------------------

  const inView = (entry: Entry): boolean => {
    const b = entry.bounds;
    if (b === undefined) return false;
    const x0 = -camera.x / zoom;
    const y0 = -camera.y / zoom;
    const x1 = x0 + viewSize.width / zoom;
    const y1 = y0 + viewSize.height / zoom;
    return b.maxX >= x0 && b.minX <= x1 && b.maxY >= y0 && b.minY <= y1;
  };

  const tracksMove = (): boolean => {
    if (reduced()) return false;
    for (const id of tracked) {
      const entry = entryOf(id);
      if (entry !== undefined && entry.folded === undefined && entry.paint.track !== undefined && inView(entry)) return true;
    }
    return false;
  };

  let stepMs = 0;
  const stepMotion = (at: number): boolean => {
    const started = performance.now();
    let moving = false;
    activePulses = 0;
    pulseDraws = [];
    for (const id of running) {
      const entry = entryOf(id);
      if (entry === undefined) {
        running.delete(id);
        continue;
      }
      if (entry.folded !== undefined) {
        running.delete(id);
        continue;
      }
      // A wire no one can see takes no motion this frame. Its tweens are
      // time-based, so the frame that brings it back writes the values the
      // clock has reached, never a restart and never a jump.
      const visible = inView(entry);
      const easing = !tweenDone(entry.opacity, at) || !tweenDone(entry.trackAlpha, at) || !tweenDone(entry.glowAlpha, at);
      // The frame a transition ends writes its final value, once.
      if (easing || entry.settling) {
        entry.settling = easing;
        if (visible) {
          if (!easing && entry.glowAlpha.to === 0 && entry.glowStrip !== undefined) {
            // A finished fade-out frees the glow strip.
            entry.glowPasses = [];
            syncGlowStrip(entry);
          }
          writeRecord(entry, at);
        }
        if (easing && visible) moving = true;
      }
      const pulse = entry.pulse;
      if (pulse !== undefined && !visible) {
        // Its draw is off screen: no slot and no work, only its expiry.
        if (at >= pulse.startedAt + WIRE_PULSE_MS) clearPulse(entry);
      } else if (pulse !== undefined) {
        const length = entry.line?.length ?? 0;
        const token = tokenRgba(pulseToken(pulse.kind), mode);
        const folded = tier === "near" ? entry.paint.pulseOpacity : 0;
        if (reduced()) {
          const hold = pulseHold(pulse.startedAt, at);
          if (hold === undefined) clearPulse(entry);
          else {
            writePulse(entry, -1, length + 1, PULSE_HOLD_WIDTH / 2, token, hold * folded);
            activePulses += 1;
            if (entry.strip !== undefined && folded > 0) pulseDraws.push({ start: entry.strip.start, count: entry.strip.count });
            moving = moving || inView(entry);
          }
        } else {
          const span = pulseSpan(length, pulse.reverse, pulse.startedAt, at);
          if (span === undefined && at >= pulse.startedAt + WIRE_PULSE_MS) clearPulse(entry);
          else if (span === undefined) {
            // Before its start: nothing yet, and it is not motion.
            writePulse(entry, 0, 0, 0, token, 0);
          } else {
            writePulse(entry, span.from, span.to, PULSE_HALF_WIDTH, token, folded);
            activePulses += 1;
            if (entry.strip !== undefined && folded > 0) pulseDraws.push({ start: entry.strip.start, count: entry.strip.count });
            moving = moving || inView(entry);
          }
        }
      }
      if (!easing && !entry.settling && entry.pulse === undefined) running.delete(id);
    }
    stepMs = performance.now() - started;
    return moving;
  };

  /** The index array `append` last wrote into: the one passed, or its grown copy. */
  let appended: Uint32Array = new Uint32Array(0);
  /** Append a strip and its restart; returns the new count, the array in `appended`. */
  const append = (target: Uint32Array, at: number, start: number, count: number): number => {
    let array = target;
    // One trailing restart breaks the strip between two wires: without it the
    // last triangle of one would share an edge with the first of the next.
    if (at + count + 1 > array.length) {
      let next = array.length;
      while (next < at + count + 1) next *= 2;
      const grown = new Uint32Array(next);
      grown.set(array.subarray(0, at));
      array = grown;
    }
    for (let k = 0; k < count; k += 1) array[at + k] = start + k;
    array[at + count] = RESTART;
    appended = array;
    return at + count + 1;
  };

  /**
   * Every wire in its main strip's pool order, sorted again only when a strip
   * or a wire comes or goes (a slice's start never moves), so a pan frame
   * walks it without sorting or allocating.
   */
  const byStrip: Entry[] = [];
  const byStart = (a: Entry, b: Entry): number => (a.strip?.start ?? 0) - (b.strip?.start ?? 0);
  const collect = (entry: Entry): void => {
    byStrip.push(entry);
  };
  const buildVisible = (): void => {
    mainCount = 0;
    glowCount = 0;
    trackCount = 0;
    // The pool covers in index order, so a wire drawn later wins the pixels it
    // shares. Draw the visible strips in that same order; picking reads it.
    if (stripOrderDirty) {
      byStrip.length = 0;
      entries.forEach(collect);
      foldEntries.forEach(collect);
      byStrip.sort(byStart);
      stripOrderDirty = false;
    }
    for (let index = 0; index < byStrip.length; index += 1) {
      const entry = byStrip[index]!;
      if (entry.folded !== undefined || !inView(entry)) continue;
      if (entry.strip !== undefined) {
        mainCount = append(mainIndex, mainCount, entry.strip.start, entry.strip.count);
        mainIndex = appended;
      }
      if (entry.glowStrip !== undefined && entry.glowPasses.length > 0) {
        glowCount = append(glowIndex, glowCount, entry.glowStrip.start, entry.glowStrip.count);
        glowIndex = appended;
      }
      if (entry.trackStrip !== undefined && entry.paint.track !== undefined) {
        trackCount = append(trackIndex, trackCount, entry.trackStrip.start, entry.trackStrip.count);
        trackIndex = appended;
      }
    }
    if (preview !== null && previewStrip !== undefined) {
      mainCount = append(mainIndex, mainCount, previewStrip.start, previewStrip.count);
      mainIndex = appended;
    }
    visibleRevision += 1;
  };

  const sameEnds = (a: Entry["ends"], b: Entry["ends"]): boolean => {
    for (let i = 0; i < a.length; i += 1) {
      const x = a[i]!;
      const y = b[i]!;
      if (x !== y && !(Number.isNaN(x) && Number.isNaN(y))) return false;
    }
    return true;
  };

  const frame: WireScene["frame"] = (f) => {
    const moved = camera.x !== f.camera.x || camera.y !== f.camera.y || camera.zoom !== f.camera.zoom;
    const resized = viewSize.width !== f.width || viewSize.height !== f.height;
    camera = f.camera;
    zoom = f.camera.zoom;
    pixelRatio = f.pixelRatio;
    if (resized) viewSize = { width: f.width, height: f.height };
    wall = f.wall;
    now = f.wall;
    if (moved || resized) visibleDirty = true;
    if (f.tier !== tier) {
      tier = f.tier;
      // The tier's scale and overview hide are uniforms; no wire repaints.
      refreshMs = 0;
      relayoutTracks();
      // A crossing changes the body a card draws, not the plan: the body
      // strip and the mid pill strip are each kept, and a crossing swaps one
      // in. Only a wire never built with this body is rebuilt, and never a
      // walk over every wire's ends to find that out.
      const pill = tier === "mid";
      for (const entry of entries.values()) {
        const cached = pill ? entry.stripPill : entry.stripBody;
        if (cached !== undefined) {
          entry.strip = cached;
          stripOrderDirty = true;
          continue;
        }
        tierOnly.add(entry.id);
        const b = entry.bounds;
        const margin = 200 / zoom;
        const onScreen =
          b !== undefined &&
          b.maxX >= -camera.x / zoom - margin &&
          b.minX <= -camera.x / zoom + viewSize.width / zoom + margin &&
          b.maxY >= -camera.y / zoom - margin &&
          b.minY <= -camera.y / zoom + viewSize.height / zoom + margin;
        if (onScreen) dirty.add(entry.id);
        else tierStale.add(entry.id);
      }
      tierStaleList = [...tierStale];
      tierStaleAt = 0;
      // gatheredInto is tiered: re-key every wire once at the crossing. The
      // members' strips are kept; only their visibility and the fold strips change.
      for (const id of entries.keys()) foldWiresDirty.add(id);
    }
    // A regroup lands in the same frame as the badge: drain it after prepare's
    // tier work and before any visible list is built.
    for (const id of host.gatheringChanged?.() ?? []) {
      const wires = byCard.get(id);
      if (wires === undefined) continue;
      for (const wire of wires) {
        foldWiresDirty.add(wire);
        const key = foldOfWire.get(wire);
        if (key !== undefined) foldsDirty.add(key);
      }
    }
    syncFolds(now);
    // A card a pointer owns this frame can be somewhere its row is not yet.
    if (f.live !== undefined) {
      for (const id of f.live) markCard(id);
    }
    // Only what a model op or a live card touched is rebuilt: no wire is read
    // per frame just in case. A cold tier crossing puts every wire in here at
    // once (a first visit to mid at 100x is 93,000 strips); the rebuild is
    // sliced, so no frame carries the whole board. A wire whose turn has not
    // come keeps the strip it had, so nothing blinks.
    const rebuildStarted = performance.now();
    // A stale wire is built when the view reaches it: scan a slice of the
    // stale list each frame, and rebuild the in-view ones within the budget.
    if (staleCamera.x !== camera.x || staleCamera.y !== camera.y || staleCamera.zoom !== camera.zoom) {
      staleCamera = { x: camera.x, y: camera.y, zoom: camera.zoom };
      tierStaleAt = 0;
    }
    let staleInView = false;
    if (tierStaleList.length > 0) {
      const margin = 200 / zoom;
      const x0 = -camera.x / zoom - margin;
      const y0 = -camera.y / zoom - margin;
      const x1 = -camera.x / zoom + viewSize.width / zoom + margin;
      const y1 = -camera.y / zoom + viewSize.height / zoom + margin;
      let scanned = 0;
      while (scanned < 20000 && tierStaleAt < tierStaleList.length) {
        const id = tierStaleList[tierStaleAt]!;
        tierStaleAt += 1;
        scanned += 1;
        const entry = entries.get(id);
        if (entry === undefined) {
          tierStale.delete(id);
          continue;
        }
        const b = entry.bounds;
        const onScreen = b !== undefined && b.maxX >= x0 && b.minX <= x1 && b.maxY >= y0 && b.minY <= y1;
        if (!onScreen) continue;
        staleInView = true;
        if (performance.now() - rebuildStarted > 6) continue;
        tierStale.delete(id);
        rebuild(entry, now);
      }
      if (tierStaleAt >= tierStaleList.length) {
        tierStaleList = [...tierStale];
        tierStaleAt = 0;
      }
    }
    for (const id of dirty) {
      if (performance.now() - rebuildStarted > 6) break;
      dirty.delete(id);
      const entry = entries.get(id);
      if (entry !== undefined) rebuild(entry, now);
    }
    syncFolds(now);
    if (tracksDirty) rebuildTracks();
    if (visibleDirty) {
      buildVisible();
      visibleDirty = false;
    }
    return stepMotion(now) || tracksMove() || dirty.size > 0 || staleInView;
  };

  const busy: WireScene["busy"] = (at) => {
    if (tracksMove()) return true;
    for (const id of running) {
      const entry = entryOf(id);
      if (entry === undefined || entry.folded !== undefined) continue;
      if (!inView(entry)) continue;
      if (entry.pulse !== undefined) return true;
      if (!tweenDone(entry.opacity, at) || !tweenDone(entry.trackAlpha, at) || !tweenDone(entry.glowAlpha, at)) return true;
    }
    return false;
  };

  const uniforms: WireScene["uniforms"] = () => {
    const flows = trackPhase("flows", tier, wall, reduced());
    const derives = trackPhase("derives", tier, wall, reduced());
    return {
      camera: [camera.x, camera.y, camera.zoom, pixelRatio],
      view: [viewSize.width, viewSize.height, PULSE_HALF_WIDTH, WIRE_HALF_WIDTH],
      track: [flows.period, flows.offset, derives.offset, derives.opacity],
      tier: [tierScale(tier), tierHide(tier)],
    };
  };

  // --- picking ---------------------------------------------------------------------

  const PICK_CELL = 512;
  const PICK_REACH = 48;
  const pickCells = (): Map<number, Array<{ candidate: PickCandidate<WireId>; order: number }>> => {
    if (pickGrid !== undefined) return pickGrid;
    const cells = new Map<number, Array<{ candidate: PickCandidate<WireId>; order: number }>>();
    pickWide = [];
    const list = pickList ?? [];
    list.forEach((candidate, order) => {
      const box = candidate.bounds;
      if (box === undefined) {
        pickWide.push({ candidate, order });
        return;
      }
      const x0 = Math.floor((box.minX - PICK_REACH) / PICK_CELL);
      const x1 = Math.floor((box.maxX + PICK_REACH) / PICK_CELL);
      const y0 = Math.floor((box.minY - PICK_REACH) / PICK_CELL);
      const y1 = Math.floor((box.maxY + PICK_REACH) / PICK_CELL);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 96) {
        pickWide.push({ candidate, order });
        return;
      }
      for (let cx = x0; cx <= x1; cx += 1) {
        for (let cy = y0; cy <= y1; cy += 1) {
          const key = cx * 2097152 + (cy + 1048576);
          const bucket = cells.get(key);
          const entry = { candidate, order };
          if (bucket === undefined) cells.set(key, [entry]);
          else bucket.push(entry);
        }
      }
    });
    pickGrid = cells;
    return cells;
  };

  const pick: WireScene["pick"] = (at) => {
    if (pickList === undefined) {
      // The pool draws as one indexed triangle strip, in index order, so the
      // strip with the higher start covers the lower one where they overlap.
      // Sort by that order: entries iteration is insertion order, and a freed
      // run can hand a later wire a lower start than an earlier wire.
      const ordered: Array<{ start: number; candidate: PickCandidate<WireId> }> = [];
      forEachEntry((entry) => {
        if (entry.folded !== undefined) return;
        if (!entry.paint.pickable || entry.line === undefined || entry.route === undefined || entry.strip === undefined) return;
        ordered.push({
          start: entry.strip.start,
          candidate: {
            id: entry.fold?.lead ?? entry.id,
            line: entry.line,
            hitHalfWidth: entry.route.hitHalfWidth,
            ...(entry.bounds ? { bounds: entry.bounds } : {}),
          },
        });
      });
      ordered.sort((a, b) => a.start - b.start);
      pickList = ordered.map((item) => item.candidate);
    }
    const cells = pickCells();
    const x0 = Math.floor((at.x - PICK_REACH) / PICK_CELL);
    const x1 = Math.floor((at.x + PICK_REACH) / PICK_CELL);
    const y0 = Math.floor((at.y - PICK_REACH) / PICK_CELL);
    const y1 = Math.floor((at.y + PICK_REACH) / PICK_CELL);
    let best: { id: WireId; order: number } | undefined;
    const consider = (entry: { candidate: PickCandidate<WireId>; order: number }): void => {
      if (best !== undefined && entry.order <= best.order) return;
      const hit = pickWire([entry.candidate], at);
      if (hit !== null) best = { id: hit.id, order: entry.order };
    };
    const seen = new Set<number>();
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        for (const entry of cells.get(cx * 2097152 + (cy + 1048576)) ?? []) {
          if (seen.has(entry.order)) continue;
          seen.add(entry.order);
          consider(entry);
        }
      }
    }
    for (const entry of pickWide) consider(entry);
    return best?.id;
  };

  const labelOf: WireScene["labelOf"] = (id) => {
    const direct = entries.get(id);
    if (direct?.folded === undefined) return direct?.label;
    const key = direct?.folded;
    const fold = key === undefined ? undefined : folds.get(key);
    return fold?.entry?.label;
  };

  // The button paints over a label point, in append order: the last match is
  // the one on top, exactly as the shell's buttons stack.
  const labelAt: WireScene["labelAt"] = (at, half) => {
    let found: WireId | undefined;
    for (const label of labelsInView()) {
      const point = label.at;
      if (Math.abs(point.x - at.x) <= half && Math.abs(point.y - at.y) <= half) found = label.id as WireId;
    }
    return found;
  };

  const labelWindow = { x0: 0, y0: 0, x1: 0, y1: 0 };
  const collectLabel = (entry: Entry): void => {
    if (entry.folded !== undefined) return;
    const at = entry.label;
    if (at === undefined || waiting(entry)) return;
    if (at.x < labelWindow.x0 || at.x > labelWindow.x1 || at.y < labelWindow.y0 || at.y > labelWindow.y1) return;
    const verb = entry.fact.row.verb;
    let view = entry.labelView;
    if (view === undefined || view.at !== at || view.verb !== verb) {
      view = { id: entry.fold?.lead ?? entry.id, at, verb };
      entry.labelView = view;
    }
    // Written by index, the list trimmed after: emptying it with
    // `length = 0` frees its storage, and each pan would grow it again.
    labelsCache[labelsCount] = view;
    labelsCount += 1;
  };
  let labelsCount = 0;

  let labelsMs = 0;
  const labelsInView: WireScene["labelsInView"] = () => {
    if (
      labelsAt.x === camera.x &&
      labelsAt.y === camera.y &&
      labelsAt.zoom === camera.zoom &&
      labelsCacheRevision === labelsRevision &&
      labelsCacheView.width === viewSize.width &&
      labelsCacheView.height === viewSize.height
    ) {
      return labelsCache;
    }
    const labelsStarted = performance.now();
    labelsCount = 0;
    // The label's own point, not the wire's bounds: a long run that crosses
    // the view can put its midpoint far outside it.
    const margin = 24;
    labelWindow.x0 = -camera.x / zoom - margin;
    labelWindow.y0 = -camera.y / zoom - margin;
    labelWindow.x1 = labelWindow.x0 + viewSize.width / zoom + 2 * margin;
    labelWindow.y1 = labelWindow.y0 + viewSize.height / zoom + 2 * margin;
    entries.forEach(collectLabel);
    foldEntries.forEach(collectLabel);
    if (labelsCache.length !== labelsCount) labelsCache.length = labelsCount;
    labelsAt.x = camera.x;
    labelsAt.y = camera.y;
    labelsAt.zoom = camera.zoom;
    labelsCacheView.width = viewSize.width;
    labelsCacheView.height = viewSize.height;
    labelsCacheRevision = labelsRevision;
    labelsMs = performance.now() - labelsStarted;
    return labelsCache;
  };

  const inspect: WireScene["inspect"] = (id) => {
    const member = entries.get(id);
    const fold = member?.folded === undefined ? undefined : folds.get(member.folded);
    if (member?.folded !== undefined && (fold === undefined || fold.inside || fold.entry === undefined)) return undefined;
    const entry = fold?.entry ?? member;
    if (entry?.route === undefined || entry.line === undefined) return undefined;
    return {
      kind: entry.route.kind,
      length: entry.line.length,
      points: entry.route.points,
      opacity: entry.opacity.to,
      pickable: entry.paint.pickable,
    };
  };

  return {
    apply,
    setHover: (id) => {
      if (hover === id) return;
      const before = hover;
      hover = id;
      for (const key of [before, id]) {
        const entry = key === undefined ? undefined : entries.get(key);
        if (entry !== undefined) refreshPaint(entry, now);
        const foldKey = entry?.folded;
        const fold = foldKey === undefined ? undefined : folds.get(foldKey)?.entry;
        if (fold !== undefined) refreshPaint(fold, now);
      }
    },
    frame,
    busy,
    uniforms,
    pick,
    labelOf,
    labelsInView,
    labelAt,
    labelsRevision: () => labelsRevision,
    inspect,
    foldOf: (id) => {
      const key = foldOfWire.get(id);
      const fold = key === undefined ? undefined : folds.get(key);
      return fold === undefined ? undefined : [...fold.members].sort();
    },
    folds: () =>
      [...folds.values()]
        .filter((fold) => !fold.inside && fold.entry?.route !== undefined)
        .map((fold) => ({
          key: fold.key,
          lead: fold.entry?.fold?.lead ?? "",
          members: [...fold.members].sort(),
          points: fold.entry?.route?.points ?? [],
        })),
    builds: () => builds,
    wires: () => entries.size,
    withFact: () => facts.size,
    refreshMs: () => refreshMs,
    stepMs: () => stepMs,
    labelsMs: () => labelsMs,
    wireIds: () => [...entries.keys()],
    pulseFirst: (count, at) => {
      let left = count;
      for (const [id, entry] of entries) {
        if (left <= 0) break;
        if (!inView(entry)) continue;
        apply({ kind: "pulse", wireId: id, at });
        left -= 1;
      }
      return count - left;
    },
    poolBytes: () =>
      [pool, glowPool, trackPool].reduce(
        (bytes, each) => bytes + each.vertices().byteLength + each.indices().byteLength,
        0,
      ),
    waiting: () => {
      let total = 0;
      let inView = 0;
      if (host.awaitRoutes !== true) return { total, inView };
      const x0 = -camera.x / zoom;
      const y0 = -camera.y / zoom;
      const x1 = x0 + viewSize.width / zoom;
      const y1 = y0 + viewSize.height / zoom;
      for (const entry of entries.values()) {
        if (!waiting(entry)) continue;
        total += 1;
        const b = entry.bounds;
        if (b !== undefined && b.maxX >= x0 && b.minX <= x1 && b.maxY >= y0 && b.minY <= y1) inView += 1;
      }
      return { total, inView };
    },
    visibleIndices: () => ({
      main: mainIndex,
      mainCount,
      glow: glowIndex,
      glowCount,
      tracks: trackIndex,
      tracksCount: trackCount,
      revision: visibleRevision,
    }),
    pool,
    glowPool,
    trackPool,
    records: () => records,
    dirtyRecords,
    pulses: () => pulseDraws,
    recordsGeneration: () => recordsGeneration,
    size: () => entries.size,
  };
};
