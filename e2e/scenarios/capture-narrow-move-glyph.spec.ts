/**
 * Real app, 7cdf6b49e: in the capture head Move to is a glyph, so a long
 * title keeps its room. Window 700 wide, dark and bright: an existing capture
 * with a 60-character title opened in Cmd+T, the glyph hovered (its native
 * "Move to…" title is read; a native tooltip does not show in a screenshot),
 * the title's drawn width and how many characters fit, then the glyph clicked
 * and the Move to dialog checked open.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/capture-narrow-move-glyph.spec.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode } from "../harness/model";

const CANVAS = "capture-narrow";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/capture-narrow-move-glyph";
const LONG = "Roadmap pricing notes for the partner programme launch review";

const surface = (page: Page) => page.getByRole("dialog", { name: "Quick capture" });
const entry = (page: Page) => page.locator("[data-capture-entry] .cm-content").first();

test("capture head at 700 wide: Move to is a glyph, the long title keeps its room, the glyph opens Move to", async () => {
  test.setTimeout(300_000);
  const junto = await launchJunto({
    windowContentSize: { width: 700, height: 900 },
    seedModels: {
      [CANVAS]: modelFixture([
        modelNode({ kind: "artifacts", id: "notes", label: "Research notes", x: 60, y: 60, width: 300, height: 160, z: 0 }),
        modelNode({ kind: "artifacts", id: "shelf", label: "Shelf", x: 60, y: 300, width: 300, height: 160, z: 0 }),
      ]),
    },
  });
  const { page } = junto;
  const out: Record<string, unknown> = {};
  try {
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await expect(page.locator('.react-flow__node[data-id="notes"]')).toBeVisible({ timeout: 30_000 });
    await page.locator(".react-flow__pane").click({ position: { x: 600, y: 700 } });
    await page.keyboard.press("Meta+t");
    await surface(page).getByRole("button", { name: "Make an Inbox", exact: true }).click({ timeout: 10_000 });
    await expect(entry(page)).toBeFocused({ timeout: 15_000 });
    await page.keyboard.type(LONG);
    await page.keyboard.press("Enter");
    await page.keyboard.type("A body line under the long title.");
    await page.waitForTimeout(2500);
    await page.getByLabel("Search every artifact", { exact: true }).click();
    await page.keyboard.press("Escape");
    if (await surface(page).isVisible()) await page.keyboard.press("Meta+t");
    await expect(surface(page)).toBeHidden({ timeout: 5_000 });

    // Reopen on the existing capture.
    await page.keyboard.press("Meta+t");
    await expect(surface(page)).toBeVisible({ timeout: 10_000 });
    await page.locator(".quick-capture__row").filter({ hasText: "Roadmap pricing" }).first().click({ timeout: 10_000 });
    const title = page.locator(".capture-editor .artifact-head__title");
    await expect(title).toHaveValue(LONG, { timeout: 10_000 });
    const glyph = page.locator('.capture-editor button[aria-label="Move to…"]');
    await expect(glyph).toBeVisible();
    await glyph.hover();
    await page.waitForTimeout(1200);
    for (const theme of ["dark", "bright"] as const) {
      mkdirSync(join(SHOTS, theme), { recursive: true });
      await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
      await page.waitForTimeout(400);
      await glyph.hover();
      await page.screenshot({ path: join(SHOTS, theme, "1-head-glyph-hovered.png") });
      await page.locator(".capture-editor header").first().screenshot({ path: join(SHOTS, theme, "1a-head-crop.png") });
      out[theme] = await title.evaluate((el) => {
        const input = el as HTMLInputElement;
        const s = getComputedStyle(input);
        const ctx = document.createElement("canvas").getContext("2d")!;
        ctx.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
        const charWidth = ctx.measureText("x").width;
        return { width: input.clientWidth, scrollWidth: input.scrollWidth, fontSize: s.fontSize, textOverflow: s.textOverflow, charsThatFit: Math.floor(input.clientWidth / charWidth), length: input.value.length };
      });
    }
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    out.glyph = { title: await glyph.getAttribute("title"), ariaLabel: await glyph.getAttribute("aria-label"), text: (await glyph.innerText()).trim() };
    await glyph.click();
    const dialog = page.getByRole("dialog", { name: /^Move /u });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    out.dialog = await dialog.getAttribute("aria-label").catch(() => null) ?? (await dialog.locator("h2, h1").first().innerText());
    for (const theme of ["dark", "bright"] as const) {
      await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS, theme, "2-move-dialog-open.png") });
    }
  } finally {
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, "read.json"), JSON.stringify(out, null, 2));
    await junto.close();
  }
  console.log("NARROW", JSON.stringify(out));
});
