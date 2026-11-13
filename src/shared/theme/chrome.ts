// Non-colour paint tokens: shadow geometry, border widths, motion durations
// and easings — the values index.ts noted had "no tokens yet". They are
// mode-independent: the same in dark and bright. Only a shadow layer's
// colour follows the mode, through the token name the layer carries.
//
// Two projections read them:
//   - theme.generated.css: --shadow-*, --border-*, --duration-*, --ease-*
//     (scripts/theme-build.ts)
//   - the GPU canvas: themeGpu(mode) carries the same constants, with each
//     layer's `color` naming a semantic token resolved through
//     themeGpu(mode).colors.
//
// A layer whose colour is chosen at paint time (a node's accent, a region's
// urgency hue, a wire's verb) leaves `color` unset and names the CSS custom
// property that carries it in `cssColor`, so the emitted --shadow-* still
// resolves in the DOM. The GPU painter supplies that colour itself.

/** One layer of a box-shadow, in the CSS order: offset, blur, spread,
 *  colour, with `inset` for inner shadows. A zero blur with a spread is a
 *  ring; the cluster stack's negative spreads are spacer rings. */
export interface ShadowLayer {
  readonly dx: number;
  readonly dy: number;
  readonly blur: number;
  readonly spread: number;
  /** Theme token name for the layer colour; absent = paint-time colour. */
  readonly color?: string;
  /** CSS expression for a paint-time colour, emitted in place of a token. */
  readonly cssColor?: string;
  /** The layer's share — the `color-mix(in oklab, X N%, transparent)` pct,
   *  as a fraction 0 to 1. */
  readonly alpha?: number;
  readonly inset?: boolean;
}

/** One pass of a drop-shadow() filter: offset and blur. Wires glow this
 *  way, never with box-shadow, so `spread` and `inset` do not exist here. */
export interface GlowLayer {
  readonly dx: number;
  readonly dy: number;
  readonly blur: number;
  readonly color?: string;
  readonly cssColor?: string;
  readonly alpha?: number;
}

// --- box-shadow specs -------------------------------------------------------

