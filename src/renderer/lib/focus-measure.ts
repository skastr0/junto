import type { CSSProperties } from "react";

/**
 * Focus measures — width targets for single-subject "focused" surfaces.
 *
 * The product bet: one agent / one draft is more pleasant when the surface
 * is *centered and measure-constrained* rather than full-bleed or stage-split.
 * Full width and dock-split remain available; focus is the default for deep
 * interaction.
 *
 * Units:
 * - `ch` — width of the "0" character. For proportional UI text ≈ average char;
 *   for monospace (terminals) ≈ one cell.
 * - terminal math uses the same cell estimate xterm falls back to
 *   (`fontSize * monoCellRatio`, currently 13 × 0.6 = 7.8px).
 *
 * Line-length anchors (typography research, not cargo-cult):
 * - prose reading: ~45–75 characters / line; we pick 65ch
 * - classic TTY: 80 cols; agent TUIs benefit from more side chrome → ~120–140
 */

export type FocusMeasure = "prose" | "document" | "terminal" | "workspace" | "form";

/** Height policy for a focus surface. */
export type FocusHeight =
  /** Nearly full viewport height — agent work (terminal, browser). */
  | "immersive"
  /** Content-sized, capped — forms, short dialogs. */
  | "fit"
  /** User-resizable box with session memory — browse/detail. */
  | "resizable";

/** Stacking layer. Work surfaces sit above detail modals and inspector. */
export type FocusLayer = "detail" | "work";

/** Shared mono cell estimate used by xterm fallback measure. */
export const MONO_CELL = {
  fontSizePx: 13,
  /** Advance-width / font-size for SF Mono / Menlo / ui-monospace. */
  ratio: 0.6,
} as const;

export const monoCellWidthPx = (fontSizePx: number = MONO_CELL.fontSizePx): number =>
  fontSizePx * MONO_CELL.ratio;

/**
 * Terminal focus width — ~140 mono cells at 13px.
 * Reverse-engineered from the pre-existing pleasant 1100px centered panel:
 *   1100 ≈ 140 × 13 × 0.6 + borders
 * Wide enough for agent TUIs (side panels, status columns) without going
 * full-bleed; still a readable, focused column on large displays.
 */
export const TERMINAL_FOCUS = {
  fontSizePx: MONO_CELL.fontSizePx,
  targetCols: 140,
  /** Panel border / subpixel fudge. */
  chromeXPx: 4,
} as const;

export function terminalFocusWidthPx(
  cols: number = TERMINAL_FOCUS.targetCols,
  fontSizePx: number = TERMINAL_FOCUS.fontSizePx,
): number {
  return Math.round(cols * monoCellWidthPx(fontSizePx) + TERMINAL_FOCUS.chromeXPx);
}

/**
 * The ACTOR terminal's right instrument pane stacks the compact ledger above
 * connections. Both sections share one width, so the focus panel budgets that
 * width once and the xterm keeps its target columns.
 */
export const TERMINAL_RAILS_PX = {
  /** Shared width of the stacked ledger and connections pane. */
  rightPane: 248,
} as const;

/** Expanded / collapsed state of the two actor rails. */
export type ActorRailsOpen = {
  readonly ledger: boolean;
  readonly connections: boolean;
};

/** Rails default to expanded — the state the panes mount in. */
export const DEFAULT_ACTOR_RAILS_OPEN: ActorRailsOpen = {
  ledger: true,
  connections: true,
};

export const actorTerminalRailsPx = (
  _open: ActorRailsOpen = DEFAULT_ACTOR_RAILS_OPEN,
): number => TERMINAL_RAILS_PX.rightPane;

/** Default CSS pixel widths for non-ch measures (document / workspace). */
export const FOCUS_WIDTH_PX = {
  /** Session / signal / dispatch detail — existing vellum-modal. */
  document: 760,
  /** Browser / multi-pane work that still wants a frame, not full bleed. */
  workspace: 1280,
  /** Compact wizard / emit forms (≈ max-w-md). */
  form: 448,
} as const;

/** Prose measure in `ch` (ideal reading line). */
export const PROSE_MEASURE_CH = 65;

/** Inline style vars consumers can set on a focus panel root. */
export function focusMeasureCssVars(
  measure: FocusMeasure,
  options?: { readonly terminalRailsPx?: number },
): CSSProperties {
  const terminalW = terminalFocusWidthPx();
  return {
    ["--focus-terminal-width" as string]: `${terminalW}px`,
    ["--focus-terminal-rails" as string]: `${options?.terminalRailsPx ?? 0}px`,
    ["--focus-document-width" as string]: `${FOCUS_WIDTH_PX.document}px`,
    ["--focus-workspace-width" as string]: `${FOCUS_WIDTH_PX.workspace}px`,
    ["--focus-form-width" as string]: `${FOCUS_WIDTH_PX.form}px`,
    ["--focus-prose-ch" as string]: String(PROSE_MEASURE_CH),
    ["--focus-measure" as string]: measure,
  };
}
