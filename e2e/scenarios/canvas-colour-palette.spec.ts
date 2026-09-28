/**
 * Card and region colour: the palette in the selection bar (presets plus a
 * clear yellow, lime, blue, pink and slate), "+" for any hex with recent
 * custom colours remembered, and every palette colour still reading as a
 * region wash, frame and name at each zoom tier in dark and bright.
 *
 * Frames land in JUNTO_SHOTS_DIR, else test-results/canvas-colour-palette/.
 *
 *   bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/canvas-colour-palette.spec.ts
 */
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { CanvasDoc, CanvasNode } from "../../src/shared/canvas";
import { CANVAS_SWATCHES } from "../../src/shared/canvas-colors";
import { canvasDoc, textNode } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = process.env.JUNTO_SHOTS_DIR ?? join(process.cwd(), "test-results", "canvas-colour-palette");
const CUSTOM = "#b0527a";

/** One named region per palette colour, and one custom, four to a row, each holding a card. */
const regions: CanvasNode[] = [
  ...CANVAS_SWATCHES.map((swatch) => ({ color: swatch.value, label: swatch.label })),
  { color: CUSTOM, label: "custom" },
].flatMap(({ color, label }, index) => {
  const x = (index % 4) * 1_000;
  const y = Math.floor(index / 4) * 760;
  return [
    { id: `region-${label}`, type: "group", label, color, x, y, width: 900, height: 660 },
    { ...textNode(`card-${label}`, `${label} card`, x + 80, y + 120), color },
  ] as CanvasNode[];
});
const doc = canvasDoc([...regions, textNode("note", "Colour me", -600, 0)]);

const setTheme = async (page: Page, theme: "dark" | "bright") => {
  await page.evaluate(async (next) => {
    await window.junto!.settingsPatch({ appearance: { theme: next } });
  }, theme);
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
};

const noteColor = (page: Page): Promise<string | undefined> =>
  page.evaluate(async () => {
    const api = window.junto!;
    const name = (await api.listCanvases())[0]!.name;
    const read = await api.readCanvas(name);
    return (read.doc as CanvasDoc).nodes.find((node) => node.id === "note")?.color;
  });

const recentColors = (page: Page): Promise<readonly string[] | undefined> =>
  page.evaluate(async () => (await window.junto!.settingsGet()).settings?.appearance.recentColors);

