import type { Oklch } from "./oklch";
import { HUES, NEUTRALS } from "./primitives";

// Semantic layer — the only tier components may consume. Dark assigns today's
// exact appearance; bright is a second value assignment over the same names,
// not a mechanical inversion.
//
// Value kinds:
//   solid — an OKLCH primitive
//   mix   — another token at N% (emitted as color-mix / rgba); these resolve
//           against the active mode, so strokes, overlays, and scrims need no
//           bright override: ink-at-14% is a hairline in both worlds
//   alias — a role name pointing at a hue (main -> amber, …)
//
// The bright override map lists only what genuinely differs: neutrals, hues,
// umbra, and shadow strength (shadows return on paper; dark carries depth
// with surface-lightness steps instead).

export type TokenValue =
  | { kind: "solid"; value: Oklch }
  | { kind: "mix"; token: string; pct: number }
  | { kind: "alias"; token: string };

const solid = (value: Oklch): TokenValue => ({ kind: "solid", value });
const mix = (token: string, pct: number): TokenValue => ({
  kind: "mix",
  token,
  pct,
});
const alias = (token: string): TokenValue => ({ kind: "alias", token });

const darkNeutrals = NEUTRALS.dark;
const darkHues = HUES.dark;

export const SEMANTIC_DARK: Record<string, TokenValue> = {
  // field + elevation ladder
  ground: solid(darkNeutrals.ground),
  raise: solid(darkNeutrals.raise),
  "raise-2": solid(darkNeutrals["raise-2"]),
  inset: solid(darkNeutrals.inset),
  well: solid(darkNeutrals.well),

  // ink ladder
  ink: solid(darkNeutrals.ink),
  "ink-2": solid(darkNeutrals["ink-2"]),
  dim: solid(darkNeutrals.dim),
  faint: solid(darkNeutrals.faint),

  // hairline strokes + overlays (ink at low alpha, never greys)
  stroke: mix("ink", 14),
  "stroke-hi": mix("ink", 28),
  "overlay-1": mix("ink", 3),
  "overlay-2": mix("ink", 5),
  "overlay-3": mix("ink", 7),
  "overlay-4": mix("ink", 10),

  // scrims + shadows (toward ground/umbra)
  backdrop: mix("ground", 72),
  umbra: solid(darkNeutrals.umbra),
  "shadow-1": mix("umbra", 55),
  "shadow-2": mix("umbra", 42),

  // interaction
  "focus-ring": mix("second", 10),
  selection: mix("main", 28),
  "selection-inactive": mix("main", 16),

  // hues
  amber: solid(darkHues.amber),
  "amber-hi": solid(darkHues["amber-hi"]),
  "amber-fg": solid(darkHues["amber-fg"]),
  cyan: solid(darkHues.cyan),
  "cyan-fg": solid(darkHues["cyan-fg"]),
  crimson: solid(darkHues.crimson),
  "crimson-fg": solid(darkHues["crimson-fg"]),
  violet: solid(darkHues.violet),
  steel: solid(darkHues.steel),
  indigo: solid(darkHues.indigo),
  gold: solid(darkHues.gold),
  orange: solid(darkHues.orange),
  green: solid(darkHues.green),

  // color roles — the names primitives compose against
  main: alias("amber"),
  "main-hi": alias("amber-hi"),
  "main-fg": alias("amber-fg"),
  second: alias("cyan"),
  "second-fg": alias("cyan-fg"),
  accent: alias("crimson"),
  "accent-fg": alias("crimson-fg"),
};

const brightNeutrals = NEUTRALS.bright;
const brightHues = HUES.bright;

// Only what differs from dark. Strokes flip by construction (ink-at-alpha);
// the rest of this map is the daylight edition's own assignments: on paper a
// scrim must DIM (toward umbra, not toward the paper), hover overlays need
// roughly double the ink to register, and the focus halo needs more presence.
export const SEMANTIC_BRIGHT_OVERRIDES: Record<string, TokenValue> = {
  ground: solid(brightNeutrals.ground),
  raise: solid(brightNeutrals.raise),
  "raise-2": solid(brightNeutrals["raise-2"]),
  inset: solid(brightNeutrals.inset),
  well: solid(brightNeutrals.well),
  ink: solid(brightNeutrals.ink),
  "ink-2": solid(brightNeutrals["ink-2"]),
  dim: solid(brightNeutrals.dim),
  faint: solid(brightNeutrals.faint),
  umbra: solid(brightNeutrals.umbra),
  "overlay-1": mix("ink", 5),
  "overlay-2": mix("ink", 8),
  "overlay-3": mix("ink", 11),
  "overlay-4": mix("ink", 14),
  backdrop: mix("umbra", 18),
  "focus-ring": mix("second", 22),
  "selection": mix("main-fg", 50),
  "selection-inactive": mix("main-fg", 30),
  // Strokes need more presence on bright — ink-at-14% is invisible on paper.
  stroke: mix("ink", 55),
  "stroke-hi": mix("ink", 70),
  // Shadows earn their keep on paper: softer than dark's occluding scrims,
  // warm-tinted via umbra.
  "shadow-1": mix("umbra", 28),
  "shadow-2": mix("umbra", 18),
  amber: solid(brightHues.amber),
  "amber-hi": solid(brightHues["amber-hi"]),
  "amber-fg": solid(brightHues["amber-fg"]),
  cyan: solid(brightHues.cyan),
  "cyan-fg": solid(brightHues["cyan-fg"]),
  crimson: solid(brightHues.crimson),
  "crimson-fg": solid(brightHues["crimson-fg"]),
  violet: solid(brightHues.violet),
  steel: solid(brightHues.steel),
  indigo: solid(brightHues.indigo),
  gold: solid(brightHues.gold),
  orange: solid(brightHues.orange),
  green: solid(brightHues.green),
};

export type ThemeMode = "dark" | "bright";

export const THEME_MODES: readonly ThemeMode[] = ["dark", "bright"];

export const semanticTokens = (mode: ThemeMode): Record<string, TokenValue> =>
  mode === "dark"
    ? SEMANTIC_DARK
    : { ...SEMANTIC_DARK, ...SEMANTIC_BRIGHT_OVERRIDES };
