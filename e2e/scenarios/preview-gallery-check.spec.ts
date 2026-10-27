/**
 * Real-app check of the preview card gallery (#/gallery/previews), dark and bright:
 * block height, where a block opens, where a card opens, the resized box, the rings.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/preview-gallery-check";
const opened = (page: Page) => page.getByTestId("preview-gallery-opened");

test("preview gallery in the real app, bright and dark", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 1000 } });
  const report: Record<string, unknown> = {};
  try {
    const { page } = junto;
    await page.waitForLoadState("domcontentloaded");
    for (const theme of ["bright", "dark"] as const) {
      const base = page.url().split("#")[0]!;
      await page.goto(base);
      await page.reload();
      await page.waitForFunction(() => window.junto !== undefined);
      await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(theme === "bright" ? "bright" : null);
      await page.goto(`${base}#/gallery/previews`);
      await page.reload();
      await expect(opened(page)).toHaveText("Nothing opened yet", { timeout: 30_000 });
      const facts: Record<string, unknown> = {};
      report[theme] = facts;
      mkdirSync(join(SHOTS, theme), { recursive: true });
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(SHOTS, theme, "1-gallery.png") });

      // (1) every block card is 72px high.
      const blocks = page.locator('[data-testid="preview-card"][data-size="block"]');
      const heights = await blocks.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
      facts.blocks = { count: heights.length, heights: [...new Set(heights)] };
      expect(heights.length).toBeGreaterThan(15);
      expect(new Set(heights)).toEqual(new Set([72]));

      // (2) a block: the body opens nothing; the title opens; Enter on the title opens.
      const first = blocks.first();
      const box = (await first.boundingBox())!;
      await first.click({ position: { x: box.width - 24, y: box.height / 2 } });
      await expect(opened(page)).toHaveText("Nothing opened yet");
      await first.click({ position: { x: box.width / 2, y: box.height - 8 }, force: true });
      await expect(opened(page)).toHaveText("Nothing opened yet");
      facts.blockBodyClick = await opened(page).innerText();
      await first.getByTestId("preview-card-open").click();
      await expect(opened(page)).toHaveText("Opened task 1, block");
      const second = blocks.nth(1).getByTestId("preview-card-open");
      await second.focus();
      await page.keyboard.press("Enter");
      await expect(opened(page)).toHaveText("Opened task 2, block");
      facts.blockTitle = ["Opened task 1, block", "Opened task 2, block (Enter)"];
      await page.screenshot({ path: join(SHOTS, theme, "2-block-opened.png") });

      // (3) a card opens on a click anywhere and on Enter; the first card of each section fills 220 by 96.
      const cards = page.locator('[data-testid="preview-card"][data-size="card"]');
      const sizes = await cards.evaluateAll((els) => els.map((e) => ({ kind: (e as HTMLElement).dataset.kind, w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) })));
      const wrapSizes = await cards.evaluateAll((els) => els.map((e) => { const r = (e.parentElement as HTMLElement).getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; }));
      facts.cardSizes = sizes.map((s, i) => `${s.kind} ${s.w}x${s.h} in ${wrapSizes[i]!.w}x${wrapSizes[i]!.h}`);
      const firsts = [0, 5, 10, 15];
      for (const i of firsts) {
        expect(wrapSizes[i], `card ${i} box`).toEqual({ w: 220, h: 96 });
        expect(sizes[i]!.w, `card ${i} fills the width`).toBe(220);
        expect(sizes[i]!.h, `card ${i} fills the height`).toBe(96);
      }
      const pad = cards.nth(12); // Artifact section, "Feed sketch" pad
      expect(await pad.getAttribute("aria-label")).toBe("Open Feed sketch");
      const pb = (await pad.boundingBox())!;
      await pad.click({ position: { x: 6, y: pb.height - 6 } });
      await expect(opened(page)).toHaveText("Opened artifact 3, card");
      await cards.nth(11).focus();
      await page.keyboard.press("Enter");
      await expect(opened(page)).toHaveText("Opened artifact 2, card");
      await cards.nth(10).focus();
      await page.keyboard.press("Space");
      await expect(opened(page)).toHaveText("Opened artifact 1, card");
      facts.cardOpens = ["click bottom-left corner of the pad card", "Enter on the sheet card", "Space on the document card"];
      await page.screenshot({ path: join(SHOTS, theme, "3-card-opened.png") });

      // (4) rings animate: running animations, and a ring's transform changes between samples.
      const sample = () =>
        page.evaluate(() => {
          const running = document.getAnimations().filter((a) => a.playState === "running");
          const names = new Set(running.map((a) => (a as CSSAnimation).animationName ?? a.constructor.name));
          const targets = running.slice(0, 40).map((a) => {
            const el = (a.effect as KeyframeEffect | null)?.target as HTMLElement | null;
            return el ? getComputedStyle(el).transform + "|" + getComputedStyle(el).opacity : "";
          });
          return { count: running.length, names: [...names].slice(0, 8), targets };
        });
      const a = await sample();
      await page.waitForTimeout(450);
      const b = await sample();
      const changed = a.targets.filter((t, i) => t !== b.targets[i]).length;
      facts.rings = { running: a.count, names: a.names, changedBetweenSamples: changed };
      expect(a.count).toBeGreaterThan(0);
      expect(changed).toBeGreaterThan(0);
    }
    console.log("REPORT", JSON.stringify(report, null, 1));
  } finally {
    console.log("REPORT-PARTIAL", JSON.stringify(report));
    await junto.close();
  }
});
