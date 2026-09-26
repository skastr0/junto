/**
 * Simplified region — both themes.
 *
 * A region carries its name, colour, briefing, and folder paths; its rules
 * ride the Tasks gate. The seeded region stores a contract (rules and a
 * pinned ruling) on purpose: a ship build loads it inert and shows none of it.
 * Frames land in test-results/region-simplify/.
 *
 *   JUNTO_FEATURE_PROFILE=ship bunx electron-vite build
 *   JUNTO_FEATURE_PROFILE=ship bun run test:e2e:fast e2e/scenarios/region-simplify.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { CanvasNode, GroupNode } from "../../src/shared/canvas";
import { canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "region-simplify");
// Only a build made with this profile can promise the rules surface is gone.
const SHIP_BUILD = process.env.JUNTO_FEATURE_PROFILE === "ship";

const region: GroupNode = {
  id: "region-1",
  type: "group",
  label: "release lane",
  color: "4",
  x: 40,
  y: 40,
  width: 720,
  height: 420,
  ether: {
    region: {
      hold: true,
      instruction:
        "Ship the signed build to the staging fleet. Keep every change behind a flag until the operator says go.",
      defaults: { paths: { local: "/Users/operator/Projects/junto" } },
      contract: {
        rules: [{ id: "r-1", text: "cite the ticket in every commit" }],
        rulings: [
          { id: "p-1", text: "prices stay in BRL", pinnedAt: "2026-08-01T00:00:00.000Z" },
        ],
      },
    },
  },
};

const note: CanvasNode = {
  id: "note-1",
  type: "text",
  text: "staging checklist",
  x: 120,
  y: 140,
  width: 240,
  height: 96,
};

test.use({ juntoOptions: { seedCanvases: { regions: canvasDoc([region, note]) } } });

const shot = async (page: Page, name: string) => {
  await mkdir(SHOTS, { recursive: true });
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
};

const selectRegion = async (page: Page) => {
  const node = page.getByTestId(`rf__node-${region.id}`);
  await expect(node).toBeVisible({ timeout: 30_000 });
  await node.locator(".region-drag-handle").click();
  await expect(page.getByRole("toolbar", { name: "Region fields" })).toBeVisible();
};

const captureRegion = async (page: Page, theme: string) => {
  await page.getByRole("button", { name: /fit all/iu }).click();
  await selectRegion(page);

  // Pill: folder paths and delete. No connection focus on a region.
  await expect(page.getByRole("button", { name: /Region folder paths/u })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete region" }).first()).toBeVisible();
  await expect(page.locator('[data-testid="node-toolbar-focus"]')).toHaveCount(0);
  // Title bar: the name and the hold lock; no badge decals.
  const titlebar = page.getByTestId("region-titlebar");
  await expect(titlebar.getByLabel("Region holds its contents")).toBeVisible();
  await expect(titlebar.getByLabel("Region has a briefing")).toHaveCount(0);
  await expect(titlebar.getByLabel("Region has folder paths")).toHaveCount(0);
  await shot(page, `${theme}-01-region-selected`);

  await page.getByRole("button", { name: "Region briefing" }).click();
  const briefing = page.getByRole("dialog", { name: "Briefing" });
  await expect(briefing.getByRole("textbox", { name: "Region briefing" })).toHaveValue(
    region.ether!.region!.instruction!,
  );
  if (SHIP_BUILD) {
    await expect(briefing).not.toContainText("Region rules");
    await expect(briefing).not.toContainText(/ruling/iu);
  }
  await shot(page, `${theme}-02-briefing`);
  await briefing.getByRole("button", { name: "Close fields" }).click();
  await expect(briefing).toBeHidden();
};

const setTheme = async (page: Page, mode: "Dark" | "Bright") => {
  // Through the real settings path so every projection (CSS attribute,
  // themeMode$, canvas paint) follows.
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
  await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: mode }).click();
  // Dark is the default edition: only bright stamps html[data-theme].
  if (mode === "Bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
  await page.locator(".settings-panel__close").click();
};

test("region: name, colour, briefing, folder paths; rules gated", async ({ junto }) => {
  const { page } = junto;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

  await setTheme(page, "Dark");
  await captureRegion(page, "dark");
  await setTheme(page, "Bright");
  await captureRegion(page, "bright");
});
