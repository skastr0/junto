/**
 * Per-wire style facts: which token colours a wire, how opaque it is in each
 * way wires are shown, when it glows and how, whether it can be picked, and
 * how a track and a pulse on it are painted. Every number is today's, read
 * from the stylesheet that paints wires now (receipts beside each), or a
 * theme token (`GLOW`, `DURATION`, `EASING`, the `wire-*` colours).
 *
 * These are per-wire or global values, never a rebuild: a mode change or a
 * selection rewrites a wire's record, not its strip.
 *
 * Pure. No DOM.
 */

import type { TaskPathVerb, Verb } from "@shared/physics";
import type { WireTrafficKind } from "@shared/wire-traffic";
import { DURATION, EASING, GLOW, themeRuntime, type GlowLayer, type ThemeMode } from "@shared/theme";
import { WIRE_WIDTH } from "@window/lib/flow-track";
import { WIRE_PULSE_TOKEN } from "@window/lib/wire-pulse";
import type { CanvasTier, WireMode } from "../../contract";

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/**
 * A verb's theme token. factory-grammar.css:173-189 maps each
 * `--wire-verb-<verb>` (physics/verbs.ts VERB_COLOR_TOKEN) to
 * `var(--color-wire-<verb>)`; these are those `wire-*` tokens.
 */
export const WIRE_TOKEN: Readonly<Record<Verb, string>> = {
  messages: "wire-messages",
  navigates: "wire-navigates",
  flows: "wire-flows",
  derives: "wire-derives",
};
/** No verb compiled: neutral ink (WireEdge.tsx:49-50). */
export const WIRE_UNSET_TOKEN = "wire-unset";

export const isTrackVerb = (verb: Verb | undefined): verb is TaskPathVerb => verb === "flows" || verb === "derives";

export const wireToken = (verb: Verb | undefined): string => (verb ? WIRE_TOKEN[verb] : WIRE_UNSET_TOKEN);

/** A pulse's token by its kind (wire-pulse.ts WIRE_PULSE_TOKEN, as theme token names). */
export const pulseToken = (kind: WireTrafficKind): string => WIRE_PULSE_TOKEN[kind].replace(/^--color-/, "");

/** Straight-alpha sRGB, 0 to 1. */
export type Rgba = readonly [r: number, g: number, b: number, a: number];

const runtime = new Map<ThemeMode, Record<string, string>>();

/** A token as the theme resolves it for `mode` (`themeRuntime`, its hex as it is). */
export const tokenRgba = (token: string, mode: ThemeMode): Rgba => {
  let map = runtime.get(mode);
  if (!map) {
    map = themeRuntime(mode);
    runtime.set(mode, map);
  }
  const hex = map[token];
  if (hex === undefined) throw new Error(`wires: no theme token ${token}`);
  const digits = hex.slice(1);
  const channel = (index: number): number => parseInt(digits.slice(index * 2, index * 2 + 2), 16) / 255;
  return [channel(0), channel(1), channel(2), digits.length >= 8 ? channel(3) : 1];
};

// ---------------------------------------------------------------------------
// How wires are shown
// ---------------------------------------------------------------------------

/** The hairline's weight (WireEdge.tsx:127, `BORDER.wire`), and half of it, what a strip is built at. */
export const WIRE_HALF_WIDTH = WIRE_WIDTH / 2;

/** At rest a wire is ground (factory-grammar.css:222-224). */
export const REST_OPACITY = 0.07;
/** Loupe held or a wire being drawn (factory-grammar.css:225-227). */
export const SHOWN_OPACITY = 0.9;
/** In the cone, and selected (factory-grammar.css:228-230, :251-253). */
export const FULL_OPACITY = 1;
/** Outside the cone while a focus mode is on, on the whole wire (styles.css:1180-1183). */
export const OUTSIDE_CONE_OPACITY = 0.12;
/** The far tier steps wires back (canvas-lod-regions.css:92-94). */
export const FAR_STROKE_OPACITY = 0.4;

/**
 * The global facts that decide how every wire is shown. Today these are
 * independent switches on the React Flow root and `html`: the loupe
 * (`data-wires="shown"`, CanvasMagnifier.tsx:397-409), a connect in progress
 * (`.is-connecting`, Canvas.tsx:1560), a focus mode (`.impact-mode` or
 * `.connection-focus-mode`, styles.css:1180-1188) and the tier.
 */
export type WireView = {
  readonly loupe: boolean;
  readonly connecting: boolean;
  readonly focus: boolean;
  readonly tier: CanvasTier;
};

export const REST_VIEW: WireView = { loupe: false, connecting: false, focus: false, tier: "near" };

/**
 * The contract's single `WireMode` as a view. `far` and `overview` are tiers,
 * so a loupe at far is `{ ...viewOfMode("loupe"), tier: "far" }`.
 */
export const viewOfMode = (mode: WireMode, tier: CanvasTier = "near"): WireView => {
  switch (mode) {
    case "rest":
      return { ...REST_VIEW, tier };
    case "loupe":
      return { ...REST_VIEW, loupe: true, tier };
    case "connecting":
      return { ...REST_VIEW, connecting: true, tier };
    case "cone":
      return { ...REST_VIEW, focus: true, tier };
    case "far":
      return { ...REST_VIEW, tier: "far" };
    case "overview":
      return { ...REST_VIEW, tier: "overview" };
  }
};

