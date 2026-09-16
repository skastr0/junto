/** Settings walk — open Settings, screenshot every section. Capture spec. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { canvasDoc, textNode } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "settings-audit");

test("walk every settings section", async () => {
  test.setTimeout(240_000);
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({
    seedCanvases: { "settings-audit": canvasDoc([textNode("n1", "note", 0, 0)]) },
  });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    const gear = page.getByRole("button", { name: /settings/i }).first();
    await gear.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(SHOTS, "00-settings-initial.png") });
    const nav = page.locator(".settings-panel__nav button, .settings-nav button, [class*=settings] nav button");
    const count = await nav.count().catch(() => 0);
    for (let i = 0; i < count && i < 10; i += 1) {
      const item = nav.nth(i);
      const name = ((await item.textContent().catch(() => null)) ?? `s${i}`).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24);
      await item.click().catch(() => {});
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(SHOTS, `10-${String(i).padStart(2, "0")}-${name}.png`) });
    }
  } finally {
    await junto.close();
  }
});
