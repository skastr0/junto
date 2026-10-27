/**
 * The pad pans on a two-finger scroll and zooms on a pinch, in the real app,
 * dark and bright. A trackpad scroll arrives as a plain wheel; a pinch
 * arrives as a wheel with Ctrl held.
 *
 * Frames land in test-results/pad-pan/.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { Schema } from "effect";
import { Node } from "../../src/shared/model";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";

const CANVAS = "pad-pan";
const OUT = "test-results/pad-pan";

const cameraOf = (svg: Locator) => svg.locator(":scope > g").first().getAttribute("transform");

const drawBox = async (page: Page, x: number, y: number) => {
  await page.getByTestId("pad-tool-box").click();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y + 70, { steps: 4 });
  await page.mouse.up();
};

const setTheme = async (page: Page, mode: "Dark" | "Bright") => {
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
  await page.getByRole("radiogroup", { name: "Theme", exact: true }).getByRole("radio", { name: mode, exact: true }).click();
  if (mode === "Bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
  await page.locator(".settings-panel__close").click();
};

const scaleOf = (transform: string | null) => Number(/scale\(([^)]+)\)/.exec(transform ?? "")?.[1]);

for (const theme of ["dark", "bright"] as const) {
  test(`pad: a two-finger scroll pans, a pinch zooms, ${theme}`, async () => {
    test.setTimeout(180_000);
    const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({
      kind: "artifacts",
      id: "shelf",
      label: "Shelf",
      x: 40,
      y: 40,
      width: 280,
      height: 160,
      z: 0,
    });
    const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([shelf], []) } });
    mkdirSync(OUT, { recursive: true });
    try {
      const { page } = junto;
      const card = page.locator('.react-flow__node[data-id="shelf"]');
      await expect(card).toBeVisible({ timeout: 30_000 });
      await setTheme(page, theme === "bright" ? "Bright" : "Dark");
      await card.dblclick();
      await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
      await page.getByRole("button", { name: "New artifact" }).click();
      await page.getByRole("group", { name: "New artifact" }).locator("button").filter({ hasText: "Pad" }).click();
      const svg = page.getByTestId("pad-svg");
      await expect(svg).toBeVisible({ timeout: 15_000 });
      const box = (await svg.boundingBox())!;
      await drawBox(page, box.x + 80, box.y + 80);
      await drawBox(page, box.x + 260, box.y + 180);
      await page.getByTestId("pad-tool-select").click();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(OUT, `${theme}-1-start.png`) });

      const before = await cameraOf(svg);
      for (let i = 0; i < 6; i += 1) await page.mouse.wheel(30, 20);
      await expect.poll(() => cameraOf(svg)).not.toBe(before);
      // A scroll pans: the view moves, the zoom stays.
      expect(scaleOf(await cameraOf(svg))).toBe(scaleOf(before));
      await page.screenshot({ path: join(OUT, `${theme}-2-panned.png`) });

      const panned = scaleOf(await cameraOf(svg));
      // Pinch over the selected box, so the zoom holds it under the pointer.
      const chosen = (await page.getByTestId("pad-selection").boundingBox())!;
      await page.mouse.move(chosen.x + chosen.width / 2, chosen.y + chosen.height / 2);
      await page.keyboard.down("Control");
      for (let i = 0; i < 3; i += 1) await page.mouse.wheel(0, -30);
      await page.keyboard.up("Control");
      // A pinch zooms in.
      await expect.poll(async () => scaleOf(await cameraOf(svg))).toBeGreaterThan(panned);
      await page.screenshot({ path: join(OUT, `${theme}-3-pinched.png`) });
    } finally {
      await junto.close();
    }
  });
}
