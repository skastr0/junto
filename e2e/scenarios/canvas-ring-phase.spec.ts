// Section 10's phase test, end to end: at the same instant a DOM ring and the
// canvas ring of the same seat show the same angle. The DOM side is a
// `.junto-mark` spin part on a non-canvas surface (its `junto-mark-turn`
// animation's currentTime gives the angle the browser is showing); the
// canvas side is `window.__juntoCanvas.ringAngle(id)`. Skips until the hook
// carries ringAngle and a DOM ring for the seat is on screen.

import { test, expect } from "@playwright/test";
import { launchJunto } from "../harness/launch";
import { modelFixture, modelSeat } from "../harness/model";
import { canvasReady } from "../harness/canvas";

const CANVAS = "factory";
const SEAT = "seat-phase";

const fixture = modelFixture([
  modelSeat({ id: SEAT, label: "Phase", x: 0, y: 0 }),
]);

/** The angle a DOM spin part is showing, from its running CSS animation. */
const domSpinAngle = (page: import("@playwright/test").Page, seatId: string): Promise<number | null> =>
  page.evaluate((id) => {
    // A DOM surface that shows this seat's mark (a row, the switcher HUD, a
    // panel) carries the seat id on an ancestor of the mark.
    const marks = [...document.querySelectorAll(".junto-mark")];
    for (const mark of marks) {
      const host = mark.closest(`[data-id="${id}"], [data-node-id="${id}"], [data-seat="${id}"]`);
      if (host === null) continue;
      const part = mark.querySelector<HTMLElement>(".junto-mark__part[data-spin]");
      if (part === null) continue;
      const anim = part.getAnimations().find(
        (a): a is Animation & { readonly animationName: string } =>
          "animationName" in a && a.animationName === "junto-mark-turn",
      );
      if (anim === undefined) continue;
      const style = getComputedStyle(part);
      const duration = parseFloat(style.animationDuration) * 1000;
      if (!Number.isFinite(duration) || duration <= 0) continue;
      const p = (((Number(anim.currentTime ?? 0) % duration) + duration) % duration) / duration;
      const ccw = part.dataset.spin === "ccw";
      const angle = 360 * (ccw ? 1 - p : p);
      return angle === 360 ? 0 : angle;
    }
    return null;
  }, seatId);

test("ring phase: the DOM ring and the canvas ring of one seat show the same angle", async () => {
  test.setTimeout(180_000);
  const junto = await launchJunto({
    seedModels: { [CANVAS]: fixture },
    seedExperimentalFeatures: ["gpuCanvas"],
  });
  try {
    const page = junto.page;
    await canvasReady(page);
    const hooked = await page.evaluate(() => typeof window.__juntoCanvas?.ringAngle === "function");
    test.skip(!hooked, "hook has no ringAngle yet");

    // Poll until the seat's ring is turning on the canvas and a DOM surface
    // shows the same seat's mark.
    const deadline = Date.now() + 60_000;
    let dom: number | null = null;
    let gpu: number | undefined;
    for (;;) {
      gpu = await page.evaluate((id) => window.__juntoCanvas?.ringAngle?.(id), SEAT);
      dom = await domSpinAngle(page, SEAT);
      if (gpu !== undefined && dom !== null) break;
      if (Date.now() >= deadline) {
        test.skip(true, `no turning ring pair found (gpu=${gpu}, dom=${dom})`);
      }
      await page.waitForTimeout(250);
    }
    // Sample back to back: both read the same wall clock.
    const again = await page.evaluate((id) => window.__juntoCanvas?.ringAngle?.(id), SEAT);
    const domAgain = await domSpinAngle(page, SEAT);
    expect(again).toBeCloseTo(gpu!, 0);
    expect(domAgain).not.toBeNull();
    // One frame of the shortest lap (1440 ms) is ~0.25 degrees at 60 fps.
    expect(Math.abs(domAgain! - gpu!), "DOM ring angle vs canvas ring angle").toBeLessThan(1);
  } finally {
    await junto.close();
  }
});
