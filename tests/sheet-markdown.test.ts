import { describe, expect, it } from "vitest";
import type { SheetGrid } from "../src/shared/model/sheet";
import {
  escapeSheetCell,
  sheetColumnLetter,
  sheetToMarkdown,
} from "../src/shared/sheet";

const grid: SheetGrid = {
  columns: [
    { id: "c1", name: "Name" },
    { id: "c2", name: "Count" },
  ],
  rows: [
    { id: "r1", cells: { c1: "apples", c2: "3" } },
    { id: "r2", cells: { c2: "7" } },
  ],
};

describe("sheetColumnLetter", () => {
  it("counts like a spreadsheet", () => {
    expect(sheetColumnLetter(0)).toBe("A");
    expect(sheetColumnLetter(25)).toBe("Z");
    expect(sheetColumnLetter(26)).toBe("AA");
    expect(sheetColumnLetter(27)).toBe("AB");
    expect(sheetColumnLetter(51)).toBe("AZ");
    expect(sheetColumnLetter(52)).toBe("BA");
    expect(sheetColumnLetter(701)).toBe("ZZ");
    expect(sheetColumnLetter(702)).toBe("AAA");
  });

  it("names nothing for a negative index", () => {
    expect(sheetColumnLetter(-1)).toBe("");
  });
});

describe("escapeSheetCell", () => {
  it("escapes pipes and backslashes, and keeps line breaks as <br>", () => {
    expect(escapeSheetCell("a|b")).toBe("a\\|b");
    expect(escapeSheetCell("a\\|b")).toBe("a\\\\\\|b");
    expect(escapeSheetCell("one\ntwo\r\nthree\rfour")).toBe("one<br>two<br>three<br>four");
    expect(escapeSheetCell("a<br>b\nc")).toBe("a&lt;br>b<br>c");
    expect(escapeSheetCell("<BR> <br/> <br />")).toBe("&lt;BR> &lt;br/> &lt;br />");
  });
});

describe("sheetToMarkdown", () => {
  it("labels rows by number and columns by letter", () => {
    expect(sheetToMarkdown(grid)).toBe(
      [
        "| # | A Name | B Count |",
        "| --: | --- | --- |",
        "| 1 | apples | 3 |",
        "| 2 |  | 7 |",
      ].join("\n"),
    );
  });

  it("follows column order, not the order cells were written", () => {
    const reordered: SheetGrid = { ...grid, columns: [grid.columns[1]!, grid.columns[0]!] };
    expect(sheetToMarkdown(reordered).split("\n")[2]).toBe("| 1 | 3 | apples |");
  });

  it("falls back to the letter for a blank column name", () => {
    const blank: SheetGrid = { columns: [{ id: "c1", name: "  " }], rows: [] };
    expect(sheetToMarkdown(blank)).toBe("| # | A |\n| --: | --- |");
  });

  it("keeps every row one table row whatever the cell holds", () => {
    const awkward: SheetGrid = {
      columns: [{ id: "c1", name: "a|b" }],
      rows: [{ id: "r1", cells: { c1: "x\ny|z" } }],
    };
    const lines = sheetToMarkdown(awkward).split("\n");
    expect(lines).toEqual(["| # | A a\\|b |", "| --: | --- |", "| 1 | x<br>y\\|z |"]);
  });

  it("ignores cells under no column", () => {
    const orphan: SheetGrid = {
      columns: [{ id: "c1", name: "Only" }],
      rows: [{ id: "r1", cells: { c1: "kept", gone: "dropped" } }],
    };
    expect(sheetToMarkdown(orphan)).not.toContain("dropped");
  });

  it("projects a grid with no columns to an empty string", () => {
    expect(sheetToMarkdown({ columns: [], rows: [{ id: "r1", cells: {} }] })).toBe("");
  });
});
