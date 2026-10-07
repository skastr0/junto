/**
 * Sheet sink: a small operator-authored grid.
 *
 * Deliberately not a spreadsheet. No formulas, no types, no formatting model —
 * every cell is text the operator typed, and the only structure is "which
 * column is this under". It exists so a number or a name can be jotted on the
 * canvas next to the work it belongs to, and so an agent can read that grid.
 *
 * Authority: the sheet grid's own SQLite row, read by node id and written by
 * operator commands. Agents read through `sheet.read`; the grid travels only
 * when it changes, independently of node placement and Work.
 */

import { Schema } from "effect";
import type { SheetGrid } from "./model/sheet";

export const SHEET_MAX_COLUMNS = 32;
export const SHEET_MAX_ROWS = 500;
export const SHEET_MAX_CELL_LENGTH = 2_000;
export const SHEET_MAX_NAME_LENGTH = 120;
/** Editor row pitch — keep in lockstep with `.junto-sheet__grid` CSS. */
export const SHEET_ROW_HEIGHT_PX = 32;
export const SHEET_ROW_OVERSCAN = 10;

const Identifier = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
);

export const SheetColumn = Schema.Struct({
  id: Identifier,
  name: Schema.String.pipe(Schema.check(Schema.isMaxLength(SHEET_MAX_NAME_LENGTH))),
});
export type SheetColumn = typeof SheetColumn.Type;

export const SheetRow = Schema.Struct({
  id: Identifier,
  /** Column id → cell text. A missing key is an empty cell. */
  cells: Schema.Record(
    Schema.String,
    Schema.String.pipe(Schema.check(Schema.isMaxLength(SHEET_MAX_CELL_LENGTH))),
  ),
});
export type SheetRow = typeof SheetRow.Type;

