import { MONO_CELL } from "./focus-measure";

/**
 * Grid focus geometry: how N live agent terminals share one modal.
 *
 * Pure. The grid view measures its own area and asks this module three
 * things: which shapes the picker may offer, which shape auto picks, and the
 * grid-only font size that keeps each cell usable. The font size is a view
 * override; it never reaches durable terminal settings.
 *
 * Shapes read rows x cols (a 2x3 grid is two rows of three).
 */

export type GridShape = { readonly rows: number; readonly cols: number };

/** Picker value: `auto`, or an explicit shape key like `2x3`. */
export type GridChoice = "auto" | `${number}x${number}`;

export type GridArea = { readonly width: number; readonly height: number };

export type GridPrefs = {
  /** Operator's durable font size; the grid only ever shrinks from it. */
  readonly fontSize: number;
  readonly lineHeight: number;
};

/** Cell chrome the terminal cannot use, in px. Mirrors the grid CSS. */
export const GRID_CELL_CHROME = {
  /** Gap between cells. */
  gap: 8,
  /** Compact cell header. */
  headerPx: 28,
  /** Horizontal xterm inset, both sides together. */
  padX: 8,
  /** Vertical xterm inset, both sides together. */
  padY: 4,
  /** Cell border, both sides together. */
  borderPx: 2,
} as const;

/** Columns x rows a cell aims to show before the grid shrinks its font. */
export const GRID_TARGET_CELLS = { cols: 80, rows: 24 } as const;

/** Below this a cell stops being a terminal you can read; page instead. */
export const GRID_READABLE_CELLS = { cols: 40, rows: 8 } as const;

/** Smallest grid font size. Smaller glyphs are not worth the columns. */
export const GRID_MIN_FONT_PX = 9;

/** xterm row height per px of font size, before the lineHeight multiplier. */
const MONO_ROW_RATIO = 1.2;

export const gridShapeKey = (shape: GridShape): `${number}x${number}` =>
  `${shape.rows}x${shape.cols}`;

export const parseGridChoice = (choice: GridChoice): GridShape | null => {
  if (choice === "auto") return null;
  const match = /^(\d+)x(\d+)$/.exec(choice);
  if (!match) return null;
  const rows = Number(match[1]);
  const cols = Number(match[2]);
  if (!(rows >= 1) || !(cols >= 1)) return null;
  return { rows, cols };
};

export const gridCapacity = (shape: GridShape): number => shape.rows * shape.cols;

/**
 * Every shape that holds `count` with no empty row and no empty column,
 * ordered by column count. For 6: 6x1, 3x2, 2x3, 1x6.
 */
export const gridShapesFor = (count: number): ReadonlyArray<GridShape> => {
  if (count < 1) return [];
  const shapes: GridShape[] = [];
  for (let cols = 1; cols <= count; cols += 1) {
    const rows = Math.ceil(count / cols);
    if (Math.ceil(count / rows) !== cols) continue;
    shapes.push({ rows, cols });
  }
  return shapes;
};

/** Terminal box of one cell: the cell minus header, border, and xterm inset. */
export const gridCellTerminalBox = (area: GridArea, shape: GridShape): GridArea => {
  const c = GRID_CELL_CHROME;
  const cellW = (area.width - c.gap * (shape.cols - 1)) / shape.cols;
  const cellH = (area.height - c.gap * (shape.rows - 1)) / shape.rows;
  return {
    width: Math.max(0, cellW - c.borderPx - c.padX),
    height: Math.max(0, cellH - c.borderPx - c.headerPx - c.padY),
  };
};

const cellPx = (fontSize: number, lineHeight: number) => ({
  w: fontSize * MONO_CELL.ratio,
  h: fontSize * MONO_ROW_RATIO * lineHeight,
});

/** Estimated cols x rows a box shows at a font size. */
export const gridCellFit = (
  box: GridArea,
  fontSize: number,
  lineHeight: number,
): { readonly cols: number; readonly rows: number } => {
  const px = cellPx(fontSize, lineHeight);
  return {
    cols: Math.floor(box.width / px.w),
    rows: Math.floor(box.height / px.h),
  };
};

/**
 * Grid font size for a cell box: the operator's size while the target
 * columns and rows still fit, else the largest size that fits them, never
 * below the grid minimum and never above the operator's own size.
 */
export const gridFontSize = (box: GridArea, prefs: GridPrefs): number => {
  const unit = cellPx(1, prefs.lineHeight);
  const fits = Math.floor(
    Math.min(
      box.width / (GRID_TARGET_CELLS.cols * unit.w),
      box.height / (GRID_TARGET_CELLS.rows * unit.h),
    ),
  );
  const ceiling = Math.max(GRID_MIN_FONT_PX, prefs.fontSize);
  return Math.max(GRID_MIN_FONT_PX, Math.min(ceiling, fits));
};

