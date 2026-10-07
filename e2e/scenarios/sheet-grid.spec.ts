/**
 * A sheet's grid, on its card and in its editor.
 *
 * The grid is content of its own: the window reads it by canvas and id, and
 * writes it with its own command. This opens a canvas with a sheet that has
 * cells, sees them on the card, opens the editor on them, types in a cell,
 * closes and reopens, and reads what main stores at each step.
 * Run: `bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/sheet-grid.spec.ts`
 */
import type { Page } from "@playwright/test";
import { expect, test } from "../harness/launch";
import { commandModel } from "../harness/model";

const SHEET = "sheet-budget";
const grid = {
  columns: [
    { id: "item", name: "Item" },
    { id: "cost", name: "Cost" },
  ],
  rows: [
    { id: "r1", cells: { item: "Lumber", cost: "120" } },
    { id: "r2", cells: { item: "Nails", cost: "8" } },
  ],
};

/** The canvas the app opened on, with one sheet that has cells. */
const installBoard = async (page: Page): Promise<string> => {
  await page.waitForFunction(() => Boolean(window.junto?.modelCanvases), undefined, { timeout: 30_000 });
  const names = await page.evaluate(() => window.junto!.modelCanvases());
  const canvas = names[0]?.name ?? "sheets";
  if (names.length === 0) await commandModel(page, { _tag: "CreateCanvas", canvas });
  await commandModel(page, {
    _tag: "Batch",
    canvas,
    steps: [
      {
        _tag: "Add",
        canvas,
        nodes: [{ kind: "sheet", id: SHEET, label: "Budget", x: 80, y: 80, width: 260, height: 160, z: 0 }],
        wires: [],
      },
      { _tag: "WriteSheet", canvas, id: SHEET, grid },
    ],
  });
  return canvas;
};

/** The cell main stores, by row and column. */
const storedCell = async (page: Page, canvas: string, row: string, column: string): Promise<string | undefined> => {
  const read = await page.evaluate(({ canvas, id }) => window.junto!.modelSheetRead({ canvas, id }), { canvas, id: SHEET });
  return read.rows.find((entry) => entry.id === row)?.cells[column];
};

test("sheet: the card shows the cells, the editor opens on them, and a typed cell is kept", async ({ junto }) => {
  const { page } = junto;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  const canvas = await installBoard(page);
  const card = page.locator(`.react-flow__node[data-id="${SHEET}"]`);
  await expect(card).toBeVisible({ timeout: 30_000 });

  // The card face shows the grid, which is not on the sheet's node.
  await expect(card).toContainText("Lumber");
  await expect(card).toContainText("Nails");

  // The editor opens on the cells as stored, never on an empty grid.
  await card.dblclick();
  const editor = page.getByTestId("sheet-detail");
  await expect(editor).toBeVisible();
  const lumber = editor.getByLabel("Item row 1", { exact: true });
  await expect(lumber).toHaveValue("Lumber");
  await expect(editor.getByLabel("Cost row 2", { exact: true })).toHaveValue("8");

  // Opening and looking wrote nothing.
  expect(await storedCell(page, canvas, "r1", "item")).toBe("Lumber");

  // Type in a cell: it reaches main without a save button.
  await lumber.fill("Oak");
  await expect.poll(() => storedCell(page, canvas, "r1", "item")).toBe("Oak");
  expect(await storedCell(page, canvas, "r2", "item")).toBe("Nails");

  // Close: the card shows what was typed.
  await editor.getByRole("button", { name: "Close sheet" }).click();
  await expect(editor).toHaveCount(0);
  await expect(card).toContainText("Oak");
  await expect(card).not.toContainText("Lumber");

  // Reopen: the editor opens on the typed value, and closing it untouched
  // changes nothing in main.
  await card.dblclick();
  await expect(editor.getByLabel("Item row 1", { exact: true })).toHaveValue("Oak");
  await editor.getByRole("button", { name: "Close sheet" }).click();
  await expect(editor).toHaveCount(0);
  expect(await storedCell(page, canvas, "r1", "item")).toBe("Oak");
  expect(await storedCell(page, canvas, "r1", "cost")).toBe("120");

  // A grid written from outside the window shows on the card.
  await commandModel(page, {
    _tag: "WriteSheet",
    canvas,
    id: SHEET,
    grid: { ...grid, rows: [{ id: "r1", cells: { item: "Cedar", cost: "95" } }] },
  });
  await expect(card).toContainText("Cedar");
});
