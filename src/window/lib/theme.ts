import { canvasSwatchFor } from "@shared/canvas-colors";
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
  yellow: "var(--color-yellow)",
  lime: "var(--color-lime)",
  blue: "var(--color-blue)",
  pink: "var(--color-pink)",
} as const;

// The same hues as words. A hue painted as text takes its -fg form: the mark
// form is near 3 to 1 on the bright ground, and 2.5 to 3.8 on a chip's own tint
// in dark. Each of these clears 4.5 on its tint over every surface (theme-build
// reports it).
export const HUE_TEXT = {
  amber: "var(--color-amber-fg)",
  cyan: "var(--color-cyan-fg)",
  crimson: "var(--color-crimson-fg)",
  violet: "var(--color-violet-fg)",
  steel: "var(--color-steel-fg)",
  green: "var(--color-green-fg)",
} as const;

// Ground-to-ink ladder. CSS variable references so these resolve against the
// active theme mode (dark/bright) in inline styles instead of freezing to
// dark-mode hexes at module load. Canvas 2D consumers use themeFor(mode)
// directly.
export const RAISE = "var(--color-raise)";
export const WELL = "var(--color-well)";
export const INK = "var(--color-ink)";
export const DIM = "var(--color-dim)";
export const FAINT = "var(--color-faint)";
export const GREEN = "var(--color-green)";

// A node colour: a preset digit or hex. Palette colours
// (shared/canvas-colors.ts) resolve to CSS variable references so they follow
// the active theme mode (dark/bright) instead of freezing to one shade; any
// other hex is a custom colour and paints as stored.
export const accentColor = (color?: string): string => {
  if (!color) return "var(--color-main)";
  const swatch = canvasSwatchFor(color);
  if (swatch) return `var(--color-${swatch.token})`;
  if (color.startsWith("#")) return color;
  return "var(--color-main)";
};

// Resolve a node colour (preset digit or hex) to a border tint. Absent
// color falls back to stroke (ink-at-N%) which is defined per mode. Emphasized
// state (selected/focused) uses the hi variant. Custom hex colors keep the old
// withAlpha path so they remain usable with JS color manipulation.
export const borderColor = (color?: string, emphasized = false): string => {
  if (color?.startsWith("#") && !canvasSwatchFor(color)) return color;
  if (!color) return emphasized ? "var(--color-stroke-hi)" : "var(--color-stroke)";
  return withAlpha(accentColor(color), emphasized ? 0.5 : 0.32);
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

