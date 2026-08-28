/**
 * Dense-canvas interaction budgets. Catches regressions where selection or
 * drag remints the whole React Flow graph (the failure mode that made the
 * board feel laggy after the impact-mode work).
 *
 * Thresholds are wall-clock from Playwright's side — generous enough for CI
 * variance, tight enough to fail on an O(n) full-graph remint.
 */
import type { CanvasDoc, CanvasEdge, CanvasNode } from "../../src/shared/canvas";
import {
  agentTextNode,
  canvasDoc,
  tasksNode,
  verbEdge,
} from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const COLS = 10;
const ROWS = 8;
const NODE_COUNT = COLS * ROWS;

/**
 * A real factory graph, not a grid of notes: geography admits no verb, so a
 * grid of plain text nodes loses every wire at decode and the budget would be
 * measured on an edgeless canvas. Alternating agent / task kinds make each
 * neighbour pair wireable in exactly one direction — agent → task
 * `contributes`, task → agent `works`.
 */
const kindAt = (row: number, col: number): "agent" | "task" =>
  (row + col) % 2 === 0 ? "agent" : "task";

const denseNodes = (): CanvasNode[] => {
  const nodes: CanvasNode[] = [];
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      const i = row * COLS + col;
      const id = `n${i}`;
      const x = col * 280;
      const y = row * 160;
      nodes.push(
        kindAt(row, col) === "agent"
          ? agentTextNode({
              id,
              key: `local:perf-${i}`,
              label: `Perf node ${i}`,
              x,
              y,
            })
          : { ...tasksNode({ id, x, y }), text: `Perf node ${i}` },
      );
    }
  }
  return nodes;
};

const denseDoc = (): CanvasDoc => {
  const nodes = denseNodes();
  const edges: CanvasEdge[] = [];
  const wire = (id: string, fromRow: number, fromCol: number, to: string) => {
    const from = `n${fromRow * COLS + fromCol}`;
    const verb = kindAt(fromRow, fromCol) === "agent" ? "contributes" : "works";
    edges.push(verbEdge(id, from, to, verb, nodes));
  };
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      const id = `n${row * COLS + col}`;
      if (col > 0) wire(`e-${id}-h`, row, col - 1, id);
      if (row > 0) wire(`e-${id}-v`, row - 1, col, id);
    }
  }
  return canvasDoc(nodes, edges);
};

/** Authored wires — every one must survive decode and reach the canvas. */
const EDGE_COUNT = denseDoc().edges.length;

test.use({
  vellumOptions: {
    seedCanvases: {
      perf: denseDoc(),
    },
  },
});

test("dense canvas: selection stays under interaction budget", async ({ vellumCommand }) => {
  const { page } = vellumCommand;

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  const first = page.getByTestId("rf__node-n0");
  const mid = page.getByTestId(`rf__node-n${Math.floor(NODE_COUNT / 2)}`);
  await expect(first).toBeVisible({ timeout: 30_000 });
  await expect(mid).toBeVisible();

  // The budget is only a budget if the wires are actually on the board: an
  // illegal or verb-less edge is dropped at decode, and a silently edgeless
  // canvas would pass this test for the wrong reason.
  await expect(page.locator('[data-testid^="rf__edge-"]')).toHaveCount(EDGE_COUNT, {
    timeout: 30_000,
  });

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

test("dense canvas: drag commits without mid-gesture snap-back", async ({ vellumCommand }) => {
  const { page } = vellumCommand;

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