/** Stable ids without ulid: position-free, collision-checked against the sheet. */
const nextId = (prefix: string, taken: ReadonlySet<string>): string => {
  for (let n = 1; n <= SHEET_MAX_ROWS + SHEET_MAX_COLUMNS + 1; n += 1) {
    const candidate = `${prefix}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${prefix}${taken.size + 1}`;
};

const columnIds = (sheet: SheetGrid): Set<string> =>
  new Set(sheet.columns.map((column) => column.id));

const rowIds = (sheet: SheetGrid): Set<string> =>
  new Set(sheet.rows.map((row) => row.id));

/** A fresh sheet: two named columns and one empty row to type into. */
export const emptySheet = (): SheetGrid => ({
  columns: [
    { id: "c1", name: "Column A" },
    { id: "c2", name: "Column B" },
  ],
  rows: [{ id: "r1", cells: {} }],
});

export const addSheetColumn = (sheet: SheetGrid, name?: string): SheetGrid => {
  if (sheet.columns.length >= SHEET_MAX_COLUMNS) return sheet;
  const id = nextId("c", columnIds(sheet));
  const label = (name ?? `Column ${String(sheet.columns.length + 1)}`).slice(
    0,
    SHEET_MAX_NAME_LENGTH,
  );
  return { ...sheet, columns: [...sheet.columns, { id, name: label }] };
};

export const addSheetRow = (sheet: SheetGrid): SheetGrid => {
  if (sheet.rows.length >= SHEET_MAX_ROWS) return sheet;
  const id = nextId("r", rowIds(sheet));
  return { ...sheet, rows: [...sheet.rows, { id, cells: {} }] };
};

export const renameSheetColumn = (
  sheet: SheetGrid,
  columnId: string,
  name: string,
): SheetGrid => ({
  ...sheet,
  columns: sheet.columns.map((column) =>
    column.id === columnId
      ? { ...column, name: name.slice(0, SHEET_MAX_NAME_LENGTH) }
      : column,
  ),
});

/** Dropping a column drops its cells too — nothing keeps orphaned values. */
export const removeSheetColumn = (sheet: SheetGrid, columnId: string): SheetGrid => {
  if (!sheet.columns.some((column) => column.id === columnId)) return sheet;
  return {
    columns: sheet.columns.filter((column) => column.id !== columnId),
    rows: sheet.rows.map((row) => {
      if (!(columnId in row.cells)) return row;
      const cells = { ...row.cells };
      delete cells[columnId];
      return { ...row, cells };
    }),
  };
};

export const removeSheetRow = (sheet: SheetGrid, rowId: string): SheetGrid => ({
  ...sheet,
  rows: sheet.rows.filter((row) => row.id !== rowId),
});

/** Write one cell. Blank text clears the key so the grid stays sparse. */
export const setSheetCell = (
  sheet: SheetGrid,
  rowId: string,
  columnId: string,
  value: string,
): SheetGrid => {
  if (!sheet.columns.some((column) => column.id === columnId)) return sheet;
  const text = value.slice(0, SHEET_MAX_CELL_LENGTH);
  return {
    ...sheet,
    rows: sheet.rows.map((row) => {
      if (row.id !== rowId) return row;
      const cells = { ...row.cells };
      if (text.trim().length === 0) delete cells[columnId];
      else cells[columnId] = text;
      return { ...row, cells };
    }),
  };
};

export const sheetCell = (
  sheet: SheetGrid,
  rowId: string,
  columnId: string,
): string => {
  const row = sheet.rows.find((candidate) => candidate.id === rowId);
  return row?.cells[columnId] ?? "";
};

/**
 * True when the whole column reads as numbers (blank cells ignored). Presentation
 * only: it right-aligns the column. The grid never stores a cell type.
 */
export const isNumericColumn = (sheet: SheetGrid, columnId: string): boolean => {
  let seen = false;
  for (const row of sheet.rows) {
    const raw = (row.cells[columnId] ?? "").trim();
    if (raw.length === 0) continue;
    const cleaned = raw.replace(/[,$%\s]/gu, "");
    if (cleaned.length === 0 || Number.isNaN(Number(cleaned))) return false;
    seen = true;
  }
  return seen;
};

const escapeCell = (value: string): string =>
  value.replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");

/**
 * Markdown table — the sheet's read shape for agents and for copy-out.
 * A sheet with no columns renders as an empty string, not a broken table.
 */
export const sheetToMarkdown = (sheet: SheetGrid): string => {
  if (sheet.columns.length === 0) return "";
  const header = `| ${sheet.columns.map((column) => escapeCell(column.name)).join(" | ")} |`;
  const divider = `| ${sheet.columns.map(() => "---").join(" | ")} |`;
  const body = sheet.rows.map(
    (row) =>
      `| ${sheet.columns
        .map((column) => escapeCell(row.cells[column.id] ?? ""))
        .join(" | ")} |`,
  );
  return [header, divider, ...body].join("\n");
};

/**
 * Visible row window for the editor scroller. Pure so the overlay can paint
 * hundreds of rows without mounting every cell, and so tests can pin the math.
 * `viewportHeight <= 0` falls back to a first page so an unmeasured scroller
 * still shows something instead of an empty grid.
 */
export const visibleSheetRowRange = (
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = SHEET_ROW_HEIGHT_PX,
  overscan = SHEET_ROW_OVERSCAN,
): { readonly start: number; readonly end: number } => {
  if (rowCount <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const height = viewportHeight > 0 ? viewportHeight : rowHeight * 24;
  const start = Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan);
  const visible = Math.max(1, Math.ceil(height / rowHeight));
  const end = Math.min(rowCount, start + visible + overscan * 2);
  return { start, end };
};

/** Card glance line: shape first, then the first column names. */
export const sheetGlance = (sheet: SheetGrid | undefined): string => {
  const columns = sheet?.columns.length ?? 0;
  const rows = sheet?.rows.length ?? 0;
  const shape = `${String(rows)} row${rows === 1 ? "" : "s"}, ${String(columns)} column${columns === 1 ? "" : "s"}`;
  const names = (sheet?.columns ?? [])
    .map((column) => column.name.trim())
    .filter((name) => name.length > 0)
    .slice(0, 3)
    .join(", ");
  return names.length > 0 ? `${shape} - ${names}` : shape;
};