export const SHADOW = {
  /** The card's resting drop. */
  card: [{ dx: 0, dy: 10, blur: 28, spread: 0, color: "shadow-2" }],
  /** The lifted drop: selected cards and focus roots. */
  "card-lift": [{ dx: 0, dy: 12, blur: 30, spread: 0, color: "shadow-2" }],
  /** Kind-seat selection and the seat cluster's member list. */
  seat: [{ dx: 0, dy: 8, blur: 22, spread: 0, color: "shadow-2" }],
  /** Preamble bubble. */
  bubble: [{ dx: 0, dy: 6, blur: 18, spread: 0, color: "shadow-2" }],
  /** Blocked card: crimson ring and glow (the ::after rim is a border). */
  blocker: [
    { dx: 0, dy: 0, blur: 0, spread: 2, color: "accent", alpha: 0.22 },
    { dx: 0, dy: 0, blur: 12, spread: 0, color: "accent", alpha: 0.12 },
  ],
  /** Attention card: amber ring, glow band and the resting drop. */
  attention: [
    { dx: 0, dy: 0, blur: 0, spread: 2, color: "main", alpha: 0.55 },
    { dx: 0, dy: 0, blur: 18, spread: 2, color: "main", alpha: 0.18 },
    { dx: 0, dy: 10, blur: 28, spread: 0, color: "shadow-2" },
  ],
  /** Impact-mode focus root. */
  "focus-impact-root": [
    { dx: 0, dy: 0, blur: 0, spread: 1, color: "accent", alpha: 0.45 },
    { dx: 0, dy: 0, blur: 18, spread: 0, color: "accent", alpha: 0.22 },
    { dx: 0, dy: 12, blur: 30, spread: 0, color: "shadow-2" },
  ],
  /** Connection-focus root. */
  "focus-connection-root": [
    { dx: 0, dy: 0, blur: 0, spread: 1, color: "second", alpha: 0.48 },
    { dx: 0, dy: 0, blur: 18, spread: 0, color: "second", alpha: 0.22 },
    { dx: 0, dy: 12, blur: 30, spread: 0, color: "shadow-2" },
  ],
  /** Impact-mode member: ring and the resting drop. */
  "focus-impact-member": [
    { dx: 0, dy: 0, blur: 0, spread: 1, color: "accent", alpha: 0.22 },
    { dx: 0, dy: 10, blur: 28, spread: 0, color: "shadow-2" },
  ],
  /** Connection-focus member. */
  "focus-connection-member": [
    { dx: 0, dy: 0, blur: 0, spread: 1, color: "second", alpha: 0.26 },
    { dx: 0, dy: 10, blur: 28, spread: 0, color: "shadow-2" },
  ],
  /** NodeResizer handle halo. */
  resize: [{ dx: 0, dy: 0, blur: 0, spread: 3, color: "main", alpha: 0.08 }],
  /** Seat cluster stack: two offset ring pairs over raise spacers. The rim
   *  colour is the cluster's state hue, set as --cluster-rim on the element. */
  cluster: [
    { dx: 5, dy: -5, blur: 0, spread: -2, color: "raise" },
    { dx: 5, dy: -5, blur: 0, spread: 0, cssColor: "var(--cluster-rim)" },
    { dx: 10, dy: -10, blur: 0, spread: -4, color: "raise" },
    {
      dx: 10,
      dy: -10,
      blur: 0,
      spread: -2,
      cssColor: "var(--cluster-rim)",
      alpha: 0.6,
    },
  ],
  /** Reach preview ring and glow while dragging. */
  reach: [
    { dx: 0, dy: 0, blur: 0, spread: 2, cssColor: "var(--reach-hue)" },
    { dx: 0, dy: 0, blur: 18, spread: 0, cssColor: "var(--reach-hue)", alpha: 0.4 },
  ],
  /** The reach ring at far tiers. */
  "reach-far": [{ dx: 0, dy: 0, blur: 0, spread: 8, cssColor: "var(--reach-hue)" }],
  /** Region urgency, direct reach: hairline frame and faint inner glow. */
  "region-urgency": [
    {
      dx: 0,
      dy: 0,
      blur: 0,
      spread: 1.5,
      cssColor: "var(--urgency)",
      alpha: 0.5,
      inset: true,
    },
    {
      dx: 0,
      dy: 0,
      blur: 28,
      spread: 0,
      cssColor: "var(--urgency)",
      alpha: 0.09,
      inset: true,
    },
  ],
  /** Region urgency, held reach. */
  "region-urgency-held": [
    {
      dx: 0,
      dy: 0,
      blur: 0,
      spread: 1,
      cssColor: "var(--urgency)",
      alpha: 0.28,
      inset: true,
    },
  ],
  /** Region urgency at far tiers, drawn in canvas units. */
  "region-urgency-far": [
    {
      dx: 0,
      dy: 0,
      blur: 0,
      spread: 6,
      cssColor: "var(--urgency)",
      alpha: 0.52,
      inset: true,
    },
    {
      dx: 0,
      dy: 0,
      blur: 110,
      spread: 0,
      cssColor: "var(--urgency)",
      alpha: 0.11,
      inset: true,
    },
  ],
  "region-urgency-held-far": [
    {
      dx: 0,
      dy: 0,
      blur: 0,
      spread: 4,
      cssColor: "var(--urgency)",
      alpha: 0.3,
      inset: true,
    },
  ],
  /** Verb landing zone while a wire is drawn: inset ring in the verb hue. */
  "verb-zone": [
    {
      dx: 0,
      dy: 0,
      blur: 0,
      spread: 1,
      cssColor: "var(--zone-hue)",
      alpha: 0.45,
      inset: true,
    },
  ],
} satisfies Record<string, readonly ShadowLayer[]>;

// --- drop-shadow() filter specs ----------------------------------------------
// The DOM keeps `filter: drop-shadow(...)`; these carry the same geometry for
// the GPU painter, whose wire bloom is a soft wider pass (architecture §13).

