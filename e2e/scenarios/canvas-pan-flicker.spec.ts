/**
 * Pan-flicker evidence capture — a repeatable measurement, not a pass/fail gate.
 *
 * The operator reports that panning the canvas (especially with multiple and
 * nested regions) flickers: the screen flickers, nodes blink. This spec boots
 * the real app on a dense region-heavy fixture and captures, per gesture, the
 * shared instrumentation from e2e/harness/pan-flicker-evidence.ts.
 *
 * Run: bun run test:e2e:fast e2e/scenarios/canvas-pan-flicker.spec.ts
 */
import type { CanvasDoc, CanvasEdge, CanvasNode, TextNode } from "../../src/shared/canvas";
import { agentTextNode, canvasDoc, tasksNode, verbEdge } from "../harness/sandbox";
import { expect, test } from "../harness/launch";
import {
  capture,
  installEvidence,
  middleDragPan,
  wheelPan,
} from "../harness/pan-flicker-evidence";

const GESTURE_MS = 6_000;

// --- fixture -----------------------------------------------------------------
//
// A real factory neighborhood, not a grid of notes: a genuinely nested
// geography — alpha contains bravo, bravo contains delta — plus a sibling
// region charlie.

const seat = (id: string, keyIndex: number): TextNode =>
  agentTextNode({
    id,
    key: `local:flick-${keyIndex}`,
    label: `flick seat ${keyIndex}`,
    x: 0,
    y: 0,
  });

type Placement = { readonly x: number; readonly y: number };
const place = (node: TextNode, at: Placement): TextNode => ({ ...node, x: at.x, y: at.y });

const buildField = (): CanvasDoc => {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];

  // Geography: alpha ⊃ bravo ⊃ delta, charlie standalone.
  const alphaAt = { x: 0, y: 0 };
  const bravoAt = { x: 60, y: 300 };
  const deltaAt = { x: bravoAt.x + 40, y: bravoAt.y + 110 };
  const charlieAt = { x: 1000, y: 0 };

  let seatIndex = 0;
  const cluster = (
    id: string,
    label: string,
    at: Placement,
    width: number,
    height: number,
    seats: number,
    columns: number,
  ): TextNode[] => {
    nodes.push({ id, type: "group", label, x: at.x, y: at.y, width, height });
    const members: TextNode[] = [];
    for (let i = 0; i < seats; i += 1) {
      members.push(place(seat(`${id}-s${i}`, seatIndex++), {
        x: at.x + 30 + (i % columns) * 270,
        y: at.y + 56 + Math.floor(i / columns) * 130,
      }));
    }
    nodes.push(...members);
    return members;
  };

  // 8 seats in alpha (above the nested bravo strip).
  const alphaMembers = cluster("rg-alpha", "alpha", alphaAt, 900, 560, 8, 3);
  // 3 seats in bravo (which nests inside alpha, containing delta).
  const bravoMembers = cluster("rg-bravo", "bravo", bravoAt, 640, 240, 3, 3);
  // 2 seats in delta (double-nested).
  const deltaMembers = cluster("rg-delta", "delta", deltaAt, 560, 120, 2, 2);
  // 6 seats in charlie (sibling region).
  const charlieMembers = cluster("rg-charlie", "charlie", charlieAt, 900, 560, 6, 3);

  const tasks = place(tasksNode({ id: "tasks", x: 1020, y: 620 }), { x: 1020, y: 620 });
  nodes.push(tasks);

  // Wire every agent to the shared tasks sink: agent → task `contributes`.
  for (const member of [...alphaMembers, ...bravoMembers, ...deltaMembers, ...charlieMembers]) {
    edges.push(verbEdge(`e-${member.id}`, member.id, "tasks", "contributes", nodes));
  }
  return canvasDoc(nodes, edges);
};

const fixtureDoc = buildField();
const NODE_COUNT = fixtureDoc.nodes.length;
const EDGE_COUNT = fixtureDoc.edges.length;

test.use({
  juntoOptions: {
    seedCanvases: { flicker: fixtureDoc },
  },
});

