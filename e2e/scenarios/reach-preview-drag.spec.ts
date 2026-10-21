import { modelFixture, modelNode, modelRegion, modelSeat } from "../harness/model";
/**
 * Reach preview (plan 0.10/01 rule 6): while the operator drags a seat from
 * one region to its sibling, the cards whose reach the drop would change are
 * ringed before the drop, the grabbed card names the count, and the drop
 * clears every mark.
 *
 * Run: `bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/reach-preview-drag.spec.ts`
 */
import { expect, test } from "../harness/launch";

const OUT = "test-results/reach-preview-drag";

test.use({ juntoOptions: { seedModels: { reach: modelFixture([
  modelRegion({ id: "rg-north", label: "north", x: 0, y: 0, width: 760, height: 300 }),
  modelRegion({ id: "rg-south", label: "south", x: 0, y: 420, width: 760, height: 300 }),
  modelSeat({ id: "seat-alpha", key: "local:reach-alpha", label: "alpha", x: 40, y: 90 }),
  modelNode({ id: "tasks-north", kind: "task", name: "north work", x: 400, y: 80, width: 300, height: 160, z: 0 }),
  modelNode({ id: "tasks-south", kind: "task", name: "south work", x: 400, y: 500, width: 300, height: 160, z: 0 }),
]) } } });

test("a seat dragged to a sibling region shows the reach change before the drop", async ({ junto }) => {
  const { page } = junto;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

  const seat = page.locator('.react-flow__node[data-id="seat-alpha"]');
  const north = page.locator('.react-flow__node[data-id="tasks-north"]');
  const south = page.locator('.react-flow__node[data-id="tasks-south"]');
  await expect(seat).toBeVisible({ timeout: 30_000 });
  await expect(south).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/0-before.png` });

  const from = await seat.boundingBox();
  const target = await south.boundingBox();
  expect(from).not.toBeNull();
  expect(target).not.toBeNull();
  if (!from || !target) return;
  // The seat's name: card body, clear of the wire handles on its edges.
  const label = await seat.getByText("alpha", { exact: true }).boundingBox();
  expect(label).not.toBeNull();
  if (!label) return;
  const grabX = label.x + label.width / 2;
  const grabY = label.y + label.height / 2;
  const dy = target.y - from.y + 10;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX + 4, grabY + 4, { steps: 2 });
  // Halfway, between the regions: the seat is at the root and reaches both.
  await page.mouse.move(grabX, grabY + dy * 0.62, { steps: 12 });
  await expect(south).toHaveAttribute("data-reach-preview", "gains");
  await expect(north).not.toHaveAttribute("data-reach-preview");
  await expect(seat).toHaveAttribute("data-reach-summary", "1 comes into reach");
  await page.screenshot({ path: `${OUT}/1-between.png` });

  // Inside south: north work leaves, south work comes in.
  await page.mouse.move(grabX, grabY + dy, { steps: 12 });
  await expect(north).toHaveAttribute("data-reach-preview", "loses");
  await expect(south).toHaveAttribute("data-reach-preview", "gains");
  await expect(seat).toHaveAttribute("data-reach-preview", "both");
  await expect(seat).toHaveAttribute("data-reach-summary", "1 comes into reach, 1 leaves");
  await page.screenshot({ path: `${OUT}/2-inside-south.png` });

  await page.mouse.up();
  await expect(page.locator(".react-flow__node[data-reach-preview]")).toHaveCount(0);
  await expect(page.locator(".react-flow__node[data-reach-summary]")).toHaveCount(0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/3-dropped.png` });
});
