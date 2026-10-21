import { modelFixture, modelNode, modelNote, modelSeat } from "../harness/model";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { expect, launchJunto, test } from "../harness/launch";
import { THIS_MACHINE } from "../../tests/support/machines";

/**
 * 0.10 deletions, seen. One canvas, three frames: the canvas, the Add canvas
 * item palette, Settings. Run it before a deletion lands (phase "before",
 * which seeds the node kinds being deleted) and again after (phase "after",
 * which seeds only what survives), then post the pair with `junto feedback
 * --compare`. Frames land in test-results/deletions-0-10/<phase>/.
 *
 *   ZERO_TEN_PHASE=before scripts/with-app-run-lock.sh scripts/run-e2e.sh e2e/scenarios/deletions-0-10.spec.ts
 *   ZERO_TEN_PHASE=after  scripts/with-app-run-lock.sh scripts/run-e2e.sh e2e/scenarios/deletions-0-10.spec.ts
 */

const PHASE = process.env.ZERO_TEN_PHASE === "after" ? "after" : "before";
const SHOTS = join(process.cwd(), "test-results", "deletions-0-10", PHASE);
const CANVAS = "deletions";

const placed = (x: number, y: number) => ({ x, y, width: 240, height: 110, z: 0 });

const surviving = [
  modelSeat({ id: "lead", key: "local:del-lead", label: "lead", x: 40, y: 40 }),
  modelNote("note", "# Field notes\n\nWhat survives 0.10.", 360, 40),
  modelNode({ kind: "task", id: "tasks", name: "Tasks", ...placed(40, 200) }),
  modelNode({ kind: "artifacts", id: "artifacts", label: "Artifacts", ...placed(360, 200) }),
  modelNode({ kind: "sheet", id: "sheet", label: "Sheet", ...placed(680, 40) }),
];

/** Kinds 0.10 deletes (09-deletions.md); decoding fails once a kind is gone. */
const doomed = () => [
  modelNode({ kind: "requests", id: "requests", name: "Requests", ...placed(680, 200) }),
  modelNode({ kind: "board", id: "board", label: "Board", ...placed(1000, 200) }),
  modelNode({ kind: "pad", id: "pad", label: "Pad", ...placed(40, 360) }),
  modelNode({ kind: "cron", id: "cron", label: "Cron", host: THIS_MACHINE, expression: "0 9 * * *", ...placed(360, 360) }),
  modelNode({ kind: "relay", id: "relay", label: "Relay", host: THIS_MACHINE, ...placed(680, 360) }),
  modelNode({ kind: "watcher", id: "watcher", label: "Watcher", host: THIS_MACHINE, ...placed(1000, 360) }),
];

const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
};

test(`0.10 deletions, ${PHASE}: canvas, add palette, settings`, async () => {
  await mkdir(SHOTS, { recursive: true });
  const nodes = PHASE === "before" ? [...surviving, ...doomed()] : surviving;
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture(nodes) } });
  try {
    const { page } = junto;
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await expect(page.locator('.react-flow__node[data-id="lead"]')).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /fit all/i }).click();
    await page.waitForTimeout(800);
    await shot(page, "01-canvas");

    await page.getByRole("button", { name: "Add canvas item" }).click();
    await expect(page.getByRole("region", { name: "Add canvas item" })).toBeVisible();
    await shot(page, "02-add-palette");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Open settings" }).click();
    await shot(page, "03-settings");
    await page.keyboard.press("Escape");
  } finally {
    await junto.close();
  }
});
