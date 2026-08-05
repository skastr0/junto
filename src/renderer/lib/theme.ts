import type { EtherEdgeKind } from "@shared/canvas";
import { themeRuntime, type ThemeMode } from "@shared/theme";

// Runtime projection of the single token source (src/shared/theme/) for
// canvas paint, xterm themes, and inline styles. One palette, one source —
// this module only re-shapes it for renderer consumers and keeps the
// long-standing export names stable. `themeFor(mode)` serves mode-aware
// consumers; the bare constants are the dark mode, the app's default.
// Ground is never pure black. Roughly 95% amber, sparse others. Crimson is
// reserved for blockers only.

const dark = themeRuntime("dark");

export const themeFor = (mode: ThemeMode): Record<string, string> =>
  themeRuntime(mode);

export const HUE = {
  amber: dark.amber!,
  cyan: dark.cyan!,
  violet: dark.violet!,
  crimson: dark.crimson!,
  steel: dark.steel!,
  indigo: dark.indigo!,
  gold: dark.gold!,
  orange: dark.orange!,
} as const;

export const GROUND = dark.ground!;
export const RAISE = dark.raise!;
export const RAISE_2 = dark["raise-2"]!;
export const INSET = dark.inset!;
export const WELL = dark.well!;
export const INK = dark.ink!;
export const INK_2 = dark["ink-2"]!;
export const DIM = dark.dim!;
export const FAINT = dark.faint!;
export const GREEN = dark.green!;

// Translucent card fill — ink at low alpha over the field.
export const CARD_FILL = dark["overlay-1"]!;
export const CARD_FILL_HI = dark["overlay-2"]!;
export const STROKE = dark.stroke!;
export const STROKE_HI = dark["stroke-hi"]!;

// JSON Canvas 1.0 color presets '1'..'6'.
const PRESET: Record<string, string> = {
  "1": HUE.crimson, // red
  "2": HUE.orange, // orange
  "3": HUE.gold, // yellow
  "4": GREEN, // green
  "5": HUE.cyan, // cyan
  "6": HUE.violet, // purple
};

export const accentColor = (color?: string): string => {
  if (!color) return HUE.amber;
  if (color.startsWith("#")) return color;
  return PRESET[color] ?? HUE.amber;
};

// Resolve a JSON Canvas color (preset digit or hex) to a border tint. Absent
// color falls back to the house amber, kept translucent so it stays quiet.
export const borderColor = (color?: string, emphasized = false): string => {
  if (color?.startsWith("#")) return color;
  return withAlpha(accentColor(color), emphasized ? 0.5 : 0.32);
};

export const EDGE_COLOR: Record<EtherEdgeKind, string> = {
  blocks: HUE.crimson,
  relates: HUE.steel,
};

export function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Per-source accent for entity chips / status dots. Live plane is hermes-only.
export const SOURCE_HUE: Record<string, string> = {
  hermes: HUE.orange,
};
