/**
 * The loupe picks a flows wire at every tier its track is drawn. The overview
 * hides every other wire, but a flows track stays there (FlowTrack), so a
 * loupe press on it selects it, as at near and far; at rest the same press
 * still lands on the pane.
 *
 *   bun run test:e2e:fast e2e/scenarios/canvas-flow-track-pick.spec.ts
 */
import type { Page } from "@playwright/test";
import { Node } from "../../src/shared/model";
import { Schema } from "effect";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelRegion, modelWire } from "../harness/model";

const decode = (input: unknown): Node => Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })(input);
const at = (x: number, y: number, width: number, height: number) => ({ x, y, width, height, z: 0 });

const TIERS = [
  ["near", 0.8],
  ["far", 0.26],
  ["overview", 0.15],
] as const;

const scale = (page: Page): Promise<number> =>
  page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a);

/** Ctrl-wheel about the lane's centre until the camera reaches `goal`. */
const zoomTo = async (page: Page, goal: number): Promise<number> => {
  await page.evaluate((target) => {
    const read = (): number =>
      new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a;
    for (let i = 0; i < 200; i += 1) {
      const now = read();
      if (Math.abs(now - target) / target < 0.03) break;
      const lane = document.querySelector('.react-flow__node[data-id="lane"]')!.getBoundingClientRect();
      document.querySelector(".react-flow__pane")?.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: now > target ? 12 : -12,
          ctrlKey: true,
          clientX: lane.x + lane.width / 2,
          clientY: lane.y + lane.height / 2,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  }, goal);
  await page.waitForTimeout(1_200);
  return scale(page);
};

test("the loupe picks a flows wire at near, far and the overview", async () => {
  test.setTimeout(120_000);
  const nodes: Node[] = [
    modelRegion({ id: "lane", label: "release lane", x: 0, y: 0, width: 1000, height: 400 }),
    decode({ kind: "task", id: "build", name: "Build", ...at(60, 70, 300, 200) }),
    decode({ kind: "task", id: "review", name: "Review", ...at(640, 70, 300, 200) }),
  ];
  const junto = await launchJunto({
    seedModels: { "flow-track-pick": modelFixture(nodes, [modelWire("build-review", "build", "review", "flows", nodes)]) },
    windowContentSize: { width: 1720, height: 1080 },
  });
  try {
    const { page } = junto;
    const wire = page.locator('.react-flow__edge[data-id="build-review"] path.junto-edge');
    await expect(page.locator('.react-flow__node[data-id="build"]')).toBeVisible({ timeout: 30_000 });
    await expect(wire).toHaveCount(1, { timeout: 30_000 });

    const midpoint = (): Promise<{ x: number; y: number }> =>
      wire.evaluate((element) => {
        const path = element as SVGPathElement;
        const point = path.getPointAtLength(path.getTotalLength() / 2);
        const matrix = path.getScreenCTM();
        if (!matrix) throw new Error("wire has no screen matrix");
        const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix);
        return { x: screen.x, y: screen.y };
      });
    const clear = async () => {
      await page.mouse.click(4, 4);
      await page.keyboard.press("Escape");
      await expect(wire).not.toHaveClass(/junto-edge--selected/);
    };

    for (const [tier, zoom] of TIERS) {
      await zoomTo(page, zoom);
      await expect(page.locator("html")).toHaveAttribute("data-canvas-tier", tier);
      await clear();
      await expect(page.locator(`.junto-flow-track[data-edge-id="build-review"] .junto-flow-track__run`).first()).toBeVisible();
      const mid = await midpoint();

      // At rest the press lands on the pane.
      await page.mouse.click(mid.x, mid.y);
      await expect(wire, `${tier}: a press at rest does not pick`).not.toHaveClass(/junto-edge--selected/);

      // Loupe held: the same press picks the wire.
      await page.mouse.move(mid.x, mid.y + 30);
      await page.keyboard.down("Alt");
      await expect(page.locator(".react-flow")).toHaveAttribute("data-wires", "shown");
      await page.mouse.click(mid.x, mid.y);
      await page.keyboard.up("Alt");
      await expect(wire, `${tier}: the loupe picks the flows wire`).toHaveClass(/junto-edge--selected/, { timeout: 5_000 });
    }
  } finally {
    await junto.close();
  }
});
