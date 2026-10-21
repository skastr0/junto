import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { modelFixture, modelSeat } from "../harness/model";
import { expect, launchJunto, test } from "../harness/launch";

/**
 * The palette places an Automations node (0.10 plan 07): its catalog card,
 * then the placed node on the canvas. Frames land in
 * test-results/automations-palette/.
 *
 *   scripts/with-app-run-lock.sh scripts/run-e2e.sh e2e/scenarios/automations-palette.spec.ts
 */

const SHOTS = join(process.cwd(), "test-results", "automations-palette");
const CANVAS = "automations";

const fixture = modelFixture([modelSeat({ id: "lead", key: "local:auto-lead", label: "lead", x: 40, y: 40 })]);

test("the palette offers Automations and places one on the canvas", async () => {
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({ seedModels: { [CANVAS]: fixture } });
  try {
    const { page } = junto;
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await expect(page.locator('.react-flow__node[data-id="lead"]')).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "Add canvas item" }).click();
    const deck = page.getByRole("region", { name: "Add canvas item" });
    await expect(deck).toBeVisible();
    await deck.getByLabel("Search nodes and agents").fill("automations");
    const card = deck.getByRole("button", { name: /Automations/ });
    await expect(card).toBeVisible();
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(SHOTS, "01-palette-entry-dark.png") });

    await card.click();
    const placed = page.locator(".react-flow__node").filter({ hasText: "Automations" });
    await expect(placed).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(SHOTS, "02-placed-node-dark.png") });
  } finally {
    await junto.close();
  }
});
