/**
 * Canvas level of detail for regions, on the nested stress board at the
 * operator's display: every tier, dark and bright.
 *
 *   near      gradients, title bars, members, wires as authored
 *   mid       one flat wash per region, no wire labels or pulses
 *   far       every region a wash and frame in its colour, title bars silent
 *   overview  regions and agents: other cards and wires unpainted
 *   every     a region holding blocked, needs-you or review work frames it
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

test("regions shed detail by tier, and the overview carries the board and its agents", async ({ junto }) => {
  test.setTimeout(240_000);
  const { page } = junto;
  await expect(page.locator(".react-flow__node-group")).toHaveCount(fixture.stats.regions, { timeout: 60_000 });
  // Rollups (severity) land after the camera rests.
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
        // Agents stay at the overview (drawn, or gathered into a cluster).
        const cards = [...document.querySelectorAll(".react-flow__node:not(.react-flow__node-group):not(.junto-flow-agent)")];
        const nested = [...document.querySelectorAll('.junto-group:not([data-region-depth="0"])')];
        return {
          membersPainted: members.filter((n) => getComputedStyle(n).visibility === "visible").length,
          cardsPainted: cards.filter((n) => getComputedStyle(n).visibility === "visible").length,
          agentsPainted: members.length - cards.length > 0 ? members.filter((n) => n.classList.contains("junto-flow-agent") && getComputedStyle(n).visibility === "visible").length : 0,
          members: members.length,
          nested: nested.length,
          nestedFilled: nested.filter((n) => getComputedStyle(n).backgroundImage !== "none" || getComputedStyle(n).backgroundColor !== "rgba(0, 0, 0, 0)").length,
          gradients: [...document.querySelectorAll(".junto-group")].filter((n) => getComputedStyle(n).backgroundImage !== "none").length,
          // A region holding urgent work says so at every tier (region-urgency.ts).
          urgent: [...document.querySelectorAll(".junto-group[data-region-urgency]")].length,
          urgentUndrawn: [...document.querySelectorAll(".junto-group[data-region-urgency]")].filter((n) => getComputedStyle(n, "::after").boxShadow === "none").length,
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
      } else {
        // ...but only the near tier pays for gradients.
        expect(probe.gradients).toBe(0);
      }
      // The fixture's open signals make some regions urgent; each draws it.
      expect(probe.urgent).toBeGreaterThan(0);
      expect(probe.urgentUndrawn).toBe(0);
      // Zoomed out, every region is a wash in its colour, nested ones included.
      if (tier === "far" || tier === "overview") expect(probe.nestedFilled).toBe(probe.nested);
      if (tier === "overview") {
        expect(probe.cardsPainted).toBe(0);
        expect(probe.agentsPainted).toBeGreaterThan(0);
      } else {
        expect(probe.membersPainted).toBe(probe.members);
      }
    }
  }
});
