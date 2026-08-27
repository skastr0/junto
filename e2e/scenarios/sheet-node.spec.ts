/**
 * Sheet sink: card face, editor, and the write path back to the canvas.
 *
 * Run: `bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/sheet-node.spec.ts`
 */
import { join } from "node:path";
import { canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const SHOTS = process.env.VELLUM_SHEET_SHOTS ?? join(process.cwd(), "test-results", "sheet-node");

const sheetNode = {
  id: "sheet1",
  type: "text" as const,
  text: "burn rate",
  x: 0,
  y: 0,
  width: 260,
  height: 120,
  ether: {
    entity: { kind: "sheet" as const },
    sheet: {
      columns: [
        { id: "c1", name: "Host" },
        { id: "c2", name: "Cost" },
      ],
      rows: [
        { id: "r1", cells: { c1: "remote-a", c2: "12" } },
        { id: "r2", cells: { c1: "studio", c2: "48" } },
      ],
    },
  },
};

test.use({
  vellumOptions: { seedCanvases: { sheets: canvasDoc([sheetNode]) } },
});

test("a sheet card shows its grid and the editor writes back to the canvas", async ({
  vellumCommand,
}) => {
  const { page } = vellumCommand;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

  const card = page.locator('.react-flow__node[data-id="sheet1"]');
  await expect(card).toBeVisible({ timeout: 30_000 });
  // The card face carries the real grid, not just a count.
  await expect(card).toContainText("remote-a");
  await expect(card).toContainText("2 rows, 2 columns");
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, "01-card.png") });

  // Double-click opens the editor (same activate path as the other sinks).
  await card.dblclick();
  const detail = page.getByTestId("sheet-detail");
  await expect(detail).toBeVisible({ timeout: 15_000 });
  await expect(detail.getByRole("textbox", { name: "Cost row 2" })).toHaveValue("48");
  await page.screenshot({ path: join(SHOTS, "02-editor.png") });

  // Type a cell, add a row, add a column.
  const cell = detail.getByRole("textbox", { name: "Host row 1" });
  await cell.fill("mac-studio");
  await detail.getByRole("button", { name: "Row", exact: true }).click();
  await detail.getByRole("button", { name: "Column", exact: true }).click();
  await expect(detail.getByRole("textbox", { name: /row 3/ }).first()).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, "03-edited.png") });

  // The canvas document is the authority — read it back through the app API.
  const stored = await page.evaluate(async () => {
    const api = (
      globalThis as unknown as {
        readonly vellumCommand: {
          readonly readCanvas: (name: string) => Promise<{ doc: { nodes: unknown[] } }>;
        };
      }
    ).vellumCommand;
    const read = await api.readCanvas("sheets");
    const node = read.doc.nodes.find(
      (candidate) => (candidate as { id?: string }).id === "sheet1",
    ) as { ether?: { sheet?: { columns: unknown[]; rows: { cells: Record<string, string> }[] } } };
    return node.ether?.sheet;
  });
  expect(stored?.columns).toHaveLength(3);
  expect(stored?.rows).toHaveLength(3);
  expect(stored?.rows[0]?.cells.c1).toBe("mac-studio");

  // Close returns to the canvas with the new shape on the card.
  await detail.getByRole("button", { name: "Close sheet" }).click();
  await expect(detail).toHaveCount(0);
  await expect(card).toContainText("3 rows, 3 columns");
  await page.screenshot({ path: join(SHOTS, "04-card-after.png") });
});
