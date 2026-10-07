/**
 * A view never outlives its node.
 *   bun run test:e2e:fast e2e/scenarios/removed-node-views.spec.ts
 *
 * A node is removed by a canvas write that is not the operator's own delete
 * (what a CLI or overseer write, or another window, does) while its view is
 * open. The view must close and leave the keyboard nowhere inside it:
 *   - an agent's terminal in the focus view
 *   - a note in the focus view
 *   - one cell of the terminal grid, then the grid's last cells
 */
import type { Page } from "@playwright/test";
import type { CanvasNode } from "../../src/shared/canvas";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "removed-node-views";

const seat = (id: string, label: string, x: number): CanvasNode =>
  agentTextNode({ id, key: `local:e2e-removed-${id}`, label, x, y: 40 });

const nodes: ReadonlyArray<CanvasNode> = [
  seat("alpha", "Alpha", 40),
  seat("bravo", "Bravo", 340),
  seat("charlie", "Charlie", 640),
  seat("delta", "Delta", 940),
  { id: "memo", type: "text", text: "Field notes", x: 40, y: 260, width: 240, height: 96 },
];

/** Remove nodes through the canvas store, not through the renderer's own delete. */
const removeByCanvasWrite = (page: Page, ids: ReadonlyArray<string>): Promise<void> =>
  page.evaluate(
    async ([name, gone]) => {
      const api = window.junto!;
      const read = await api.readCanvas(name);
      await api.writeCanvas(
        name,
        {
          nodes: read.doc.nodes.filter((node) => !gone.includes(node.id)),
          edges: read.doc.edges.filter((edge) => !gone.includes(edge.fromNode) && !gone.includes(edge.toNode)),
        },
        read.revision,
      );
    },
    [CANVAS, [...ids]] as const,
  );

const card = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);

/** True when the keyboard sits inside any working modal or grid cell. */
const keyboardInAView = (page: Page): Promise<boolean> =>
  page.evaluate(
    () =>
      document.activeElement?.closest(
        "[data-focus-surface], .native-terminal-surface, .terminal-grid__cell, [data-testid='note-workbench-surface']",
      ) != null,
  );

test("a node removed by a canvas write takes its open view with it", async () => {
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: canvasDoc([...nodes], []) } });

  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await expect(card(page, "alpha")).toBeVisible({ timeout: 30_000 });

    // An agent's terminal in the focus view.
    await card(page, "alpha").dblclick();
    const terminal = page.locator(".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface");
    await expect(terminal).toBeVisible({ timeout: 20_000 });
    await expect(terminal.locator("header").first()).toContainText("Alpha");
    await removeByCanvasWrite(page, ["alpha"]);
    await expect(card(page, "alpha")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator(".native-terminal-surface")).toHaveCount(0);
    await expect.poll(() => keyboardInAView(page)).toBe(false);

    // A note in the focus view.
    await card(page, "memo").click();
    await page.getByRole("button", { name: "Expand note editor" }).click();
    const note = page.getByTestId("note-workbench-surface");
    await expect(note).toBeVisible({ timeout: 10_000 });
    await removeByCanvasWrite(page, ["memo"]);
    await expect(card(page, "memo")).toHaveCount(0, { timeout: 10_000 });
    await expect(note).toHaveCount(0);
    await expect.poll(() => keyboardInAView(page)).toBe(false);

    // The grid: one cell goes with its node, and the grid goes with its last cells.
    await page.locator(".react-flow__pane").click({ position: { x: 20, y: 500 } });
    for (const id of ["bravo", "charlie", "delta"]) await card(page, id).click({ modifiers: ["Shift"] });
    await card(page, "charlie").click({ button: "right" });
    await page.getByLabel("Open 3 agents in a grid").click();
    const grid = page.getByTestId("terminal-grid-focus");
    const cells = grid.locator(".terminal-grid__cell");
    await expect(cells).toHaveCount(3, { timeout: 10_000 });
    await removeByCanvasWrite(page, ["charlie"]);
    await expect(cells).toHaveCount(2, { timeout: 10_000 });
    await expect(grid).toBeVisible();
    await removeByCanvasWrite(page, ["bravo", "delta"]);
    await expect(grid).toHaveCount(0, { timeout: 10_000 });
    await expect.poll(() => keyboardInAView(page)).toBe(false);
  } finally {
    await junto.close();
  }
});
