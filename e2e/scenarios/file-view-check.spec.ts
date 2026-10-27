/**
 * Real-app check of the file viewers (plan 0.11, F6) in the dev gallery
 * (#/gallery/files), dark and bright: pdf.js loads with its bundled worker,
 * every page lays out and the visible ones draw, text selects, zoom and the
 * page field move the view, and a box drawn on a page or on the image hands
 * its comment the shot it rendered (a PDF box at twice the page's size).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/file-view-check";

const drag = async (page: Page, surface: Locator, from: [number, number], to: [number, number]): Promise<void> => {
  const box = (await surface.boundingBox())!;
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + (from[0] + to[0]) / 2, box.y + (from[1] + to[1]) / 2, { steps: 4 });
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 4 });
  await page.mouse.up();
};

test("file viewers in the real app, dark and bright", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({ windowContentSize: { width: 1600, height: 1000 } });
  const report: Record<string, unknown> = {};
  try {
    const { page } = junto;
    await page.waitForLoadState("domcontentloaded");
    for (const theme of ["dark", "bright"] as const) {
      const facts: Record<string, unknown> = {};
      report[theme] = facts;
      mkdirSync(join(SHOTS, theme), { recursive: true });
      const base = page.url().split("#")[0]!;
      await page.goto(`${base}#/gallery/files?theme=${theme}`);
      await page.reload();
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(theme === "bright" ? "bright" : null);

      // (1) pdf.js and its worker load; three pages lay out; page one draws its text layer.
      const pdf = page.getByTestId("pdf-viewer");
      const pages = pdf.getByTestId("pdf-page");
      await expect(pages).toHaveCount(3, { timeout: 30_000 });
      await expect(pdf.getByTestId("pdf-page-count")).toHaveText("of 3");
      const first = pages.nth(0);
      await expect(first.locator(".textLayer span", { hasText: "Junto fixture page one" })).toBeVisible({ timeout: 15_000 });
      facts.canvasDrawn = await first.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
        const context = canvas.getContext("2d")!;
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        let ink = 0;
        for (let at = 0; at < data.length; at += 4) if (data[at]! < 200) ink += 1;
        return { width: canvas.width, height: canvas.height, inkPixels: ink };
      });
      expect((facts.canvasDrawn as { inkPixels: number }).inkPixels).toBeGreaterThan(500);
      const fitted = await pdf.getByTestId("file-view-zoom").innerText();
      facts.fitZoom = fitted;
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS, theme, "1-viewers.png") });

      // (2) text selects: a triple click on the title line selects its words.
      await first.locator(".textLayer span", { hasText: "Junto fixture page one" }).click({ clickCount: 3 });
      facts.selected = await page.evaluate(() => window.getSelection()?.toString().trim());
      expect(facts.selected).toContain("Junto fixture page one");
      await page.screenshot({ path: join(SHOTS, theme, "2-text-selected.png") });
      await page.evaluate(() => window.getSelection()?.removeAllRanges());

      // (3) zoom in leaves fit; the page grows; Fit comes back.
      const widthBefore = (await first.boundingBox())!.width;
      await pdf.getByRole("button", { name: "Zoom in" }).click();
      await expect(pdf.getByTestId("file-view-zoom")).not.toHaveText(fitted);
      await expect(pdf.getByTestId("file-view-fit")).toHaveAttribute("aria-pressed", "false");
      const widthAfter = (await first.boundingBox())!.width;
      facts.zoom = { fitted, zoomed: await pdf.getByTestId("file-view-zoom").innerText(), widthBefore, widthAfter };
      expect(widthAfter).toBeGreaterThan(widthBefore);
      await pdf.getByTestId("file-view-fit").click();
      await expect(pdf.getByTestId("file-view-zoom")).toHaveText(fitted);

      // (4) the page field jumps to page three and scrolls there.
      const field = pdf.getByTestId("pdf-page-input");
      await field.click();
      await field.fill("3");
      await field.press("Enter");
      await expect(pages.nth(2).locator(".textLayer span", { hasText: "Junto fixture page three" })).toBeVisible({ timeout: 15_000 });
      await expect(field).toHaveValue("3");
      await page.screenshot({ path: join(SHOTS, theme, "3-page-three.png") });
      await field.click();
      await field.fill("1");
      await field.press("Enter");

      // (5) the box tool: a drag on page one draws a box; with nothing in reach, Extract says so; Comment hands over a 2x shot.
      await pdf.getByTestId("file-view-box-tool").click();
      await expect(pdf.getByTestId("file-view-box-tool")).toHaveAttribute("aria-pressed", "true");
      await drag(page, first, [80, 300], [380, 420]);
      const draft = first.getByTestId("file-box-draft");
      await expect(draft).toBeVisible();
      await expect(first.getByTestId("file-box-thread")).toHaveCount(1);
      await expect(pdf.getByTestId("file-box-extract")).toBeDisabled();
      facts.extractTitle = await pdf.getByTestId("file-box-extract").getAttribute("title");
      await page.screenshot({ path: join(SHOTS, theme, "4-pdf-box.png") });
      const drawnWidth = (await draft.boundingBox())!.width;
      const pageWidth = (await first.boundingBox())!.width;
      await pdf.getByTestId("file-box-comment").click();
      const said = page.getByTestId("file-view-gallery-said");
      await expect(said).toContainText("Comment on page 1");
      facts.pdfComment = await said.innerText();
      // 612 points wide at 2x: the shot's width is the box's share of 1224 pixels.
      const shotWidth = Number(/shot (\d+) by/u.exec(facts.pdfComment as string)?.[1]);
      expect(Math.abs(shotWidth - (drawnWidth / pageWidth) * 1224)).toBeLessThan(4);
      await expect(draft).toHaveCount(0);
      // B and Escape: Escape drops the tool once no box is drawn.
      await pdf.getByTestId("file-view-box-tool").focus();
      await page.keyboard.press("Escape");
      await expect(pdf.getByTestId("file-view-box-tool")).toHaveAttribute("aria-pressed", "false");

      // (6) the image: fitted, never enlarged; a box on it draws.
      const image = page.getByTestId("image-viewer");
      await expect(image.locator("img")).toBeVisible();
      facts.imageZoom = await image.getByTestId("file-view-zoom").innerText();
      expect(facts.imageZoom).toBe("100%");
      await image.getByTestId("file-view-box-tool").click();
      const surface = image.locator(".file-view__surface");
      await drag(page, surface, [40, 40], [240, 200]);
      await expect(image.getByTestId("file-box-draft")).toBeVisible();
      await page.screenshot({ path: join(SHOTS, theme, "5-image-box.png") });
      await image.getByTestId("file-box-comment").click();
      await expect(said).toContainText("Comment on the image");
      facts.imageComment = await said.innerText();
      // The image's own pixels: a 640 wide image fitted at 100% gives a shot as wide as the box drawn.
      expect(Number(/shot (\d+) by/u.exec(facts.imageComment as string)?.[1])).toBeGreaterThan(190);

      // (7) the keyboard: with the tool on, Enter on a page drops a box, arrows move it, Shift and an arrow grow it.
      await pdf.getByTestId("file-view-box-tool").click();
      await pdf.locator(".file-view__stage").focus();
      await page.keyboard.press("Enter");
      const keyed = pdf.getByTestId("file-box-draft");
      await expect(keyed).toBeVisible();
      const before = (await keyed.boundingBox())!;
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Shift+ArrowDown");
      const after = (await keyed.boundingBox())!;
      facts.keyboardBox = { before, after };
      expect(after.x).toBeGreaterThan(before.x);
      expect(after.height).toBeGreaterThan(before.height);
      await page.screenshot({ path: join(SHOTS, theme, "6-keyboard-box.png") });
      await page.keyboard.press("Escape");
      await expect(keyed).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(pdf.getByTestId("file-view-box-tool")).toHaveAttribute("aria-pressed", "false");

      // (8) what a screen reader is given: the stage and each page are named groups; the view's moves are announced.
      facts.a11y = {
        stage: await pdf.locator(".file-view__stage").getAttribute("aria-label"),
        page: await first.getAttribute("aria-label"),
        announce: await pdf.getByTestId("file-view-announce").innerText(),
      };
      expect(await pdf.locator(".file-view__stage").getAttribute("role")).toBe("group");
      expect(facts.a11y).toMatchObject({ stage: "sample.pdf, 3 pages", page: "Page 1 of 3" });
      expect((facts.a11y as { announce: string }).announce).toMatch(/^Page \d of 3, \d+%$/u);
    }
  } finally {
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, "report.json"), JSON.stringify(report, null, 2));
    await junto.close();
  }
});
