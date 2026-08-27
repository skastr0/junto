/**
 * Sheet sink: a small operator-authored grid.
 *
 * Deliberately not a spreadsheet. No formulas, no types, no formatting model —
 * every cell is text the operator typed, and the only structure is "which
 * column is this under". It exists so a number or a name can be jotted on the
 * canvas next to the work it belongs to, and so an agent can read that grid.
 *
 * Authority: the canvas document (`ether.sheet`), same as note text. This is
 * authored content, not a projection of a work-plane row, so there is no
 * revision counter and no SQLite table behind it. Agents read it through
 * `sheet.read`; the canvas stays operator-authored.
 */

import { Schema } from "effect";

export const SHEET_MAX_COLUMNS = 32;
export const SHEET_MAX_ROWS = 500;
export const SHEET_MAX_CELL_LENGTH = 2_000;
export const SHEET_MAX_NAME_LENGTH = 120;

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

export const EtherSheet = Schema.Struct({
  columns: Schema.Array(SheetColumn).pipe(
    Schema.check(Schema.isMaxLength(SHEET_MAX_COLUMNS)),
  ),
  rows: Schema.Array(SheetRow).pipe(Schema.check(Schema.isMaxLength(SHEET_MAX_ROWS))),
});
export type EtherSheet = typeof EtherSheet.Type;

/** Stable ids without ulid: position-free, collision-checked against the sheet. */
const nextId = (prefix: string, taken: ReadonlySet<string>): string => {
  for (let n = 1; n <= SHEET_MAX_ROWS + SHEET_MAX_COLUMNS + 1; n += 1) {
    const candidate = `${prefix}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${prefix}${taken.size + 1}`;
};

const columnIds = (sheet: EtherSheet): Set<string> =>
  new Set(sheet.columns.map((column) => column.id));

const rowIds = (sheet: EtherSheet): Set<string> =>
  new Set(sheet.rows.map((row) => row.id));

/** A fresh sheet: two named columns and one empty row to type into. */
export const emptySheet = (): EtherSheet => ({
  columns: [
    { id: "c1", name: "Column A" },
    { id: "c2", name: "Column B" },
  ],
  rows: [{ id: "r1", cells: {} }],
});

export const addSheetColumn = (sheet: EtherSheet, name?: string): EtherSheet => {
  if (sheet.columns.length >= SHEET_MAX_COLUMNS) return sheet;
  const id = nextId("c", columnIds(sheet));
  const label = (name ?? `Column ${String(sheet.columns.length + 1)}`).slice(
    0,
    SHEET_MAX_NAME_LENGTH,
  );
  return { ...sheet, columns: [...sheet.columns, { id, name: label }] };
};

export const addSheetRow = (sheet: EtherSheet): EtherSheet => {
  if (sheet.rows.length >= SHEET_MAX_ROWS) return sheet;
  const id = nextId("r", rowIds(sheet));
  return { ...sheet, rows: [...sheet.rows, { id, cells: {} }] };
};

export const renameSheetColumn = (
  sheet: EtherSheet,
  columnId: string,
  name: string,
): EtherSheet => ({
  ...sheet,
  columns: sheet.columns.map((column) =>
    column.id === columnId
      ? { ...column, name: name.slice(0, SHEET_MAX_NAME_LENGTH) }
      : column,
  ),
});

/** Dropping a column drops its cells too — nothing keeps orphaned values. */
export const removeSheetColumn = (sheet: EtherSheet, columnId: string): EtherSheet => {
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

export const removeSheetRow = (sheet: EtherSheet, rowId: string): EtherSheet => ({
  ...sheet,
  rows: sheet.rows.filter((row) => row.id !== rowId),
});

/** Write one cell. Blank text clears the key so the document stays sparse. */
export const setSheetCell = (
  sheet: EtherSheet,
  rowId: string,
  columnId: string,
  value: string,
): EtherSheet => {
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
  sheet: EtherSheet,
  rowId: string,
  columnId: string,
): string => {
  const row = sheet.rows.find((candidate) => candidate.id === rowId);
  return row?.cells[columnId] ?? "";
};

/**
 * True when the whole column reads as numbers (blank cells ignored). Presentation
 * only: it right-aligns the column. The document never stores a cell type.
 */
export const isNumericColumn = (sheet: EtherSheet, columnId: string): boolean => {
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
export const sheetToMarkdown = (sheet: EtherSheet): string => {
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

/** Card glance line: shape first, then the first column names. */
export const sheetGlance = (sheet: EtherSheet | undefined): string => {
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