/** ctrl+wheel about the canvas centre until the scale is near `target`. */
const zoomTo = async (page: Page, target: number): Promise<void> => {
  await page.evaluate((goal) => {
    const read = (): number => {
      const viewport = document.querySelector(".react-flow__viewport");
      return viewport ? new DOMMatrix(getComputedStyle(viewport).transform).a : 1;
    };
    const flow = document.querySelector(".react-flow")!.getBoundingClientRect();
    for (let i = 0; i < 200; i += 1) {
      const now = read();
      if (Math.abs(now - goal) / goal < 0.04) break;
      document.querySelector(".react-flow__pane")?.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: now > goal ? 20 : -20,
          ctrlKey: true,
          clientX: flow.x + flow.width / 2,
          clientY: flow.y + flow.height / 2 - 60,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  }, target);
  await page.waitForTimeout(900);
};

test("the colour palette offers a clear yellow and remembers custom colours", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({
    windowContentSize: { width: 1600, height: 1000 },
    seedCanvases: { portfolio: doc },
  });
  try {
    const { page } = junto;
    const note = page.locator('.react-flow__node[data-id="note"]');
    await expect(note).toBeVisible({ timeout: 30_000 });
    await note.click();

    const palette = page.getByRole("group", { name: "Colour", exact: true });
    await expect(palette.getByRole("button")).toHaveCount(CANVAS_SWATCHES.length + 2);
    await expect(palette.getByRole("button", { name: "Use the default colour" })).toHaveAttribute("aria-pressed", "true");

    // Yellow is a palette colour stored as hex, painted with the theme's own shade.
    await palette.getByRole("button", { name: "Set yellow" }).click();
    await expect.poll(() => noteColor(page)).toBe("#f1d438");
    await expect(palette.getByRole("button", { name: "Set yellow" })).toHaveAttribute("aria-pressed", "true");

    for (const theme of ["dark", "bright"] as const) {
      await setTheme(page, theme);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(SHOTS, `${theme}-palette.png`) });
    }
    await setTheme(page, "dark");

    // "+" refuses what is not a colour, and says how to write one.
    await palette.getByRole("button", { name: "Choose a custom colour" }).click();
    const custom = page.getByRole("dialog", { name: "Custom colour" });
    const hex = custom.getByRole("textbox", { name: "Custom colour", exact: true });
    await expect(hex).toBeFocused();
    await hex.fill("teal");
    await custom.getByRole("button", { name: "Use", exact: true }).click();
    await expect(custom.getByText("Use 3 or 6 hex digits, like #f5c400.")).toBeVisible();
    await expect.poll(() => noteColor(page)).toBe("#f1d438");

    // Three digits expand; the colour lands on the note and in the recent list.
    await hex.fill("B57");
    await hex.press("Enter");
    await expect(custom).toHaveCount(0);
    await expect.poll(() => noteColor(page)).toBe("#bb5577");
    await expect.poll(() => recentColors(page)).toEqual(["#bb5577"]);
    await expect(palette.getByRole("button", { name: "Custom colour #bb5577, change it" })).toHaveAttribute("aria-pressed", "true");

    // A second custom colour goes first; a recent one applies in one press.
    await palette.getByRole("button", { name: "Custom colour #bb5577, change it" }).click();
    await hex.fill(CUSTOM);
    await custom.getByRole("button", { name: "Use", exact: true }).click();
    await expect.poll(() => recentColors(page)).toEqual([CUSTOM, "#bb5577"]);
    await palette.getByRole("button", { name: `Custom colour ${CUSTOM}, change it` }).click();
    const recent = custom.getByRole("group", { name: "Recent custom colours" });
    await expect(recent.getByRole("button")).toHaveCount(2);
    for (const theme of ["dark", "bright"] as const) {
      await setTheme(page, theme);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(SHOTS, `${theme}-custom.png`) });
    }
    await setTheme(page, "dark");
    await recent.getByRole("button", { name: "Use #bb5577" }).click();
    await expect.poll(() => noteColor(page)).toBe("#bb5577");
    await expect.poll(() => recentColors(page)).toEqual(["#bb5577", CUSTOM]);

    // Typing a palette colour's hex picks the palette swatch, not a new custom one.
    await palette.getByRole("button", { name: "Custom colour #bb5577, change it" }).click();
    await hex.fill("#F1D438");
    await expect(custom.getByText("That is yellow from the palette.")).toBeVisible();
    await hex.press("Enter");
    await expect.poll(() => noteColor(page)).toBe("#f1d438");
    await expect.poll(() => recentColors(page)).toEqual(["#bb5577", CUSTOM]);
    await expect(palette.getByRole("button", { name: "Choose a custom colour" })).toHaveAttribute("aria-pressed", "false");

    // Every palette colour as a region, at every tier, in both themes.
    await page.keyboard.press("Escape");
    for (const theme of ["dark", "bright"] as const) {
      await setTheme(page, theme);
      for (const [tier, zoom] of [["near", 0.8], ["mid", 0.45], ["far", 0.26], ["overview", 0.16]] as const) {
        await page.getByRole("button", { name: /fit all/i }).first().click();
        await page.waitForTimeout(800);
        await zoomTo(page, zoom);
        await expect(page.locator("html")).toHaveAttribute("data-canvas-tier", tier);
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(SHOTS, `${theme}-regions-${tier}.png`) });
      }
    }
  } finally {
    await junto.close();
  }
});