// --- tests ------------------------------------------------------------------------

test.describe("canvas pan flicker evidence", () => {
  test.setTimeout(180_000);

  type Capture = { app: import("playwright-core").ElectronApplication; page: import("@playwright/test").Page };

  test("wheel pan on a region-heavy canvas", async ({ junto }) => {
    const { app, page } = junto;
    await installEvidence(page);
    await capture({ app, page, nodeCount: NODE_COUNT, edgeCount: EDGE_COUNT }, "wheel-pan", (p) =>
      wheelPan(p, GESTURE_MS, false),
    );
  });

  test("bursty wheel pan (flaps the busy latch)", async ({ junto }) => {
    const { app, page } = junto;
    await installEvidence(page);
    await capture({ app, page, nodeCount: NODE_COUNT, edgeCount: EDGE_COUNT }, "wheel-pan-bursty", (p) =>
      wheelPan(p, GESTURE_MS, true),
    );
  });

  test("middle-button drag pan", async ({ junto }) => {
    const { app, page } = junto;
    await installEvidence(page);
    await capture({ app, page, nodeCount: NODE_COUNT, edgeCount: EDGE_COUNT }, "middle-drag-pan", (p) =>
      middleDragPan(p),
    );
  });

  test("pan with an active selection keeps node filters stable", async ({ junto }) => {
    const { app, page } = junto;
    await installEvidence(page);

    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".react-flow__node")).toHaveCount(NODE_COUNT, { timeout: 30_000 });
    await page.waitForTimeout(1_500);

    // Engage connection-focus mode (focus cone + dimming) via the node
    // toolbar — the idle fixture has no execution snapshot, so stoppage
    // impact cones never engage, but the dimming CSS family is shared.
    const seat = page.locator(".react-flow__node", { hasText: "flick seat 0" }).first();
    await seat.click();
    // The toolbar mounts only for the selected node and portals outside
    // .react-flow__node (React Flow NodeToolbar).
    await page.locator('[data-testid="node-toolbar-focus"]').first().click();
    await expect(page.locator(".react-flow.connection-focus-mode")).toBeAttached({ timeout: 10_000 });

    // Sample computed filters of three cards (selected, near, far) on a rAF
    // loop while panning. The busy gate may no longer change appearance with
    // the camera: each card's filter must hold exactly one value.
    const filters = await page.evaluate(
      () =>
        new Promise<Record<string, string[]>>((resolve) => {
          const picks = [0, 1, 2].map((i) => {
            const nodes = document.querySelectorAll(".react-flow__node");
            return nodes[i] ?? nodes[nodes.length - 1];
          });
          const seen: Record<string, string[]> = { a: [], b: [], c: [] };
          const start = performance.now();
          const tick = (): void => {
            picks.forEach((el, i) => {
              if (el) seen[["a", "b", "c"][i]!]!.push(getComputedStyle(el).filter);
            });
            if (performance.now() - start < 5_000) requestAnimationFrame(tick);
            else resolve(seen);
          };
          requestAnimationFrame(tick);
          void (async () => {
            // Wheel-pan under the sampler.
            const end = Date.now() + 4_000;
            while (Date.now() < end) {
              const phase = (Date.now() % 4000) / 4000;
              await new Promise<void>((done) => {
                // Playwright mouse is not reachable inside evaluate; dispatch
                // wheel events directly on the pane.
                document
                  .querySelector(".react-flow__pane")
                  ?.dispatchEvent(
                    new WheelEvent("wheel", {
                      deltaX: Math.cos(phase * Math.PI * 2) * 90,
                      deltaY: Math.sin(phase * Math.PI * 2) * 90,
                      bubbles: true,
                      cancelable: true,
                    }),
                  );
                setTimeout(done, 12);
              });
            }
          })();
        }),
    );

    for (const [key, values] of Object.entries(filters)) {
      const distinct = [...new Set(values)];
      expect(
        distinct,
        `node ${key} filter changed during pan: ${distinct.join(" | ")}`,
      ).toHaveLength(1);
    }
  });
});