/** What one wire brings to its paint. */
export type WireLook = {
  readonly verb?: Verb;
  readonly selected: boolean;
  readonly hovered: boolean;
  /** In the focus cone (`impact-edge-in`); meaningful only while a focus mode is on. */
  readonly inCone: boolean;
};

/** A soft pass drawn under a wire or a track: today's `drop-shadow`, in its own hue. */
export type GlowPass = {
  /** The Gaussian's standard deviation, board units. */
  readonly sigma: number;
  /** Peak alpha, the wire's own opacity already folded in. */
  readonly alpha: number;
};

/**
 * Board units of Gaussian deviation per unit of a `drop-shadow` blur
 * length. Filter Effects defines the filter's blur length as the standard
 * deviation (box-shadow's is twice it). Not measured against Chromium's paint.
 */
export const GLOW_SIGMA_PER_BLUR = 1;

const passes = (layers: ReadonlyArray<GlowLayer>, alpha: number): GlowPass[] =>
  layers.map((layer) => ({ sigma: layer.blur * GLOW_SIGMA_PER_BLUR, alpha: (layer.alpha ?? 1) * alpha }));

export type WirePaint = {
  /** The hairline's colour token. */
  readonly token: string;
  /** The hairline's alpha: path opacity, stroke opacity and the wire's group opacity multiplied. 0 is not drawn. */
  readonly opacity: number;
  /** Glow passes under the hairline, widest last; empty when it does not glow. */
  readonly glow: ReadonlyArray<GlowPass>;
  /** The wire takes the pointer (strokes are deaf at rest, factory-grammar.css:219-234). */
  readonly pickable: boolean;
  /** A flows or derives wire's track: opaque in every state and at every tier (FlowTrack.tsx:26-31). */
  readonly track?: { readonly token: string; readonly glow: ReadonlyArray<GlowPass> };
  /** A pulse's alpha on this wire; 0 hides it (drawn at near only, canvas-lod-regions.css:44-46). */
  readonly pulseOpacity: number;
};

/** One wire's paint in a view. */
export const wirePaint = (view: WireView, look: WireLook): WirePaint => {
  const track = isTrackVerb(look.verb);
  const coneIn = view.focus && look.inCone;
  const path = look.selected || coneIn ? FULL_OPACITY : view.loupe || view.connecting ? SHOWN_OPACITY : REST_OPACITY;
  // A track wire's hairline is unpainted (factory-grammar.css:262-265); far steps the stroke back.
  const stroke = track ? 0 : view.tier === "far" ? FAR_STROKE_OPACITY : 1;
  const group = view.focus && !look.inCone ? OUTSIDE_CONE_OPACITY : 1;
  // Overview hides every wire but a track's (canvas-lod-regions.css:109-117).
  const visible = view.tier !== "overview" || track;
  const opacity = visible ? path * stroke * group : 0;
  const pickable = visible && (view.loupe || coneIn);
  // The filter is on the path, so its glow is faded with it; a track's
  // hairline never glows (filter: none), its track does instead.
  const glow = track
    ? []
    : look.selected
      ? passes(GLOW["wire-selected"], opacity)
      : look.hovered && pickable
        ? passes(GLOW["wire-hover"], opacity)
        : [];
  return {
    token: wireToken(look.verb),
    opacity,
    glow,
    pickable,
    track: track
      ? { token: WIRE_TOKEN[look.verb as TaskPathVerb], glow: look.selected ? passes(GLOW["track-selected"], 1) : [] }
      : undefined,
    pulseOpacity: view.tier === "near" ? (view.focus && !look.inCone ? OUTSIDE_CONE_OPACITY : 1) : 0,
  };
};

// ---------------------------------------------------------------------------
// Glow coverage, for the shader to match
// ---------------------------------------------------------------------------

/** Error function, Abramowitz and Stegun 7.1.26 (absolute error under 1.5e-7). */
export const erf = (x: number): number => {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
};

/**
 * A blurred stroke's coverage at `distance` from its centreline: the stroke
 * (half width `halfWidth`) convolved with a Gaussian of deviation `sigma`
 * across its run. At a round cap the distance is to the end point.
 */
export const glowCoverage = (distance: number, halfWidth: number, sigma: number): number => {
  if (sigma <= 0) return Math.abs(distance) <= halfWidth ? 1 : 0;
  const k = sigma * Math.SQRT2;
  return 0.5 * (erf((distance + halfWidth) / k) - erf((distance - halfWidth) / k));
};

/** Gaussian reach worth drawing: three deviations past the stroke. */
export const GLOW_REACH = 3;

/** The half width a glow strip is built at for these passes. */
export const glowHalfWidth = (glow: ReadonlyArray<GlowPass>, halfWidth = WIRE_HALF_WIDTH): number =>
  glow.reduce((max, pass) => Math.max(max, halfWidth + GLOW_REACH * pass.sigma), halfWidth);

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export type WireTransition = { readonly ms: number; readonly easing: readonly [number, number, number, number] };

/**
 * How a wire's state changes ease today (factory-grammar.css:202-205): its
 * colour, its glow and its opacity. None under reduced motion (:257-259).
 */
export const WIRE_TRANSITIONS: Readonly<Record<"color" | "glow" | "opacity", WireTransition>> = {
  color: { ms: DURATION["wire-stroke"], easing: EASING.wire },
  glow: { ms: DURATION["wire-filter"], easing: EASING.out },
  opacity: { ms: DURATION["wire-opacity"], easing: EASING.out },
};