export const GLOW = {
  /** Wire hovered: a breath of its own hue. */
  "wire-hover": [
    { dx: 0, dy: 0, blur: 2, cssColor: "var(--wire-hue)", alpha: 0.5 },
  ],
  /** Wire selected: tight core plus a wider bloom. */
  "wire-selected": [
    { dx: 0, dy: 0, blur: 1, cssColor: "var(--wire-hue)" },
    { dx: 0, dy: 0, blur: 5, cssColor: "var(--wire-hue)", alpha: 0.6 },
  ],
  /** A selected flows track blooms in its own ink (currentColor). */
  "track-selected": [
    { dx: 0, dy: 0, blur: 2, cssColor: "currentColor", alpha: 0.6 },
  ],
} satisfies Record<string, readonly GlowLayer[]>;

// --- border widths ------------------------------------------------------------

export const BORDER = {
  /** 1px — the default edge: cards, chips, tags, callouts, zones, labels. */
  hairline: 1,
  /** 1.5px — spine tags, rows and ticks; far discs; plates; stalled ring. */
  bold: 1.5,
  /** 2px — pips, focus rings, state rings, the reach "loses" outline. */
  heavy: 2,
  /** 2.5px — the blocked occupancy ring. */
  "blocked-ring": 2.5,
  /** 3px — the far seat's selected ring, per seat scale. */
  "seat-selected": 3,
  /** 4px — the far card's selected outline. */
  "card-selected": 4,
  /** Region frames in canvas units: mid, far, overview. */
  "region-mid": 3,
  "region-far": 6,
  "region-overview": 10,
  /** The reach "loses" outline at far tiers. */
  "reach-far": 8,
  /** Wire stroke widths (lib/flow-track.ts reads these). */
  wire: 1.2,
  "wire-track": 1.8,
} as const;

// --- motion -------------------------------------------------------------------

/** Durations in milliseconds. The .18s/.16s/.15s values are the app's
 *  standard state, quick and fade eases; the rest are named for the motion
 *  they drive. */
export const DURATION = {
  /** .18s ease — paint state changes: card chrome, focus dim. */
  state: 180,
  /** .16s — the short ease: hover lift, titlebar, ring and cluster settles. */
  quick: 160,
  /** .15s — small fades: handles, edge labels, bubble close. */
  fade: 150,
  /** Verb landing zones. */
  zone: 120,
  /** Wire stroke colour transitions. */
  "wire-stroke": 420,
  /** Wire glow (drop-shadow filter) transitions. */
  "wire-filter": 160,
  /** Wire opacity transitions. */
  "wire-opacity": 240,
  /** Flows track period: one slide of the chevrons. */
  flow: 450,
  /** Derives track breath period. */
  breathe: 1600,
  /** Wire pulse travel. */
  pulse: 900,
  /** Reduced-motion pulse hold. */
  "pulse-hold": 700,
  /** Reach preview breathe period. */
  reach: 1440,
  /** Entrance motions: the preamble bubble's rise. */
  enter: 200,
} as const;

/** Cubic-bezier control points [x1, y1, x2, y2]. `standard`, `out` and
 *  `in-out` are the CSS ease keywords; `linear` is the linear keyword. */
export const EASING = {
  /** CSS `ease`. */
  standard: [0.25, 0.1, 0.25, 1],
  /** CSS `ease-out`. */
  out: [0, 0, 0.58, 1],
  /** CSS `ease-in-out`. */
  "in-out": [0.42, 0, 0.58, 1],
  /** CSS `linear`. */
  linear: [0, 0, 1, 1],
  /** Wire stroke transitions. */
  wire: [0.22, 0.61, 0.36, 1],
  /** Wire pulse travel. */
  pulse: [0.45, 0, 0.55, 1],
  /** Ring-size and cluster settles — the FLIP ease (canvas-tier.ts). */
  settle: [0.33, 1, 0.68, 1],
  /** Entrances: the preamble bubble's rise. */
  enter: [0.22, 1, 0.36, 1],
} as const;

/** The easing as a CSS `cubic-bezier()` string, for WAAPI callers that take
 *  the keyword form (canvas-tier.ts's seat-ring ease). */
export const easingCss = (name: keyof typeof EASING): string => {
  const [x1, y1, x2, y2] = EASING[name];
  return `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`;
};
