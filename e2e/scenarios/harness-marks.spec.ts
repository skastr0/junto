/**
 * Add item, Agents: every harness shows its vendor's own mark in house ink,
 * in both themes. Frames land in test-results/harness-marks/ (disposable,
 * never committed).
 *
 *   electron-vite build
 *   bun run test:e2e:fast e2e/scenarios/harness-marks.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { HARNESS_IDS } from "../../src/shared/managed-terminal-templates";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "harness-marks");
const HARNESSES = HARNESS_IDS.filter((harness) => harness !== "junto-overseer");

test("every harness in Add item wears an ink vector mark in both themes", async () => {
  test.setTimeout(180_000);
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({ seedHarnessInstalls: HARNESSES });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 60_000 });

    for (const mode of ["dark", "bright"] as const) {
      await page.getByRole("button", { name: "Open settings" }).click();
      await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
      const choice = page
        .getByRole("radiogroup", { name: "Theme", exact: true })
        .getByRole("radio", { name: mode === "bright" ? "Bright" : "Dark", exact: true });
      await choice.click();
      await expect(choice).toHaveAttribute("aria-checked", "true");
      await page.locator(".settings-panel__close").click();

      await page.getByRole("button", { name: "Add canvas item" }).click();
      const modal = page.getByRole("dialog", { name: "Add canvas item" });
      const agents = modal.locator('aside[aria-label="Agents"]');
      await expect(agents.locator(".agent-harness-pick__item")).toHaveCount(HARNESSES.length);

      // Every mark is a vector drawn in ink: no raster, no letter placeholder.
      const marks = await agents.locator(".agent-harness-pick__item").evaluateAll((rows) =>
        rows.map((row) => {
          const svg = row.querySelector("svg");
          return {
            name: row.getAttribute("aria-label"),
            fill: svg ? getComputedStyle(svg).fill : null,
            raster: row.querySelector("img") !== null,
          };
        }),
      );
      const ink = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--color-ink)";
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      for (const mark of marks) {
        expect(mark.raster, mark.name ?? "").toBe(false);
        expect(mark.fill, mark.name ?? "").toBe(ink);
      }

      await page.mouse.move(4, 4);
      const list = agents.locator(".agent-harness-pick__list");
      await list.evaluate((node) => (node.scrollTop = 0));
      await agents.screenshot({ path: join(SHOTS, `${mode}-top.png`) });
      await list.evaluate((node) => (node.scrollTop = node.scrollHeight));
      await page.waitForTimeout(150);
      await agents.screenshot({ path: join(SHOTS, `${mode}-bottom.png`) });
      await page.keyboard.press("Escape");
      await expect(modal).toBeHidden();
    }
  } finally {
    await junto.close();
  }
});
