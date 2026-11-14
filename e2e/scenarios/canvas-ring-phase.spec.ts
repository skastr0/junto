// Section 10's phase test, end to end: at the same instant a DOM ring and the
// canvas ring of the same seat show the same angle. Both seats are forced
// "working" through the state-machine channel, so each carries a turning
// ring. The DOM side is the focus switcher's `.junto-mark` spin part — its
// `junto-mark-turn` animation's currentTime gives the angle the browser is
// showing — read inside one evaluate together with `ringAngle`, so both
// sample the same wall-clock instant. Skips until the hook carries
// ringAngle and a DOM ring for the seat is on screen.

import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { SeatStateMachine } from "../../src/core/term/agent-state";
import { launchJunto } from "../harness/launch";
import { modelFixture, modelSeat } from "../harness/model";
import { canvasReady } from "../harness/canvas";

const CANVAS = "factory";
const SEAT = "seat-phase-a";
const CHANNEL = "junto:agent-seat-state-changed";

const fixture = modelFixture([
  modelSeat({ id: SEAT, key: "local:seat-phase-a", bindingId: "local:seat-phase-a", label: "Phase", x: 0, y: 0 }),
  modelSeat({ id: "seat-phase-b", key: "local:seat-phase-b", bindingId: "local:seat-phase-b", label: "Other", x: 320, y: 0 }),
]);

const send = (app: ElectronApplication, events: ReadonlyArray<unknown>) =>
  app.evaluate(({ BrowserWindow }, { channel, events }) => {
    for (const w of BrowserWindow.getAllWindows()) for (const e of events) w.webContents.send(channel, e);
  }, { channel: CHANNEL, events });

interface AngleSample {
  readonly gpu: number | null;
  readonly dom: number | null;
}

/**
 * One evaluate, one instant: the hook's wall-clock ring angle and the DOM
 * spin part's animation angle for the seat's mark in the focus switcher.
 */
const sampleAngles = (page: Page, seatId: string): Promise<AngleSample> =>
  page.evaluate((id) => {
    const gpu = window.__juntoCanvas?.ringAngle?.(id) ?? null;
    const marks = [...document.querySelectorAll(".junto-mark")];
    for (const mark of marks) {
      const host = mark.closest(`[data-node-id="${id}"], [data-id="${id}"], [data-seat="${id}"]`);
      if (host === null) continue;
      const part = mark.querySelector<HTMLElement>(".junto-mark__part[data-spin]");
      if (part === null) continue;
      const anim = part.getAnimations().find(
        (a): a is Animation & { readonly animationName: string } =>
          "animationName" in a && a.animationName === "junto-mark-turn",
      );
      if (anim === undefined) continue;
      const duration = parseFloat(getComputedStyle(part).animationDuration) * 1000;
      if (!Number.isFinite(duration) || duration <= 0) continue;
      const p = (((Number(anim.currentTime ?? 0) % duration) + duration) % duration) / duration;
      const angle = 360 * (part.dataset.spin === "ccw" ? 1 - p : p);
      return { gpu, dom: angle === 360 ? 0 : angle };
    }
    return { gpu, dom: null };
  }, seatId);

test("ring phase: the DOM ring and the canvas ring of one seat show the same angle", async () => {
  test.setTimeout(180_000);
  const junto = await launchJunto({
    seedModels: { [CANVAS]: fixture },
    seedExperimentalFeatures: ["gpuCanvas"],
  });
  try {
    const { app, page } = junto;
    await canvasReady(page);
    // React Flow mounts first and the feature swap lands the GPU canvas a
    // beat later; wait for the hook before deciding the arm is missing.
    await page
      .waitForFunction(() => typeof window.__juntoCanvas?.ringAngle === "function", undefined, { timeout: 30_000 })
      .catch(() => undefined);
    const hooked = await page.evaluate(() => typeof window.__juntoCanvas?.ringAngle === "function");
    test.skip(!hooked, "hook has no ringAngle yet");

    // Both seats working: each carries a turning ring on either canvas.
    const machine = new SeatStateMachine({ now: () => Date.now() });
    for (const binding of ["local:seat-phase-a", "local:seat-phase-b"]) {
      machine.bind(binding, { harness: "codex", epoch: "probe" });
    }
    await send(app, [
      machine.force("local:seat-phase-a", "working", "probe:working"),
      machine.force("local:seat-phase-b", "working", "probe:working"),
    ]);
    await page.waitForTimeout(1_000);

    // The focus switcher lists every agent's DOM ring; hold Cmd so it stays up.
    await page.keyboard.down("Meta");
    try {
      await page.keyboard.press("Backquote");
      const deadline = Date.now() + 30_000;
      let sample: AngleSample = { gpu: null, dom: null };
      for (;;) {
        sample = await sampleAngles(page, SEAT);
        if (sample.gpu !== null && sample.dom !== null) break;
        if (Date.now() >= deadline) {
          test.skip(true, `no turning ring pair found (${JSON.stringify(sample)})`);
        }
        await page.waitForTimeout(250);
      }
      // Same-instant samples a beat apart must agree: one evaluate reads both.
      const second = await sampleAngles(page, SEAT);
      expect(second.gpu).not.toBeNull();
      expect(second.dom).not.toBeNull();
      // The shortest lap is 1440 ms; a few ms of sampling skew is <1 degree.
      expect(Math.abs(second.dom! - second.gpu!), "DOM ring angle vs canvas ring angle").toBeLessThan(1);
      expect(Math.abs(sample.dom! - sample.gpu!), "first sample pair").toBeLessThan(1);
    } finally {
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.keyboard.up("Meta");
    }
  } finally {
    await junto.close();
  }
});