export const isReadableFit = (fit: { readonly cols: number; readonly rows: number }): boolean =>
  fit.cols >= GRID_READABLE_CELLS.cols && fit.rows >= GRID_READABLE_CELLS.rows;

/** What one shape does in an area: its font, estimated fit, and readability. */
export type GridShapeFit = {
  readonly shape: GridShape;
  readonly fontSize: number;
  readonly fit: { readonly cols: number; readonly rows: number };
  readonly readable: boolean;
};

export const fitGridShape = (
  area: GridArea,
  shape: GridShape,
  prefs: GridPrefs,
): GridShapeFit => {
  const box = gridCellTerminalBox(area, shape);
  const fontSize = gridFontSize(box, prefs);
  const fit = gridCellFit(box, fontSize, prefs.lineHeight);
  return { shape, fontSize, fit, readable: isReadableFit(fit) };
};

/**
 * Auto shape for `count`: the shape whose cells hold a target-proportioned
 * terminal at the largest scale. On a landscape area 5 or 6 lands on 2x3,
 * 7 to 9 on 3x3. Ties go to fewer empty cells, then fewer columns.
 */
export const autoGridShape = (count: number, area: GridArea, prefs: GridPrefs): GridShape | null => {
  const unit = cellPx(1, prefs.lineHeight);
  let best: { shape: GridShape; scale: number; empty: number } | null = null;
  for (const shape of gridShapesFor(count)) {
    const box = gridCellTerminalBox(area, shape);
    const scale = Math.min(
      box.width / (GRID_TARGET_CELLS.cols * unit.w),
      box.height / (GRID_TARGET_CELLS.rows * unit.h),
    );
    const empty = gridCapacity(shape) - count;
    if (
      !best ||
      scale > best.scale + 1e-9 ||
      (Math.abs(scale - best.scale) <= 1e-9 && empty < best.empty)
    ) {
      best = { shape, scale, empty };
    }
  }
  return best?.shape ?? null;
};

/** The grid the view renders: shape, grid font, and how the agents page. */
export type GridLayout = {
  readonly shape: GridShape;
  readonly fontSize: number;
  /** Agents per page. Equals the count unless cells would be unreadable. */
  readonly pageSize: number;
  readonly pageCount: number;
  readonly readable: boolean;
};

/**
 * Lay out `count` terminals.
 *
 * Auto shows everyone on one page while cells stay readable at the grid
 * minimum font. When they would not, it keeps the largest readable page and
 * pages the rest. An explicit shape is the operator's choice: it holds
 * everyone on one page and reports readability honestly, but it never pages
 * behind their back.
 */
export const layoutGrid = (input: {
  readonly count: number;
  readonly area: GridArea;
  readonly prefs: GridPrefs;
  readonly choice: GridChoice;
}): GridLayout | null => {
  const { count, area, prefs } = input;
  if (count < 1 || area.width <= 0 || area.height <= 0) return null;
  const explicit = parseGridChoice(input.choice);
  if (explicit && gridCapacity(explicit) >= count) {
    const fitted = fitGridShape(area, explicit, prefs);
    return {
      shape: explicit,
      fontSize: fitted.fontSize,
      pageSize: count,
      pageCount: 1,
      readable: fitted.readable,
    };
  }
  for (let pageSize = count; pageSize >= 1; pageSize -= 1) {
    const shape = autoGridShape(pageSize, area, prefs);
    if (!shape) continue;
    const fitted = fitGridShape(area, shape, prefs);
    if (!fitted.readable && pageSize > 1) continue;
    return {
      shape,
      fontSize: fitted.fontSize,
      pageSize,
      pageCount: Math.ceil(count / pageSize),
      readable: fitted.readable,
    };
  }
  return null;
};

/** Shapes the picker offers: those that hold everyone at a readable size. */
export const pickableGridShapes = (
  count: number,
  area: GridArea,
  prefs: GridPrefs,
): ReadonlyArray<GridShape> =>
  gridShapesFor(count).filter((shape) => fitGridShape(area, shape, prefs).readable);

/** Index range [start, end) of one page, clamped to the count. */
export const gridPageRange = (
  page: number,
  pageSize: number,
  count: number,
): { readonly start: number; readonly end: number } => {
  const pages = Math.max(1, Math.ceil(count / Math.max(1, pageSize)));
  const clamped = Math.min(Math.max(0, page), pages - 1);
  const start = clamped * pageSize;
  return { start, end: Math.min(count, start + pageSize) };
};

/** Plain overflow copy: `showing 1 to 9 of 14`, or null when all are shown. */
export const gridOverflowCopy = (
  range: { readonly start: number; readonly end: number },
  count: number,
): string | null =>
  range.end - range.start >= count ? null : `showing ${range.start + 1} to ${range.end} of ${count}`;
