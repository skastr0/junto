/**
 * Real app, real seat: its state comes from the core process to the window on
 * the push, with nothing injected, and the offboard buttons are answered by the
 * core rather than saying Junto is still starting.
 *   bun run test:e2e:fast e2e/scenarios/seat-state-reaches-window.spec.ts
 */
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelSeat } from "../harness/model";

const CANVAS = "seatstatewindow";
const SEAT = modelSeat({ id: "scout", label: "Scout", x: 480, y: 40 });

test("a running seat's state reaches the window and offboard is answered", async () => {
  test.setTimeout(120_000);
  const junto = await launchJunto({
    windowContentSize: { width: 1400, height: 880 },
    seedModels: { [CANVAS]: modelFixture([SEAT]) },
    afterSeed: installCrewSeatHarness,
  });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="scout"]')).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    await page.evaluate(() => {
      const heard: string[] = [];
      (window as unknown as { __states: string[] }).__states = heard;
      window.junto!.onAgentSeatStateChanged((event) => { heard.push(event.state); });
    });
    await crewOccupySeat(page, CANVAS, SEAT, crewSeat(junto.sandbox, CANVAS, "scout"));
    await expect.poll(() => page.evaluate(() => (window as unknown as { __states: string[] }).__states.length), { timeout: 30_000 }).toBeGreaterThan(0);
    const [status] = await page.evaluate((canvas) => window.junto!.seatOffboardStatus!(canvas, ["scout"]), CANVAS);
    const now = status!.now as { readonly allowed: boolean; readonly reason?: string };
    expect(now.reason ?? "").not.toContain("still starting");
  } finally {
    await junto.close();
  }
});
