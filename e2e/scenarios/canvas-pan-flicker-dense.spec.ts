/**
 * Dense-board pan-flicker stress — the operator's worst case: ~100 nodes
 * spread across six regions, camera zoomed out to React Flow's minZoom, then
 * sustained heavy panning.
 *
 * One capture window covers the whole sequence: zoom-out (ctrl+wheel pinch
 * path) → continuous circular wheel pan → bursty wheel pan → wide middle-drag
 * pan. The shared instrumentation in e2e/harness/pan-flicker-evidence.ts
 * records busy-gate flips, will-change constancy, DOM churn, long tasks, and
 * CDP metrics; screencast frames become the reviewable video.
 *
 * Run: bun run test:e2e:fast e2e/scenarios/canvas-pan-flicker-dense.spec.ts
 */
import type { CanvasDoc, CanvasEdge, CanvasNode, TextNode } from "../../src/shared/canvas";
import { agentTextNode, canvasDoc, verbEdge } from "../harness/sandbox";
import { expect, test } from "../harness/launch";
import {
  capture,
  installEvidence,
  middleDragPan,
  wheelPan,
  zoomOutToTarget,
} from "../harness/pan-flicker-evidence";

const MIN_ZOOM = 0.15; // Canvas.tsx minZoom={0.15}

// --- fixture -----------------------------------------------------------------
//
// Six regions in a 3×2 spread (~5,000 × 2,300 px board), 16/16/16/16/15/15
// agent seats = 94 seats + 6 groups = exactly 100 nodes. Agents chain within
// a region and relay across region boundaries (agent→agent admits
// "messages"), so every region has live wire paths.

const seat = (id: string, keyIndex: number): TextNode =>
  agentTextNode({
    id,
    key: `local:dense-${keyIndex}`,
    label: `dense seat ${keyIndex}`,
    x: 0,
    y: 0,
  });

type Placement = { readonly x: number; readonly y: number };

const place = (node: TextNode, at: Placement): TextNode => ({ ...node, x: at.x, y: at.y });

const buildBoard = (): CanvasDoc => {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];

  const seatsPerRegion = [16, 16, 16, 16, 15, 15];
  const origin = (index: number): Placement => ({
    x: (index % 3) * 1_820,
    y: Math.floor(index / 3) * 1_620,
  });

  let seatIndex = 0;
  const regionHeads: string[] = [];
  let previousTail: string | undefined;

  seatsPerRegion.forEach((count, regionIndex) => {
    const at = origin(regionIndex);
    const id = `rg-${regionIndex + 1}`;
    nodes.push({ id, type: "group", label: `region ${regionIndex + 1}`, x: at.x, y: at.y, width: 1_420, height: 720 });
    const members: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const member = place(seat(`${id}-s${i}`, seatIndex), {
        x: at.x + 30 + (i % 4) * 270,
        y: at.y + 56 + Math.floor(i / 4) * 130,
      });
      seatIndex += 1;
      nodes.push(member);
      members.push(member.id);
    }
    // Relay chain across the region.
    for (let i = 0; i < members.length - 1; i += 1) {
      edges.push(verbEdge(`e-${id}-${i}`, members[i]!, members[i + 1]!, "messages", nodes));
    }
    // Relay the tail into the next region's head.
    if (previousTail) {
      edges.push(verbEdge(`e-xlink-${regionIndex}`, previousTail, members[0]!, "messages", nodes));
    }
    previousTail = members[members.length - 1];
    regionHeads.push(members[0]!);
  });

  return canvasDoc(nodes, edges);
};

const boardDoc = buildBoard();
const NODE_COUNT = boardDoc.nodes.length; // 100
const EDGE_COUNT = boardDoc.edges.length; // 93

/**
 * Nudge the camera so the whole board sits near the viewport center.
 *
 * Boot fitView can settle on a partial layout (it fits before all regions
 * report bounds), and at minZoom the board must be ON SCREEN for the pan
 * evidence to show anything. Measures the union of mounted node rects and
 * dispatches one plain-wheel pan with the exact corrective delta — the same
 * panOnScroll path a trackpad user produces.
 */
