/**
 * A real seat is running when the operator quits: the quit check names it.
 *
 * The count used to be a literal 0 in main, so this run said "live work: 0
 * local terminal sessions" and quit without a prompt. The seat's PTY lives in
 * the core's plane, and main asks the core (`term.list`) for it; the line is
 * marked before the prompt opens, so it is the record of what the check saw.
 *
 * The confirm itself is native, and the e2e harness answers native dialogs with
 * "quit anyway" (e2e/harness/launch.ts). So this proves the check saw the seat
 * and that the quit that follows ends cleanly with the core drained; the
 * Cancel-keeps-the-seat branch is not reachable from here.
 *   bun run test:e2e:fast e2e/scenarios/quit-live-seat.spec.ts
 */
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelSeat } from "../harness/model";

const CANVAS = "quitliveseat";
const SEAT = modelSeat({ id: "scout", label: "Scout", x: 480, y: 40 });

test("quit with a running seat names it, then drains the core and leaves", async () => {
  test.setTimeout(120_000);
  const junto = await launchJunto({
    windowContentSize: { width: 1400, height: 880 },
    seedModels: { [CANVAS]: modelFixture([SEAT]) },
    afterSeed: installCrewSeatHarness,
  });
  const child = junto.app.process();
  const lines: string[] = [];
  const keep = (chunk: Buffer): void => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.includes("[quit]")) lines.push(line.trim().slice(0, 300));
    }
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  try {
    await expect(junto.page.locator('.react-flow__node[data-id="scout"]')).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(junto.page);
    // A real PTY, in the core's plane, occupied by a seat.
    await crewOccupySeat(junto.page, CANVAS, SEAT, crewSeat(junto.sandbox, CANVAS, "scout"));

    // The operator's quit, from main's own app object: before-quit asks the
    // core what is running before it decides, and the harness accepts the
    // native confirm that follows.
    await junto.app.evaluate(({ app }) => {
      app.quit();
    });
    await expect
      .poll(() => lines.join("\n"), { timeout: 20_000 })
      .toContain("live work: 1 local terminal session");
    // The accept path then runs: the children close through their scope (the
    // core drains its plane, the terminals stop last) and the app exits.
    await expect.poll(() => lines.join("\n"), { timeout: 30_000 }).toContain("dispose: child processes");
    await expect.poll(() => lines.join("\n"), { timeout: 30_000 }).toContain("quit, exit code 0");
    console.log(`quit-with-seat lines:\n${lines.join("\n")}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await junto.close().catch(() => undefined);
  }
});
