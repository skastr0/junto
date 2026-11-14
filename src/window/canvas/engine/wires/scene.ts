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
import { createStripPool, type Slice, type StripPool } from "./pool";
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
  /** The live rectangles the route was built against, as eight numbers; NaN when a card is missing. */
  ends: [number, number, number, number, number, number, number, number];
  route: WireRoute | undefined;
  line: WireLine | undefined;
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | undefined;
  strip: Slice | undefined;
  glowStrip: Slice | undefined;
  glowKey: string;
  layout: ReadonlyArray<TrackRun>;
  trackStrip: Slice | undefined;
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
};

export type WireHost = {
  /** A card's live board rectangle, dragged or not; undefined when it is not on the board. */
  readonly rectOf: (id: NodeId) => Rect | undefined;
  readonly mode?: ThemeMode;
  /** Reduced motion: tracks hold still, pulses hold the wire, nothing eases. */
  readonly reducedMotion?: () => boolean;
};

export type WireFrame = {
  readonly camera: Camera;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly tier: CanvasTier;
  /** Epoch milliseconds: the wall clock every phase reads. */
  readonly wall: number;
};

/** The numbers the shader reads once a frame, as plain floats (see `shader.ts`). */
export type WireUniforms = {
  readonly camera: readonly [x: number, y: number, zoom: number, pixelRatio: number];
  readonly view: readonly [width: number, height: number, pulseHalf: number, hairHalf: number];
  readonly track: readonly [period: number, flowsOffset: number, derivesOffset: number, derivesOpacity: number];
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
  /** A wire's centreline length and route kind, for tests and the harness. */
  readonly inspect: (id: WireId) => WireInspect | undefined;
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

export type WireInspect = {
  readonly kind: WireRoute["kind"];
  readonly length: number;
  readonly points: ReadonlyArray<Point>;
  readonly opacity: number;
  readonly pickable: boolean;
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
  const facts = new Map<WireId, WireRouteFact>();
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
  let pulseDraws: Array<{ start: number; count: number }> = [];
  let activePulses = 0;

  const reduced = (): boolean => host.reducedMotion?.() ?? false;
  const ms = (kind: "opacity" | "glow"): number => (reduced() ? 0 : WIRE_TRANSITIONS[kind].ms);

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

  const lookOf = (entry: Entry): WireLook => ({
    verb: entry.fact.row.verb,
    selected: selection?.wireId === entry.id,
    hovered: hover === entry.id,
    inCone: coneSet()?.has(entry.id) ?? false,
  });

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
    const paint = wirePaint(view$, look);
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
    syncGlowStrip(entry);
    pickList = undefined;
    writeRecord(entry, now);
  };

  const refreshAll = (now: number): void => {
    for (const entry of entries.values()) refreshPaint(entry, now);
  };

  // --- routes ---------------------------------------------------------------

  const NAN_ENDS: Entry["ends"] = [NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN];

  const readEnds = (entry: Entry): { ends: Entry["ends"]; from: Rect | undefined; to: Rect | undefined } => {
    const from = host.rectOf(entry.fact.row.from);
    const to = host.rectOf(entry.fact.row.to);
    if (from === undefined || to === undefined) return { ends: NAN_ENDS, from, to };
    return { ends: [from.x, from.y, from.width, from.height, to.x, to.y, to.width, to.height], from, to };
  };

  const sameEnds = (a: Entry["ends"], b: Entry["ends"]): boolean => {
    for (let i = 0; i < 8; i += 1) {
      const x = a[i]!;
      const y = b[i]!;
      if (x !== y && !(Number.isNaN(x) && Number.isNaN(y))) return false;
    }
    return true;
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

  const routeFor = (entry: Entry, from: Rect, to: Rect): WireRoute => {
    const fact = facts.get(entry.id);
    const holds = fact !== undefined && planHolds(fact, from, to);
    if (holds && fact.points !== undefined && fact.points.length >= 2) {
      const cable = fact.cable;
      return {
        kind: cable ? "strand" : "route",
        points: fact.points,
        radius: cable ? SPINE_RADIUS : ROUTE_RADIUS,
        rounding: "orthogonal",
        label: { x: 0, y: 0 },
        hitHalfWidth: (cable ? STRAND_HIT_WIDTH : HIT_WIDTH) / 2,
      };
    }
    const sides = holds ? { source: fact.sourceSide, target: fact.targetSide } : wireSides(from, to);
    return routeOfElbow(
      {
        source: handleEnd(from, sides.source, "source"),
        sourceSide: sides.source,
        target: handleEnd(to, sides.target, "target"),
        targetSide: sides.target,
      },
      holds ? fact.lane : undefined,
    );
  };

  const rebuild = (entry: Entry, now: number): void => {
    const { ends, from, to } = readEnds(entry);
    entry.ends = ends;
    if (from === undefined || to === undefined) {
      pool.free(entry.strip);
      entry.strip = undefined;
      entry.route = undefined;
      entry.line = undefined;
      entry.bounds = undefined;
      syncGlowStrip(entry);
      if (entry.layout.length > 0) {
        entry.layout = [];
        tracksDirty = true;
      }
      writeRecord(entry, now);
      pickList = undefined;
      return;
    }
    const route = routeFor(entry, from, to);
    const line = wireLine(route);
    entry.route = route;
    entry.line = line;
    entry.bounds = lineBounds(line);
    const strip: WireStrip = buildStrip(line, WIRE_HALF_WIDTH, { slot: entry.slot });
    entry.strip = strip.count > 0 ? pool.put(entry.strip, strip.vertices, strip.count) : undefined;
    if (strip.count === 0 && entry.strip === undefined) pool.free(entry.strip);
    if (isTrackVerb(entry.fact.row.verb)) {
      entry.layout = trackLayout(route, tier);
      tracksDirty = true;
    }
    syncGlowStrip(entry);
    writeRecord(entry, now);
    pickList = undefined;
  };

  const rebuildTracks = (): void => {
    const layouts: Record<string, ReadonlyArray<TrackRun>> = {};
    for (const entry of entries.values()) if (entry.layout.length > 0) layouts[entry.id] = entry.layout;
    const fits = trackFits(layouts, tier);
    for (const entry of entries.values()) {
      const runs = entry.layout;
      if (runs.length === 0) {
        trackPool.free(entry.trackStrip);
        entry.trackStrip = undefined;
        continue;
      }
      const strip = buildTrackStrip(runs, tier, { fits: fits[entry.id] ?? [], slot: entry.slot });
      entry.trackStrip = strip.count > 0 ? trackPool.put(entry.trackStrip, strip.vertices, strip.count) : undefined;
    }
    tracksDirty = false;
  };

  const relayoutTracks = (): void => {
    for (const entry of entries.values()) {
      if (!isTrackVerb(entry.fact.row.verb) || entry.route === undefined) continue;
      entry.layout = trackLayout(entry.route, tier);
    }
    tracksDirty = true;
  };

  // --- wires ------------------------------------------------------------------

  const colourOf = (verb: WireFact["row"]["verb"] | undefined): Rgba => tokenRgba(paintToken(verb), mode);
  const paintToken = (verb: WireFact["row"]["verb"] | undefined): string => wirePaint(view(), { verb, selected: false, hovered: false, inCone: false }).token;

  const addWire = (fact: WireFact, now: number): void => {
    const existing = entries.get(fact.id);
    if (existing !== undefined) {
      const verbChanged = existing.fact.row.verb !== fact.row.verb;
      existing.fact = fact;
      if (verbChanged) existing.colour = colourOf(fact.row.verb);
      existing.ends = NAN_ENDS;
      rebuild(existing, now);
      refreshPaint(existing, now);
      tracksDirty = true;
      return;
    }
    const slot = takeSlot();
    const look: WireLook = { verb: fact.row.verb, selected: false, hovered: false, inCone: false };
    const paint = wirePaint(view(), look);
    const entry: Entry = {
      id: fact.id,
      slot,
      fact,
      ends: NAN_ENDS,
      route: undefined,
      line: undefined,
      bounds: undefined,
      strip: undefined,
      glowStrip: undefined,
      glowKey: "",
      layout: [],
      trackStrip: undefined,
      paint,
      look,
      // A new wire is at its paint at once: it does not fade in from nothing.
      opacity: { from: paint.opacity, to: paint.opacity, since: now, ms: 0 },
      trackAlpha: { from: paint.track === undefined ? 0 : 1, to: paint.track === undefined ? 0 : 1, since: now, ms: 0 },
      glowAlpha: { from: 0, to: 0, since: now, ms: 0 },
      glowPasses: [],
      colour: colourOf(fact.row.verb),
      settling: false,
      pulse: undefined,
    };
    entries.set(fact.id, entry);
    coneWires = undefined;
    rebuild(entry, now);
    refreshPaint(entry, now);
  };

  const removeWire = (id: WireId): void => {
    const entry = entries.get(id);
    if (entry === undefined) return;
    pool.free(entry.strip);
    glowPool.free(entry.glowStrip);
    trackPool.free(entry.trackStrip);
    if (entry.pulse !== undefined) clearPulse(entry);
    entries.delete(id);
    slots.release(entry.slot, 1);
    // A freed record must not draw: it is zero.
    records.fill(0, entry.slot * RECORD_FLOATS, (entry.slot + 1) * RECORD_FLOATS);
    dirtyRecords.mark(entry.slot * RECORD_FLOATS, (entry.slot + 1) * RECORD_FLOATS);
    if (entry.layout.length > 0) tracksDirty = true;
    coneWires = undefined;
    pickList = undefined;
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
      case "routes": {
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
        return;
      }
      case "selection":
        selection = op.fact;
        coneWires = undefined;
        refreshAll(now);
        return;
      case "theme": {
        mode = op.mode;
        for (const entry of entries.values()) {
          entry.colour = colourOf(entry.fact.row.verb);
          writeRecord(entry, now);
        }
        syncPreview();
        return;
      }
      case "wireMode":
        wireMode = op.mode;
        refreshAll(now);
        return;
      case "preview":
        preview = op.preview === null ? null : { from: op.preview.from, fromSide: op.preview.fromSide, to: op.preview.to };
        syncPreview();
        refreshAll(now);
        return;
      case "pulse": {
        const entry = entries.get(op.wireId);
        if (entry === undefined || activePulses >= WIRE_PULSE_MAX_ACTIVE) return;
        entry.pulse = { startedAt: op.at, kind: op.pulse ?? PULSE_KIND_DEFAULT, reverse: op.reverse ?? false };
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
    for (const entry of entries.values()) {
      if (entry.layout.length > 0 && entry.paint.track !== undefined && inView(entry)) return true;
    }
    return false;
  };

  const stepMotion = (at: number): boolean => {
    let moving = false;
    activePulses = 0;
    pulseDraws = [];
    for (const entry of entries.values()) {
      const easing = !tweenDone(entry.opacity, at) || !tweenDone(entry.trackAlpha, at) || !tweenDone(entry.glowAlpha, at);
      // The frame a transition ends writes its final value, once.
      if (easing || entry.settling) {
        entry.settling = easing;
        if (!easing && entry.glowAlpha.to === 0 && entry.glowStrip !== undefined) {
          // A finished fade-out frees the glow strip.
          entry.glowPasses = [];
          syncGlowStrip(entry);
        }
        writeRecord(entry, at);
        if (easing && inView(entry)) moving = true;
      }
      const pulse = entry.pulse;
      if (pulse !== undefined) {
        const length = entry.line?.length ?? 0;
        const token = tokenRgba(pulseToken(pulse.kind), mode);
        const folded = entry.paint.pulseOpacity;
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
    }
    return moving;
  };

  const frame: WireScene["frame"] = (f) => {
    camera = f.camera;
    zoom = f.camera.zoom;
    pixelRatio = f.pixelRatio;
    viewSize = { width: f.width, height: f.height };
    wall = f.wall;
    now = f.wall;
    if (f.tier !== tier) {
      tier = f.tier;
      refreshAll(now);
      relayoutTracks();
    }
    // Ends that moved (a drag, a model move, a card that arrived) rebuild their wires.
    for (const entry of entries.values()) {
      const { ends } = readEnds(entry);
      if (!sameEnds(ends, entry.ends)) rebuild(entry, now);
    }
    if (tracksDirty) rebuildTracks();
    return stepMotion(now) || tracksMove();
  };

  const busy: WireScene["busy"] = (at) => {
    if (tracksMove()) return true;
    for (const entry of entries.values()) {
      if (!inView(entry)) continue;
      if (!tweenDone(entry.opacity, at) || !tweenDone(entry.trackAlpha, at) || !tweenDone(entry.glowAlpha, at)) return true;
      if (entry.pulse !== undefined) return true;
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
    };
  };

  // --- picking ---------------------------------------------------------------------

  const pick: WireScene["pick"] = (at) => {
    if (pickList === undefined) {
      // The pool draws as one indexed triangle strip, in index order, so the
      // strip with the higher start covers the lower one where they overlap.
      // Sort by that order: entries iteration is insertion order, and a freed
      // run can hand a later wire a lower start than an earlier wire.
      const ordered: Array<{ start: number; candidate: PickCandidate<WireId> }> = [];
      for (const entry of entries.values()) {
        if (!entry.paint.pickable || entry.line === undefined || entry.route === undefined || entry.strip === undefined) continue;
        ordered.push({
          start: entry.strip.start,
          candidate: {
            id: entry.id,
            line: entry.line,
            hitHalfWidth: entry.route.hitHalfWidth,
            ...(entry.bounds ? { bounds: entry.bounds } : {}),
          },
        });
      }
      ordered.sort((a, b) => a.start - b.start);
      pickList = ordered.map((item) => item.candidate);
    }
    return pickWire(pickList, at)?.id;
  };

  const labelOf: WireScene["labelOf"] = (id) => {
    const entry = entries.get(id);
    if (entry?.line === undefined || entry.route === undefined) return undefined;
    // An elbow's label is React Flow's, on its longest run; a route's is its midpoint.
    return entry.route.kind === "elbow" ? entry.route.label : pointAt(entry.line, entry.line.length / 2);
  };

  const inspect: WireScene["inspect"] = (id) => {
    const entry = entries.get(id);
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
      }
    },
    frame,
    busy,
    uniforms,
    pick,
    labelOf,
    inspect,
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