async function centerBoardInViewport(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const nodes = document.querySelectorAll(".react-flow__node");
    if (nodes.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    nodes.forEach((node) => {
      const rect = node.getBoundingClientRect();
      minX = Math.min(minX, rect.x);
      minY = Math.min(minY, rect.y);
      maxX = Math.max(maxX, rect.x + rect.width);
      maxY = Math.max(maxY, rect.y + rect.height);
    });
    const viewport = document.querySelector(".react-flow");
    const bounds = viewport?.getBoundingClientRect();
    if (!bounds || !Number.isFinite(minX)) return;
    const shiftX = bounds.x + bounds.width / 2 - (minX + maxX) / 2;
    const shiftY = bounds.y + bounds.height / 2 - (minY + maxY) / 2;
    // panOnScroll: screen shift = -delta × panOnScrollSpeed (1.2).
    document
      .querySelector(".react-flow__pane")
      ?.dispatchEvent(
        new WheelEvent("wheel", {
          deltaX: -shiftX / 1.2,
          deltaY: -shiftY / 1.2,
          bubbles: true,
          cancelable: true,
        }),
      );
  });
  await page.waitForTimeout(400);
}

test.use({
  vellumOptions: {
    seedCanvases: { dense: boardDoc },
  },
});

test.describe("dense board pan flicker stress", () => {
  test.setTimeout(300_000);

  test("100 nodes across six regions: zoom out to max, then pan hard", async ({ vellumCommand }) => {
    const { app, page } = vellumCommand;
    await installEvidence(page);

    // Boot + settle + max zoom-out BEFORE arming the capture window.
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".react-flow__node")).toHaveCount(NODE_COUNT, { timeout: 30_000 });
    await expect(page.locator(".react-flow__edge")).toHaveCount(EDGE_COUNT, { timeout: 30_000 });
    await page.waitForTimeout(1_500);

    const heavyPan = async (p: import("@playwright/test").Page): Promise<void> => {
      // Max zoom-out first (inside the capture window — the video shows it).
      const scale = await zoomOutToTarget(p, MIN_ZOOM);
      console.log(`DENSE-ZOOM-OUT scale=${scale}`);
      // minZoom is 0.15 — the camera must reach it.
      expect(scale, `zoom-out did not reach minZoom (scale ${scale})`).toBeLessThanOrEqual(MIN_ZOOM + 0.005);
      // All 100 nodes stay mounted at max zoom-out (groups have no
      // .vellum-node card — the wrapper class covers every node).
      await expect(p.locator(".react-flow__node")).toHaveCount(NODE_COUNT, { timeout: 15_000 });

      // Recenter so the whole dense board is on screen, then pan across it.
      await centerBoardInViewport(p);

      // Wheel deltas are a VELOCITY under panOnScroll (screen px/s ≈ delta ×
      // 1.2 × 80 events/s), so small radii keep the camera's circular orbit
      // on the board; the fling is the one realistic "operator throws the
      // trackpad" segment. The closing drag is position-controlled (1:1
      // screen px) — 3 full circles with all 100 nodes continuously visible.
      // 6s moderate continuous wheel pan (orbit ~180 px)…
      await wheelPan(p, 6_000, false, 3);
      // …6s bursty wheel pan (the shape that used to flap the busy latch)…
      await wheelPan(p, 6_000, true, 3);
      // …3s hard fling across the board…
      await wheelPan(p, 3_000, false, 40);
      // …then recenter and sweep: 3 full drag circles, position-controlled.
      await centerBoardInViewport(p);
      await middleDragPan(p, 220, 432);
    };

    await capture({ app, page, nodeCount: NODE_COUNT, edgeCount: EDGE_COUNT }, "dense-six-regions-max-zoom-out", heavyPan);
  });
});
