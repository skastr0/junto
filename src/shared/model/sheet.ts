import { Schema } from "effect";
import { SHEET_MAX_COLUMNS, SHEET_MAX_ROWS, SheetColumn, SheetRow } from "../sheet";
import { CanvasName, NodeId } from "./base";

// What a sheet holds. It is kept apart from the sheet node, read by the node's
// id and changed by its own command, so the grid travels only when the grid
// changes.

export const SheetGrid = Schema.Struct({
  columns: Schema.Array(SheetColumn).pipe(Schema.check(Schema.isMaxLength(SHEET_MAX_COLUMNS))),
  rows: Schema.Array(SheetRow).pipe(Schema.check(Schema.isMaxLength(SHEET_MAX_ROWS))),
});
export type SheetGrid = typeof SheetGrid.Type;

/** Emitted after a sheet's grid is written. The listener reads it if it cares. */
export const SheetChanged = Schema.Struct({
  canvas: CanvasName,
  id: NodeId,
});
export type SheetChanged = typeof SheetChanged.Type;
