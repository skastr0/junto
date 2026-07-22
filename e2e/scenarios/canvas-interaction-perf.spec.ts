/**
 * Dense-canvas interaction budgets. Catches regressions where selection or
 * drag remints the whole React Flow graph (the failure mode that made the
 * board feel laggy after the impact-mode work).
 *
 * Thresholds are wall-clock from Playwright's side — generous enough for CI
 * variance, tight enough to fail on an O(n) full-graph remint.
 */
import type { CanvasDoc, CanvasEdge, CanvasNode } from "../../src/shared/canvas";
import { canvasDoc, textNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const COLS = 10;
const ROWS = 8;
const NODE_COUNT = COLS * ROWS;

const denseDoc = (): CanvasDoc => {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      const i = row * COLS + col;
      const id = `n${i}`;
      nodes.push(textNode(id, `Perf node ${i}`, col * 280, row * 160));
      if (col > 0) {
        edges.push({
          id: `e-${i}-h`,
          fromNode: `n${i - 1}`,
          toNode: id,
        });
      }
      if (row > 0) {
        edges.push({
          id: `e-${i}-v`,
          fromNode: `n${i - COLS}`,
          toNode: id,
        });
      }
    }
  }
  return canvasDoc(nodes, edges);
};

test.use({
  vellumOptions: {
    seedCanvases: {
      perf: denseDoc(),
    },
  },
});

test("dense canvas: selection stays under interaction budget", async ({ vellum }) => {
  const { page } = vellum;

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  const first = page.getByTestId("rf__node-n0");
  const mid = page.getByTestId(`rf__node-n${Math.floor(NODE_COUNT / 2)}`);
  await expect(first).toBeVisible({ timeout: 30_000 });
  await expect(mid).toBeVisible();

  // Warm: first selection pays mount costs.
  await first.click();
  await expect(first).toHaveClass(/selected/);

  const samples: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const target = i % 2 === 0 ? mid : first;
    const other = i % 2 === 0 ? first : mid;
    const t0 = Date.now();
    await target.click();
    await expect(target).toHaveClass(/selected/);
    await expect(other).not.toHaveClass(/selected/);
    samples.push(Date.now() - t0);
  }

  const median = [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)] ?? Infinity;
  // Budget: a healthy selection is one RF shell stamp of a few nodes, not a
  // full 80-node remint. 250ms median is generous for CI; local is usually <80.
  expect(median, `selection samples ms=${JSON.stringify(samples)}`).toBeLessThan(250);
});

test("dense canvas: drag commits without mid-gesture snap-back", async ({ vellum }) => {
  const { page } = vellum;

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  const node = page.getByTestId("rf__node-n1");
  await expect(node).toBeVisible({ timeout: 30_000 });

  const before = await node.boundingBox();
  expect(before).toBeTruthy();
  if (!before) return;

  const startX = before.x + before.width / 2;
  const startY = before.y + before.height / 2;
  const t0 = Date.now();
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 120, startY + 80, { steps: 12 });
  // Hold briefly so a deferred kernel/doc rebuild would have a chance to snap.
  await page.waitForTimeout(80);
  await page.mouse.up();
  const dragMs = Date.now() - t0;

  const after = await node.boundingBox();
  expect(after).toBeTruthy();
  if (!after) return;

  expect(Math.abs((after.x ?? 0) - (before.x + 120))).toBeLessThan(40);
  expect(Math.abs((after.y ?? 0) - (before.y + 80))).toBeLessThan(40);
  expect(dragMs, `drag wall ms=${dragMs}`).toBeLessThan(2_000);
});
