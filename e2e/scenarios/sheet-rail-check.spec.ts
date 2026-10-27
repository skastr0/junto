/**
 * Real-app check, dark and bright, of the sheet keyboard (7a8f198a2), the sheet column cap (06211dc2b),
 * and the rail wiring (85f734960): a text mark opens the rail on its thread, a rail anchor reveals its
 * quote; also in a container under 56rem. Frames go to JUNTO_SHOTS_DIR.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";

const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/sheet-rail-check";
const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({ kind: "artifacts", id: "shelf", label: "Shelf", x: 60, y: 60, width: 280, height: 160, z: 0 });
const shot = async (page: Page, theme: string, name: string) => {
  mkdirSync(join(SHOTS, theme), { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, theme, `${name}.png`) });
};
const setTheme = async (page: Page, theme: "bright" | "dark") => {
  await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
  await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(theme === "bright" ? "bright" : null);
};
const openShelf = async (page: Page) => {
  await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
  await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
  await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
};
const rect = (page: Page, sel: string) =>
  page.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) } : null; }, sel);

test("sheet keyboard and column cap, dark and bright", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({ windowContentSize: { width: 1700, height: 900 }, seedModels: { sheetcheck: modelFixture([shelf], []) } });
  const rep: Record<string, unknown> = {};
  try {
    const { page } = junto;
    await openShelf(page);
    await page.getByRole("button", { name: "New artifact" }).click();
    await page.getByRole("group", { name: "New artifact" }).locator("button").filter({ hasText: "Sheet" }).click();
    await expect(page.locator(".artifact-head__meta")).toHaveText(/Sheet, version/, { timeout: 15_000 });
    const grid = page.getByRole("grid");
    await expect(grid).toBeVisible();
    for (let i = 0; i < 3; i += 1) await page.getByRole("button", { name: /^\+?\s*Row$/i }).click();
    await page.getByRole("button", { name: /^\+?\s*Column$/i }).click();
    const cells = grid.getByRole("gridcell");
    const selected = () => grid.locator("td[aria-selected=true]").count();
    const rows = () => grid.evaluate((g) => Number(g.getAttribute("aria-rowcount")));
    const text = async (_n: number) => { await page.waitForTimeout(800); return grid.innerText(); };
    for (const theme of ["bright", "dark"] as const) {
      await setTheme(page, theme);
      const f: Record<string, unknown> = {};
      rep[theme] = f;
      // One Tab stop.
      f.tabStops = await grid.evaluate((g) => [...g.querySelectorAll("[tabindex='0']")].length);
      // Column cap in a wide pane.
      f.columnWidths = await grid.locator("th[aria-colindex], th").evaluateAll((ths) => ths.map((t) => Math.round(t.getBoundingClientRect().width)));
      expect(Math.max(...(f.columnWidths as number[]))).toBeLessThanOrEqual(281);
      const gridWidth = (await rect(page, ".junto-artifact-sheet__grid"))!.width;
      f.gridPane = gridWidth;
      const cell = (c: string) => page.locator(`[data-cell="${c}"]`);
      const val = async (c: string) => { await page.waitForTimeout(700); return cell(c).inputValue(); };
      // Typed key starts an edit, Enter commits and moves down.
      await cell("A1").click();
      await page.keyboard.type("Alpha");
      await page.keyboard.press("Enter");
      f.afterTyped = await val("A1");
      expect(f.afterTyped).toBe("Alpha");
      f.focusAfterEnter = await page.evaluate(() => document.activeElement?.getAttribute("data-cell") ?? null);
      expect(f.focusAfterEnter).toBe("A2");
      // Arrow keys move; Shift+Arrow grows a range.
      await page.keyboard.press("ArrowRight");
      const at1 = await page.evaluate(() => document.activeElement?.getAttribute("data-cell"));
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowUp");
      const at2 = await page.evaluate(() => document.activeElement?.getAttribute("data-cell"));
      f.arrows = { afterRight: at1, afterLeftUp: at2 };
      expect(at1).toBe("B2");
      expect(at2).toBe("A1");
      await page.keyboard.press("Shift+ArrowRight");
      f.afterShiftRight = await selected();
      await page.keyboard.press("Shift+ArrowDown");
      f.afterShiftDown = await selected();
      await shot(page, theme, "1-sheet-range");
      expect(f.afterShiftDown as number).toBeGreaterThanOrEqual(4);
      await cell("A1").click();
      // Enter edits, Escape restores.
      await page.keyboard.press("Enter");
      await page.keyboard.type("XYZ");
      await page.keyboard.press("Escape");
      f.afterEscape = await val("A1");
      expect(f.afterEscape).toBe("Alpha");
      // F2 edits and Enter keeps it.
      await page.keyboard.press("F2");
      await page.keyboard.type("2");
      await page.keyboard.press("Enter");
      f.afterF2 = await val("A1");
      expect(f.afterF2).toContain("2");
      await shot(page, theme, "2-sheet-after-edits");
      // Delete clears the cell.
      await cell("A1").click();
      await page.keyboard.press("Delete");
      f.afterDelete = await val("A1");
      expect(f.afterDelete).toBe("");
      // Cmd+Backspace removes the row.
      const before = await rows();
      await cell("A1").click();
      await page.keyboard.press("Meta+Backspace");
      await expect.poll(rows).toBe(before - 1);
      f.rows = { before, after: before - 1 };
      await page.getByRole("button", { name: /^\+?\s*Row$/i }).click();
      await expect.poll(rows).toBe(before);
    }
    console.log("SHEETREPORT", JSON.stringify(rep, null, 1));
  } finally {
    console.log("SHEETREPORT-PARTIAL", JSON.stringify(rep));
    await junto.close();
  }
});

const DOC = ["# Plan", "", ...Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} of filler text that fills the pane.`).flatMap((l) => [l, ""]), "The **closing quote** sits at the very bottom."].join("\n");

for (const width of [1500, 780]) {
  test(`rail wiring at ${width}px: mark opens the rail on its thread, an anchor reveals its quote`, async () => {
    test.setTimeout(240_000);
    const junto = await launchJunto({ windowContentSize: { width, height: 900 }, seedModels: { railcheck: modelFixture([shelf], []) } });
    const rep: Record<string, unknown> = {};
    try {
      const { page } = junto;
      await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
      await page.evaluate(
        ({ node, artifactId, opId, markdown }) =>
          window.junto!.resource!.artifact!.apply("railcheck", node, artifactId, opId, { op: "create", title: "Long plan", body: { type: "document", markdown } }),
        { node: asNodeId("shelf"), artifactId: mintItemId(), opId: mintOpId(), markdown: DOC },
      );
      await openShelf(page);
      await page.getByRole("list", { name: "Artifacts" }).locator("button").filter({ hasText: "Long plan" }).first().click();
      await expect(page.locator(".artifact-head__meta")).toHaveText(/Document, version/, { timeout: 15_000 });
      const scrollAll = (to: "top" | "bottom") =>
        page.evaluate((where) => { for (const e of document.querySelectorAll(".cm-scroller, .artifact-document__live, .two-pane__main")) (e as HTMLElement).scrollTop = where === "top" ? 0 : (e as HTMLElement).scrollHeight; }, to);
      await scrollAll("bottom");
      await page.waitForTimeout(600);
      await expect(page.locator(".cm-md-strong")).toBeVisible({ timeout: 15_000 });
      await page.locator(".cm-md-strong").dblclick();
      await page.getByRole("button", { name: "Comment on selection" }).click();
      await page.getByLabel("New comment").click();
      await page.keyboard.type("Quote check");
      await page.keyboard.press("Meta+Enter");
      const threads = page.getByRole("list", { name: "Threads" });
      await expect(threads.locator(".artifact-thread")).toHaveCount(1, { timeout: 20_000 });
      for (const theme of ["bright", "dark"] as const) {
        await setTheme(page, theme);
        const f: Record<string, unknown> = {};
        rep[theme] = f;
        // Close the rail; the document keeps a mark on the quote; press it.
        if (await page.locator(".artifact-comments").isVisible()) await page.keyboard.press("Meta+Shift+M");
        await expect(page.locator(".artifact-comments-edge")).toBeVisible();
        const mark = page.locator(".artifact-document__anchor");
        await expect(mark).toHaveCount(1, { timeout: 15_000 });
        await mark.click();
        await expect(threads.locator(".artifact-thread[data-revealed='true']")).toContainText("Quote check");
        f.markOpenedRailOnThread = true;
        const main = await rect(page, ".two-pane__main");
        const rail = await rect(page, ".two-pane__rail");
        f.layout = { main, rail, railBelowMain: rail !== null && main !== null && rail.top >= main.bottom - 2 };
        await shot(page, theme, `3-rail-open-${width}`);
        // Scroll the document to the top, then press the rail's anchor: the quote scrolls into view.
        await scrollAll("top");
        await page.waitForTimeout(300);
        const inView = () => page.evaluate(() => {
          const el = document.querySelector(".cm-md-strong") as HTMLElement | null;
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const host = (document.querySelector(".two-pane__main") as HTMLElement).getBoundingClientRect();
          return r.top >= host.top && r.bottom <= host.bottom;
        });
        f.quoteInViewBefore = await inView();
        await threads.locator(".artifact-thread").first().locator(".artifact-thread__anchor").click();
        await page.waitForTimeout(600);
        f.quoteInViewAfterAnchor = await inView();
        await shot(page, theme, `4-anchor-revealed-${width}`);
      }
      console.log("RAILREPORT", width, JSON.stringify(rep, null, 1));
    } finally {
      console.log("RAILREPORT-PARTIAL", width, JSON.stringify(rep));
      await junto.close();
    }
  });
}
