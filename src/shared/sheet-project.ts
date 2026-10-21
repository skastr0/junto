/**
 * Sheet projection: the text an agent reads for a sheet artifact
 * (`junto artifact show`, plan 05).
 *
 * A GitHub markdown table with spreadsheet labels: a `#` column numbers the
 * rows from 1 and every header leads with its column letter, so a reader can
 * name a cell (`B3`) or a range (`A1:C4`) for a `cells` anchor without the
 * grid's internal ids. The body still travels beside the projection for
 * edits, which address rows and columns by id.
 *
 * Pure: the same grid always projects to the same text.
 */

import type { SheetGrid } from "./model/sheet";

/** Column letter for a zero-based index: 0 → A, 25 → Z, 26 → AA. */
export const sheetColumnLetter = (index: number): string => {
  let n = Math.floor(index);
  if (n < 0) return "";
  let letters = "";
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letters;
};

/**
 * One cell as markdown table text. Backslash first so the pipe escape it
 * adds is not escaped again; a line break stays a break as `<br>`, since a
 * raw newline would end the row.
 */
export const escapeSheetCell = (value: string): string =>
  value
    .replace(/\\/gu, "\\\\")
    .replace(/\|/gu, "\\|")
    .replace(/\r\n|\r|\n/gu, "<br>");

const row = (cells: ReadonlyArray<string>): string => `| ${cells.join(" | ")} |`;

/**
 * The sheet as a labelled markdown table. A grid with no columns has no
 * table to draw, so it projects to an empty string rather than a broken one.
 */
export const sheetToMarkdownTable = (grid: SheetGrid): string => {
  if (grid.columns.length === 0) return "";
  const header = row([
    "#",
    ...grid.columns.map((column, index) => {
      const name = escapeSheetCell(column.name.trim());
      const letter = sheetColumnLetter(index);
      return name.length > 0 ? `${letter} ${name}` : letter;
    }),
  ]);
  const divider = row(["--:", ...grid.columns.map(() => "---")]);
  const body = grid.rows.map((sheetRow, index) =>
    row([
      String(index + 1),
      ...grid.columns.map((column) => escapeSheetCell(sheetRow.cells[column.id] ?? "")),
    ]),
  );
  return [header, divider, ...body].join("\n");
};
