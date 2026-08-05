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

// Hues as CSS variable references so inline style colors resolve against the
// active theme mode. Canvas 2D consumers use themeFor(mode) directly.
export const HUE = {
  amber: "var(--color-amber)",
  cyan: "var(--color-cyan)",
  violet: "var(--color-violet)",
  crimson: "var(--color-crimson)",
  steel: "var(--color-steel)",
  indigo: "var(--color-indigo)",
  gold: "var(--color-gold)",
  orange: "var(--color-orange)",
} as const;

// Ground-to-ink ladder. CSS variable references so these resolve against the
// active theme mode (dark/bright) in inline styles instead of freezing to
// dark-mode hexes at module load. Canvas 2D consumers use themeFor(mode)
// directly.
export const GROUND = "var(--color-ground)";
export const RAISE = "var(--color-raise)";
export const RAISE_2 = "var(--color-raise-2)";
export const INSET = "var(--color-inset)";
export const WELL = "var(--color-well)";
export const INK = "var(--color-ink)";
export const INK_2 = "var(--color-ink-2)";
export const DIM = "var(--color-dim)";
export const FAINT = "var(--color-faint)";
export const GREEN = "var(--color-green)";

// Translucent card fill — ink at low alpha over the field.
export const CARD_FILL = "var(--color-overlay-1)";
export const CARD_FILL_HI = "var(--color-overlay-2)";
export const STROKE = "var(--color-stroke)";
export const STROKE_HI = "var(--color-stroke-hi)";

// JSON Canvas 1.0 color presets '1'..'6'. Return CSS variable references so
// they resolve against the active theme mode (dark/bright) rather than being
// frozen to dark-mode hex values at module load.
const PRESET: Record<string, string> = {
  "1": "var(--color-crimson)", // red
  "2": "var(--color-orange)", // orange
  "3": "var(--color-gold)", // yellow
  "4": "var(--color-green)", // green
  "5": "var(--color-cyan)", // cyan
  "6": "var(--color-violet)", // purple
};

export const accentColor = (color?: string): string => {
  if (!color) return "var(--color-main)";
  if (color.startsWith("#")) return color;
  return PRESET[color] ?? "var(--color-main)";
};

// Resolve a JSON Canvas color (preset digit or hex) to a border tint. Absent
// color falls back to stroke (ink-at-N%) which is defined per mode. Emphasized
// state (selected/focused) uses the hi variant. Custom hex colors keep the old
// withAlpha path so they remain usable with JS color manipulation.
export const borderColor = (color?: string, emphasized = false): string => {
  if (color?.startsWith("#")) return color;
  if (!color) return emphasized ? "var(--color-stroke-hi)" : "var(--color-stroke)";
  return withAlpha(accentColor(color), emphasized ? 0.5 : 0.32);
};

export const EDGE_COLOR: Record<EtherEdgeKind, string> = {
  blocks: "var(--color-crimson)",
  relates: "var(--color-steel)",
};

export function withAlpha(color: string, alpha: number): string {
  // CSS variable references resolve through color-mix, allowing borders and
  // shadows to pick up the active theme mode (dark/bright) automatically.
  if (color.startsWith("var(")) {
    return `color-mix(in oklab, ${color} ${Math.round(alpha * 100)}%, transparent)`;
  }
  const clean = color.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Per-source accent for entity chips / status dots. Live plane is hermes-only.
export const SOURCE_HUE: Record<string, string> = {
  hermes: "var(--color-orange)",
};
