/**
 * Real app [fake-tui]: the seat states and onboarding statuses live in the
 * core process, so the window's snapshots of them must ask the core. Main
 * holds no seat: reading its own runtime answers empty.
 *   bun run test:e2e:fast e2e/scenarios/seat-state-window-reads.spec.ts
 */
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelSeat, readModelSeat } from "../harness/model";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";

const CANVAS = "seat-state-window-reads";
const SEAT = "seat-a";

test("[fake-tui] the window's seat state and onboarding snapshots show a seat the core runs", async () => {
  test.setTimeout(180_000);
  const junto = await launchJunto({
    seedModels: { [CANVAS]: modelFixture([modelSeat({ id: SEAT, label: "Ada", x: 120, y: 220 })]) },
    afterSeed: installCrewSeatHarness,
  });
  try {
    const { page, sandbox } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    const seat = crewSeat(sandbox, CANVAS, SEAT);
    const node = await readModelSeat(page, CANVAS, SEAT);
    await crewOccupySeat(page, CANVAS, node!, seat);
    const bindingId = (await readModelSeat(page, CANVAS, SEAT))!.bindingId;

    await seat.control({ screen: { mode: "working" } });
    await expect.poll(async () => (await page.evaluate(() => window.junto!.agentSeatStateSnapshot()))
      .find((event) => event.bindingId === bindingId)?.state, { timeout: 30_000 }).toBe("working");

    // The turn ends unseen in the core; a view from the window clears it there.
    await seat.control({ screen: { mode: "idle" } });
    const stateOf = async () => (await page.evaluate(() => window.junto!.agentSeatStateSnapshot()))
      .find((event) => event.bindingId === bindingId);
    await expect.poll(async () => (await stateOf())?.status?.snapshot.turnUnseen, { timeout: 30_000 }).toBeDefined();
    await page.evaluate((id) => window.junto!.agentSeatViewed(id), bindingId!);
    await expect.poll(async () => (await stateOf())?.status?.snapshot.turnUnseen, { timeout: 15_000 }).toBeUndefined();

    await seat.op("onboard", {});
    await expect.poll(async () => (await page.evaluate(() => window.junto!.seatOnboardingSnapshot!()))
      .find((event) => event.bindingId === bindingId)?.status, { timeout: 30_000 }).toBe("onboarded");
  } finally {
    await junto.close();
  }
});
