/**
 * A real seat is running when the operator quits: the quit check names it.
 *
 * The count used to be a literal 0 in main, so this run would have said "live
 * work: 0 local terminal sessions" and quit without a prompt. The seat's PTY
 * lives in the core's plane, and main asks the core (`term.list`) for it.
 *
 * The native confirm is Electron's, so this proves the check saw the seat (the
 * `[quit] live work:` line is logged before the dialog opens) and that a quit
 * asked for with a live seat does not proceed on its own: the process is still
 * running when the line lands, and only the signal path ends it.
 *   bun run test:e2e:fast e2e/scenarios/quit-live-seat.spec.ts
 */
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelSeat } from "../harness/model";

const CANVAS = "quitliveseat";
const SEAT = modelSeat({ id: "scout", label: "Scout", x: 480, y: 40 });

test("quit with a running seat names it, and does not quit on its own", async () => {
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
  let exited = false;
  try {
    await expect(junto.page.locator('.react-flow__node[data-id="scout"]')).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(junto.page);
    // A real PTY, in the core's plane, occupied by a seat.
    await crewOccupySeat(junto.page, CANVAS, SEAT, crewSeat(junto.sandbox, CANVAS, "scout"));

    // The operator's quit, from main's own app object: before-quit asks the
    // core what is running before it decides.
    await junto.app.evaluate(({ app }) => {
      app.quit();
    });

    await expect.poll(() => lines.join("\n"), { timeout: 20_000 }).toContain("live work: 1 local terminal session");
    // The prompt is open: main has not gone on to quit, and the seat's PTY is
    // still the core's. Only the signal path ends it (the confirm is native).
    expect(child.exitCode).toBeNull();
    expect(lines.join("\n")).not.toContain("will-quit");
    child.kill("SIGTERM");
    exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 30_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    expect(exited, `quit lines:\n${lines.join("\n")}`).toBe(true);
    console.log(`quit-with-seat lines:\n${lines.join("\n")}`);
  } finally {
    if (!exited && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await junto.close().catch(() => undefined);
  }
});
