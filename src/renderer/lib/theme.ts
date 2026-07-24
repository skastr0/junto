import type { EtherEdgeKind } from "@shared/canvas";

// Deep-field palette — the TS mirror of the `@theme` block in styles.css
// (Tailwind utilities) for runtime consumers: canvas paint, xterm themes,
// inline styles. One palette, two projections — never a second source.
// Ground is never pure black. Roughly 95% amber, sparse others. Crimson is
// reserved for blockers only.
export const HUE = {
  amber: "#E8A33D",
  cyan: "#39C6D6",
  violet: "#8B7BEB",
  crimson: "#E5484D",
  steel: "#8FA3B0",
  indigo: "#6E7BF2",
  gold: "#D4A94F",
  orange: "#F07438",
} as const;

export const GROUND = "#0c0b0a";
export const RAISE = "#16130f";
export const RAISE_2 = "#141210";
export const INSET = "#131110";
export const WELL = "#090807";
export const INK = "#EDE6DA";
export const INK_2 = "#c8c0b0";
export const DIM = "#8a8378";
export const FAINT = "#68604a";
export const GREEN = "#5FB98E";

// Translucent card fill — wireframe over solid.
export const CARD_FILL = "rgba(255,255,255,0.03)";
export const CARD_FILL_HI = "rgba(255,255,255,0.05)";
export const STROKE = "rgba(237,230,218,0.14)";
export const STROKE_HI = "rgba(237,230,218,0.28)";

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
