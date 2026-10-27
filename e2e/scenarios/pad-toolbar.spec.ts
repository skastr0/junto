/**
 * The pad toolbar in the real app, dark and bright: every stencil lands as
 * one write, the selection strip sets status, fill and text on a shape, and
 * two images dropped at once land side by side.
 *
 * Frames land in test-results/pad-toolbar/.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { Node } from "../../src/shared/model";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";

const CANVAS = "pad-toolbar";
const OUT = "test-results/pad-toolbar";

const setTheme = async (page: Page, mode: "Dark" | "Bright") => {
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
  await page.getByRole("radiogroup", { name: "Theme", exact: true }).getByRole("radio", { name: mode, exact: true }).click();
  if (mode === "Bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
  await page.locator(".settings-panel__close").click();
};

const dragFrom = async (page: Page, from: { x: number; y: number }, to: { x: number; y: number }) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
};

/** Drop two generated PNGs on the pad at a client point, as one transfer. */
const dropTwoImages = (page: Page, at: { x: number; y: number }) =>
  page.evaluate(async ({ x, y }) => {
    const png = async (color: string): Promise<File> => {
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 120;
      const context = canvas.getContext("2d")!;
      context.fillStyle = color;
      context.fillRect(0, 0, 160, 120);
      context.fillStyle = "#ffffff";
      context.fillRect(20, 20, 60, 40);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
      return new File([blob], `${color.slice(1)}.png`, { type: "image/png" });
    };
    const transfer = new DataTransfer();
    transfer.items.add(await png("#3a6ea5"));
    transfer.items.add(await png("#a5573a"));
    const stage = document.querySelector(".pad-stage")!;
    stage.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: transfer }));
    stage.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: transfer }));
  }, at);

for (const theme of ["dark", "bright"] as const) {
  test(`pad toolbar: stencils, the selection strip and a two-image drop, ${theme}`, async () => {
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
      const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const shapes = page.getByTestId("pad-shape");

      // Each stencil lands at the centre; move it aside before the next.
      const placed: Array<[string, number, number]> = [
        ["sticky", -260, -150],
        ["decision", 0, -150],
        ["store", 240, -150],
        ["process", -240, 130],
      ];
      let count = 0;
      for (const [stencil, dx, dy] of placed) {
        await page.getByTestId(`pad-stencil-${stencil}`).click();
        count += 1;
        await expect(shapes).toHaveCount(count);
        await dragFrom(page, centre, { x: centre.x + dx, y: centre.y + dy });
      }
      await page.getByTestId("pad-stencil-flow").click();
      await expect(shapes).toHaveCount(count + 2);
      await expect(page.locator('[data-shape-type="diamond"]')).toHaveCount(1);
      await expect(page.locator('[data-shape-type="cylinder"]')).toHaveCount(1);

      // The process step: blocked, a crimson fill, new text.
      await page.mouse.click(centre.x - 240, centre.y + 130);
      const strip = page.getByTestId("pad-selbar");
      await expect(strip).toBeVisible();
      await page.getByTestId("pad-status-blocked").click();
      await expect(page.getByTestId("pad-status-blocked")).toHaveAttribute("aria-pressed", "true");
      await page.getByTestId("pad-fill-crimson").click();
      await page.getByTestId("pad-edit-text").click();
      const text = page.getByRole("textbox", { name: "Shape text" });
      await text.fill("Waiting on review");
      await text.press("Enter");
      await expect(page.locator('[data-shape-type="box"]', { hasText: "Waiting on review" })).toHaveCount(1);
      await page.mouse.click(centre.x - 240, centre.y + 130);
      await expect(strip).toBeVisible();
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(OUT, `${theme}-1-stencils-and-strip.png`) });

      // Two images dropped at once land in one row.
      await page.keyboard.press("Escape");
      await dropTwoImages(page, { x: centre.x + 240, y: centre.y + 150 });
      await expect(page.getByTestId("pad-image")).toHaveCount(2, { timeout: 15_000 });
      const [a, b] = await Promise.all([0, 1].map((i) => page.getByTestId("pad-image").nth(i).boundingBox()));
      expect(Math.abs(a!.y - b!.y)).toBeLessThan(1);
      expect(Math.abs(a!.x - b!.x)).toBeGreaterThan(a!.width);
      await page.getByTestId("pad-tool-select").click();
      await page.mouse.move(box.x + 8, box.y + 8);
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(OUT, `${theme}-2-two-images.png`) });
    } finally {
      await junto.close();
    }
  });
}

for (const theme of ["dark", "bright"] as const) {
  test(`pad toolbar: fits a narrow artifact pane, ${theme}`, async () => {
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
    const junto = await launchJunto({
      seedModels: { [CANVAS]: modelFixture([shelf], []) },
      windowContentSize: { width: 900, height: 720 },
    });
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
      await expect(page.getByTestId("pad-svg")).toBeVisible({ timeout: 15_000 });
      const toolbar = page.getByRole("toolbar", { name: "Pad tools" });
      const bar = (await toolbar.boundingBox())!;
      // Nothing in the toolbar overflows it, and every button is on screen.
      expect(await toolbar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      // The key hint repeats the tool titles, so a narrow pane drops it.
      await expect(toolbar.locator(".pad-toolbar__hint")).toBeHidden();
      for (const button of await toolbar.locator("button").all()) {
        const box = (await button.boundingBox())!;
        expect(box.x + box.width).toBeLessThanOrEqual(bar.x + bar.width + 0.5);
      }
      await page.getByTestId("pad-stencil-process").click();
      await expect(page.getByTestId("pad-selbar")).toBeVisible();
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(OUT, `${theme}-3-narrow.png`) });
      await page.setViewportSize({ width: 1200, height: 720 });
      await page.waitForTimeout(250);
      expect(await toolbar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({ path: join(OUT, `${theme}-4-medium.png`) });
    } finally {
      await junto.close();
    }
  });
}
