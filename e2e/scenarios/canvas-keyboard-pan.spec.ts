import { canvasDoc, textNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";
import type { Page } from "@playwright/test";

test.use({
  vellumOptions: {
    seedCanvases: {
      field: canvasDoc([textNode("marker", "Marker", 0, 0)]),
    },
  },
});

const viewport = async (page: Page) =>
  page.locator(".react-flow__viewport").evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.m41, y: matrix.m42, zoom: matrix.a };
  });

const glide = async (page: Page, key: string, ms: number) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
  await page.waitForTimeout(80);
};

test("WASD and arrows fly the canvas, and any focused field keeps its keys", async ({ vellumCommand }) => {
  const { page } = vellumCommand;
  const marker = page.locator(".react-flow__node", { hasText: "Marker" });
  await expect(marker).toBeVisible({ timeout: 30_000 });

  // A focused field owns every key: the note editor takes "wasd" as text and
  // the camera stays put.
  await marker.dblclick();
  const editor = page.locator("textarea.note-edit-inline");
  await expect(editor).toBeFocused();
  const beforeTyping = await viewport(page);
  await editor.fill("");
  await page.keyboard.type("wasd");
  await expect(editor).toHaveValue("wasd");
  const afterTyping = await viewport(page);
  expect(afterTyping.x).toBeCloseTo(beforeTyping.x, 1);
  expect(afterTyping.y).toBeCloseTo(beforeTyping.y, 1);
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);

  // An open focus surface takes the keyboard even with focus off any field.
  await page.getByLabel("Open settings").click();
  await expect(page.locator("[role='dialog']").first()).toBeVisible();
  const beforeModal = await viewport(page);
  await glide(page, "d", 260);
  const afterModal = await viewport(page);
  expect(afterModal.x).toBeCloseTo(beforeModal.x, 1);
  expect(afterModal.y).toBeCloseTo(beforeModal.y, 1);
  await page.keyboard.press("Escape");
  await expect(page.locator("[role='dialog']")).toHaveCount(0);

  // Canvas to itself: D flies the camera right, so the viewport translates left.
  await page.locator(".react-flow__pane").click({ position: { x: 40, y: 40 } });
  const start = await viewport(page);
  await glide(page, "d", 260);
  const afterD = await viewport(page);
  expect(afterD.x).toBeLessThan(start.x - 40);
  expect(Math.abs(afterD.y - start.y)).toBeLessThan(1);
  expect(afterD.zoom).toBeCloseTo(start.zoom, 5);

  // Arrows drive the same camera, and S flies down.
  await glide(page, "ArrowLeft", 260);
  const afterArrow = await viewport(page);
  expect(afterArrow.x).toBeGreaterThan(afterD.x + 40);

  await glide(page, "s", 200);
  expect((await viewport(page)).y).toBeLessThan(afterArrow.y - 30);
});
