/**
 * Canvas level of detail for regions, on the nested stress board at the
 * operator's display: every tier, dark and bright.
 *
 *   near      gradients, title bars, members, wires as authored
 *   mid       one flat wash per region, no wire labels or pulses
 *   far       nested regions are outlines (one fill per stack), title bars silent
 *   overview  regions only: members and wires unpainted, an outermost region
 *             wears its worst member state and a tally under its name
 *
 * Frames land in test-results/canvas-lod-regions/.
 *
 *   bun run test:e2e:fast e2e/scenarios/canvas-lod-regions.spec.ts
 */
import type { Page } from "@playwright/test";
import { buildNestedCanvasFixture, OPERATOR_DISPLAY } from "../harness/nested-canvas-fixture";
import { expect, test } from "../harness/launch";

const SHOTS = "test-results/canvas-lod-regions";
const fixture = buildNestedCanvasFixture("nested");

test.use({
  juntoOptions: {
    ...OPERATOR_DISPLAY,
    nestedCanvas: { fixture, name: "nested" },
  },
});

const scale = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const viewport = document.querySelector(".react-flow__viewport");
    return viewport ? new DOMMatrix(getComputedStyle(viewport).transform).a : 1;
  });

/** ctrl+wheel (xyflow's pinch path) about the canvas centre until the scale is near `target`. */
const zoomTo = async (page: Page, target: number): Promise<number> => {
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
  return scale(page);
};

const setTheme = async (page: Page, theme: "dark" | "bright") => {
  await page.evaluate(async (next) => {
    await window.junto!.settingsPatch({ appearance: { theme: next } });
  }, theme);
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
};

/** Fit the board, then centre its node bounds (boot fitView can settle early). */
const fitBoard = async (page: Page) => {
  await page.getByRole("button", { name: /fit all/i }).first().click();
  await page.waitForTimeout(1_000);
};

const TIERS = [
  ["near", 0.8],
  ["mid", 0.45],
  ["far", 0.26],
  ["overview", 0.16],
] as const;

test("regions shed detail by tier, and the overview carries the board", async ({ junto }) => {
  test.setTimeout(240_000);
  const { page } = junto;
  await expect(page.locator(".react-flow__node-group")).toHaveCount(fixture.stats.regions, { timeout: 60_000 });
  // Rollups (severity and tallies) land after the camera rests.
  await fitBoard(page);
  await page.waitForTimeout(1_500);

  let mounted: number | undefined;
  for (const theme of ["dark", "bright"] as const) {
    await setTheme(page, theme);
    for (const [tier, zoom] of TIERS) {
      await fitBoard(page);
      await zoomTo(page, zoom);
      await expect(page.locator("html")).toHaveAttribute("data-canvas-tier", tier);
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${SHOTS}/${theme}-${tier}.png` });

      const probe = await page.evaluate(() => {
        const members = [...document.querySelectorAll(".react-flow__node:not(.react-flow__node-group)")];
        const nested = [...document.querySelectorAll('.junto-group:not([data-region-depth="0"])')];
        const tallies = [...document.querySelectorAll(".junto-region-glance__tally")];
        return {
          membersPainted: members.filter((n) => getComputedStyle(n).visibility === "visible").length,
          members: members.length,
          nestedFilled: nested.filter((n) => getComputedStyle(n).backgroundImage !== "none" || getComputedStyle(n).backgroundColor !== "rgba(0, 0, 0, 0)").length,
          gradients: [...document.querySelectorAll(".junto-group")].filter((n) => getComputedStyle(n).backgroundImage !== "none").length,
          talliesShown: tallies.filter((n) => getComputedStyle(n).display !== "none").length,
          stateRings: [...document.querySelectorAll('.junto-group[data-region-depth="0"]')].filter((n) => getComputedStyle(n).outlineStyle === "solid").length,
          depths: [...document.querySelectorAll(".junto-group")].reduce<Record<string, number>>((acc, n) => {
            const key = `${n.getAttribute("data-region-depth") ?? "?"}:${n.getAttribute("data-region-severity") ?? "-"}`;
            acc[key] = (acc[key] ?? 0) + 1;
            return acc;
          }, {}),
          zoom: new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a,
        };
      });
      console.log(`REGION-LOD ${theme} ${tier} ${JSON.stringify(probe)}`);

      // Members stay mounted at every tier (no remount on a flip)...
      mounted ??= probe.members;
      expect(probe.members).toBe(mounted);
      if (tier === "near") {
        expect(probe.membersPainted).toBe(probe.members);
        expect(probe.gradients).toBe(fixture.stats.regions);
        expect(probe.talliesShown).toBe(0);
      } else {
        // ...but only the near tier pays for gradients.
        expect(probe.gradients).toBe(0);
      }
      if (tier === "far" || tier === "overview") expect(probe.nestedFilled).toBe(0);
      if (tier === "overview") {
        expect(probe.membersPainted).toBe(0);
        expect(probe.talliesShown).toBeGreaterThan(0);
        // An outermost region wears a ring exactly when its rollup has a state.
        const stated = Object.entries(probe.depths)
          .filter(([key]) => key.startsWith("0:") && key !== "0:idle" && key !== "0:-")
          .reduce((sum, [, n]) => sum + n, 0);
        expect(probe.stateRings).toBe(stated);
      } else {
        expect(probe.membersPainted).toBe(probe.members);
        expect(probe.talliesShown).toBe(0);
      }
    }
  }
});
