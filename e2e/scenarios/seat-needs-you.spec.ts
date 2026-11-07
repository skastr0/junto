/**
 * A seat that stops to ask the operator says so where the operator reads it [fake-tui]:
 * its card moves from "working" to "wants your input", the top bar's Needs you button
 * counts it, and both settle again once the seat's dialog is gone.
 *   bun run test:e2e:fast e2e/scenarios/seat-needs-you.spec.ts
 */
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelSeat } from "../harness/model";

const CANVAS = "needsyou";
const SEAT = modelSeat({ id: "scout", label: "Scout", x: 200, y: 120 });

test("a seat that waits on the operator says so on its card and in Needs you, and settles when answered", async () => {
  test.setTimeout(150_000);
  const junto = await launchJunto({
    windowContentSize: { width: 1200, height: 800 },
    seedModels: { [CANVAS]: modelFixture([SEAT]) },
    afterSeed: installCrewSeatHarness,
  });
  const seat = crewSeat(junto.sandbox, CANVAS, "scout");
  try {
    const { page } = junto;
    const card = page.getByRole("group", { name: "Scout" });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    await crewOccupySeat(page, CANVAS, SEAT, seat);
    await seat.ready();
    await expect(page.getByRole("button", { name: "Needs you, nothing waiting" })).toBeVisible();

    await seat.control({ screen: { mode: "working" } });
    await expect(card).toContainText("working", { timeout: 30_000 });
    await expect(card).not.toContainText("wants your input");

    // The seat's own screen shows a dialog that waits on the operator.
    await seat.control({ screen: { mode: "attention" } });
    await expect(card).toContainText("wants your input", { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Needs you, 1" })).toBeVisible();

    // The dialog goes away: the card stops asking and nothing is left waiting.
    await seat.control({ screen: { mode: "idle" } });
    await expect(card).not.toContainText("wants your input", { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Needs you, nothing waiting" })).toBeVisible({ timeout: 30_000 });
  } finally {
    await junto.close();
  }
});
