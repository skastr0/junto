import { Schema } from "effect";
import { SHEET_MAX_COLUMNS, SHEET_MAX_ROWS, SheetColumn, SheetRow } from "../sheet";

// What a sheet holds: the body of a sheet artifact.

export const SheetGrid = Schema.Struct({
  columns: Schema.Array(SheetColumn).pipe(Schema.check(Schema.isMaxLength(SHEET_MAX_COLUMNS))),
  rows: Schema.Array(SheetRow).pipe(Schema.check(Schema.isMaxLength(SHEET_MAX_ROWS))),
});
export type SheetGrid = typeof SheetGrid.Type;
