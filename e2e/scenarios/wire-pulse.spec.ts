/**
 * Wire pulse — a delivered message runs light along its wire [fake-tui].
 *
 * Two fake-tui seats joined by one messages edge drawn A → B. A notice from A
 * to B must light that edge running forward in the notice colour; a prompt
 * from B to A must light the same edge running in reverse in the prompt
 * colour. Both ride the real path: work-control send, delivery onto the
 * seat's PTY, main's wire-traffic push, the canvas edge. Reduced motion
 * holds a static highlight instead of the travelling dash. Each pulse is
 * frozen mid-flight for a screenshot under test-results/wire-pulse/.
 */
import type { Page } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";
import {
  crewDoc,
  crewMessagesEdge,
  crewOccupySeat,
  crewPlayFactory,
  crewSeat,
  crewSeatNode,
  installCrewSeatHarness,
  type CrewSeat,
} from "../harness/crew-fixture";

const SHOTS = process.env.WIRE_PULSE_SHOTS ?? "test-results/wire-pulse";
const CANVAS = "wire-pulse";
const A = "seat-a";
const B = "seat-b";

const seatA = crewSeatNode({ id: A, x: 40, y: 60 });
const seatB = crewSeatNode({ id: B, x: 520, y: 60 });
const pulseDoc = crewDoc([seatA, seatB], [crewMessagesEdge("e-ab", A, B, [seatA, seatB])]);

const seatStateOf = async (from: CrewSeat, target: string): Promise<string> => {
  const read = await from.op("seat.read", { target, lines: 10 });
  if (!read.ok) return "unreadable";
  const state = (read.data as { state?: unknown } | undefined)?.state;
  return typeof state === "string" ? state : "unknown";
};

type PulseSeen = { readonly direction: string | null; readonly stroke: string };

/** Wait for the pulse on the edge, freeze it mid-flight, and describe it. */
const catchPulse = async (page: Page): Promise<PulseSeen> => {
  const pulse = page.locator('[data-id="e-ab"] path.junto-wire-pulse');
  await pulse.waitFor({ state: "attached", timeout: 30_000 });
  return pulse.evaluate((element) => {
    for (const animation of element.getAnimations()) {
      animation.pause();
      animation.currentTime = 380;
    }
    return {
      direction: element.getAttribute("data-direction"),
      stroke: (element as SVGPathElement).style.stroke,
    };
  });
};

const releasePulse = (page: Page) =>
  page.evaluate(() => {
    for (const path of document.querySelectorAll("path.junto-wire-pulse")) {
      for (const animation of path.getAnimations()) animation.finish();
    }
  });

test("wire pulse [fake-tui]: delivered mail lights its wire, sender to receiver", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({
    seedCanvases: { [CANVAS]: pulseDoc },
    afterSeed: installCrewSeatHarness,
  });
  try {
    const { page, sandbox } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    const a = crewSeat(sandbox, CANVAS, A);
    const b = crewSeat(sandbox, CANVAS, B);
    await crewOccupySeat(page, CANVAS, seatA, a);
    await crewOccupySeat(page, CANVAS, seatB, b);
    await expect.poll(() => seatStateOf(a, B), { timeout: 30_000 }).toBe("idle");
    await expect.poll(() => seatStateOf(b, A), { timeout: 30_000 }).toBe("idle");
    await expect(page.locator('[data-id="e-ab"] path.junto-wire-pulse')).toHaveCount(0);

    // A → B notice: forward along A → B, notice colour.
    const notice = catchPulse(page);
    expect((await a.op("msg.send", { target: B, text: "rebase is done" })).ok).toBe(true);
    expect(await notice).toEqual({ direction: "forward", stroke: "var(--color-violet)" });
    await page.screenshot({ path: `${SHOTS}/1-notice-forward.png` });
    await releasePulse(page);
    await expect(page.locator('[data-id="e-ab"] path.junto-wire-pulse')).toHaveCount(0);

    // B → A prompt: the same wire, run in reverse, prompt colour.
    const prompt = catchPulse(page);
    expect((await b.op("msg.prompt", { target: A, text: "Please review the rebase." })).ok).toBe(true);
    expect(await prompt).toEqual({ direction: "reverse", stroke: "var(--color-amber-hi)" });
    await page.screenshot({ path: `${SHOTS}/2-prompt-reverse.png` });
    await releasePulse(page);
    await expect(page.locator('[data-id="e-ab"] path.junto-wire-pulse')).toHaveCount(0);

    // Reduced motion: a brief static highlight, no travelling dash.
    await page.emulateMedia({ reducedMotion: "reduce" });
    const still = catchPulse(page);
    expect((await a.op("msg.send", { target: B, text: "tests pass" })).ok).toBe(true);
    await still;
    const dash = await page
      .locator('[data-id="e-ab"] path.junto-wire-pulse')
      .evaluate((element) => getComputedStyle(element).strokeDasharray);
    expect(dash).toBe("none");
    await page.screenshot({ path: `${SHOTS}/3-reduced-motion.png` });
  } finally {
    await junto.close();
  }
});
