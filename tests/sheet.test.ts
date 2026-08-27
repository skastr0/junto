import { describe, expect, it } from "vitest";
import { Result, Schema } from "effect";
import {
  addSheetColumn,
  addSheetRow,
  emptySheet,
  EtherSheet,
  isNumericColumn,
  removeSheetColumn,
  removeSheetRow,
  renameSheetColumn,
  setSheetCell,
  sheetCell,
  sheetGlance,
  sheetToMarkdown,
  SHEET_MAX_COLUMNS,
  SHEET_MAX_ROWS,
} from "../src/shared/sheet";
import { decodeCanvasDoc, serializeCanvas, type CanvasDoc } from "../src/shared/canvas";
import { resolveSpec, roleOf } from "../src/shared/physics";
import { opsForSink, portForWorkOp } from "../src/shared/physics/work-ports";
import { verbsForPair } from "../src/shared/physics/verbs";
import { makeSheetNode } from "../src/renderer/lib/node-factories";

describe("sheet model", () => {
  it("is born usable: named columns and a row to type into", () => {
    const sheet = emptySheet();
    expect(sheet.columns).toHaveLength(2);
    expect(sheet.rows).toHaveLength(1);
    expect(Result.isSuccess(Schema.decodeUnknownResult(EtherSheet)(sheet))).toBe(true);
  });

  it("adds columns and rows with ids that never collide", () => {
    let sheet = emptySheet();
    sheet = addSheetColumn(sheet, "Cost");
    sheet = addSheetRow(sheet);
    sheet = addSheetRow(sheet);
    expect(sheet.columns.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(sheet.rows.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
    expect(sheet.columns[2]?.name).toBe("Cost");

    // A deleted id is reused rather than leaving a gap — ids are addresses, not history.
    sheet = removeSheetRow(sheet, "r2");
    sheet = addSheetRow(sheet);
    expect(sheet.rows.map((r) => r.id)).toEqual(["r1", "r3", "r2"]);
  });

  it("writes cells, and blank text clears the key instead of storing empties", () => {
    let sheet = emptySheet();
    sheet = setSheetCell(sheet, "r1", "c1", "  42 ");
    expect(sheetCell(sheet, "r1", "c1")).toBe("  42 ");
    sheet = setSheetCell(sheet, "r1", "c1", "   ");
    expect(sheet.rows[0]?.cells).toEqual({});
  });

  it("refuses a write to a column that does not exist", () => {
    const sheet = setSheetCell(emptySheet(), "r1", "nope", "x");
    expect(sheet.rows[0]?.cells).toEqual({});
  });

  it("dropping a column drops its cells with it", () => {
    let sheet = setSheetCell(emptySheet(), "r1", "c2", "keep me");
    sheet = setSheetCell(sheet, "r1", "c1", "goes away");
    sheet = removeSheetColumn(sheet, "c1");
    expect(sheet.columns.map((c) => c.id)).toEqual(["c2"]);
    expect(sheet.rows[0]?.cells).toEqual({ c2: "keep me" });
  });

  it("renames a column without touching its cells", () => {
    let sheet = setSheetCell(emptySheet(), "r1", "c1", "7");
    sheet = renameSheetColumn(sheet, "c1", "Hours");
    expect(sheet.columns[0]).toEqual({ id: "c1", name: "Hours" });
    expect(sheetCell(sheet, "r1", "c1")).toBe("7");
  });

  it("stops at the column and row ceilings instead of growing forever", () => {
    let sheet: ReturnType<typeof emptySheet> = { columns: [], rows: [] };
    for (let i = 0; i < SHEET_MAX_COLUMNS + 3; i += 1) sheet = addSheetColumn(sheet);
    expect(sheet.columns).toHaveLength(SHEET_MAX_COLUMNS);
    for (let i = 0; i < SHEET_MAX_ROWS + 3; i += 1) sheet = addSheetRow(sheet);
    expect(sheet.rows).toHaveLength(SHEET_MAX_ROWS);
  });
});

describe("numeric columns", () => {
  it("reads a whole column of numbers as numeric, blanks ignored", () => {
    let sheet = emptySheet();
    sheet = setSheetCell(sheet, "r1", "c1", "1,200");
    sheet = addSheetRow(sheet);
    sheet = setSheetCell(sheet, "r2", "c1", "$3.50");
    sheet = addSheetRow(sheet);
    expect(isNumericColumn(sheet, "c1")).toBe(true);
  });

  it("one word makes the column text, and an empty column is not numeric", () => {
    let sheet = emptySheet();
    sheet = setSheetCell(sheet, "r1", "c1", "12");
    sheet = addSheetRow(sheet);
    sheet = setSheetCell(sheet, "r2", "c1", "twelve");
    expect(isNumericColumn(sheet, "c1")).toBe(false);
    expect(isNumericColumn(sheet, "c2")).toBe(false);
  });
});

describe("markdown projection", () => {
  it("renders the grid agents read", () => {
    let sheet: ReturnType<typeof emptySheet> = {
      columns: [
        { id: "c1", name: "Host" },
        { id: "c2", name: "Cost" },
      ],
      rows: [{ id: "r1", cells: {} }],
    };
    sheet = setSheetCell(sheet, "r1", "c1", "remote-a");
    sheet = setSheetCell(sheet, "r1", "c2", "12");
    expect(sheetToMarkdown(sheet)).toBe(
      ["| Host | Cost |", "| --- | --- |", "| remote-a | 12 |"].join("\n"),
    );
  });

  it("escapes pipes and newlines so one cell cannot forge a row", () => {
    let sheet = emptySheet();
    sheet = setSheetCell(sheet, "r1", "c1", "a | b\nc");
    expect(sheetToMarkdown(sheet).split("\n")).toHaveLength(3);
    expect(sheetToMarkdown(sheet)).toContain("a \\| b c");
  });

  it("a sheet with no columns renders nothing, not a broken table", () => {
    expect(sheetToMarkdown({ columns: [], rows: [] })).toBe("");
  });
});

describe("sheet glance", () => {
  it("leads with shape, then the first column names", () => {
    expect(sheetGlance(emptySheet())).toBe("1 row, 2 columns - Column A, Column B");
    expect(sheetGlance(undefined)).toBe("0 rows, 0 columns");
  });
});

describe("sheet as a factory node", () => {
  it("is a sink that offers read and no write", () => {
    const spec = resolveSpec({ isGroup: false, kind: "sheet" });
    expect(roleOf(spec)).toBe("sink");
    expect(opsForSink("sheet")).toEqual(["sheet.read"]);
    expect(portForWorkOp("sheet.read")).toBe("sheet.read");
  });

  it("an agent may read a sheet and may not edit one", () => {
    expect(verbsForPair("agent", "sheet")).toEqual(["reads"]);
  });

  it("round-trips through the canvas document", () => {
    const node = makeSheetNode(10, 20);
    const doc: CanvasDoc = { nodes: [node], edges: [] };
    const again = Result.getOrThrow(decodeCanvasDoc(JSON.parse(serializeCanvas(doc))));
    expect(again.nodes[0]?.ether?.entity?.kind).toBe("sheet");
    expect(again.nodes[0]?.ether?.sheet?.columns).toHaveLength(2);
  });
});
