/**
 * A real seat is running when the operator quits: the quit check names it.
 *
 * The count used to be a literal 0 in main, so this run said "live work: 0
 * local terminal sessions" and quit without a prompt. The seat's PTY lives in
 * the core's plane, and main asks the core (`term.list`) for it; the line is
 * marked before the prompt opens, so it is the record of what the check saw.
 *
 * The confirm itself is native, and the e2e harness answers native dialogs with
 * "quit anyway" (e2e/harness/launch.ts). The first case proves the check saw
 * the seat and that the quit that follows ends cleanly with the core drained.
 * The second case answers the same dialog with Cancel from the spec, and proves
 * the app stays, the seat stays, and a later accept still quits: the operator's
 * Cancel is not a dead end.
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

test("quit Cancel keeps the app and the seat, and a later quit still works", async () => {
  test.setTimeout(120_000);
  const junto = await launchJunto({
    windowContentSize: { width: 1400, height: 880 },
    seedModels: { [CANVAS]: modelFixture([SEAT]) },
    afterSeed: installCrewSeatHarness,
  });
  const child = junto.app.process();
  const lines: string[] = [];
  let quitting = false;
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
    await crewOccupySeat(junto.page, CANVAS, SEAT, crewSeat(junto.sandbox, CANVAS, "scout"));

    // Answer the honest-quit confirm with Cancel (index 0) for this run.
    await junto.app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
    });
    await junto.app.evaluate(({ app }) => {
      app.quit();
    });

    // The prompt opened on the running seat, and Cancel means the app stays:
    // no will-quit, no exit, and the seat's terminal is still the core's.
    await expect.poll(() => lines.join("\n"), { timeout: 20_000 }).toContain("live work: 1 local terminal session");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(child.exitCode).toBeNull();
    expect(lines.join("\n")).not.toContain("will-quit");
    await expect(junto.page.locator('.react-flow__node[data-id="scout"]')).toBeVisible();
    const [status] = await junto.page.evaluate((canvas) => window.junto!.seatOffboardStatus!(canvas, ["scout"]), CANVAS);
    expect((status!.now as { readonly allowed: boolean }).allowed).toBe(true);
    // The seat's PTY is still the core's: Cancel stopped nothing.
    const sessions = await junto.page.evaluate(() => window.junto!.terminalList());
    expect(sessions.filter((session) => session.status === "running" || session.status === "starting").length).toBeGreaterThan(0);

    // A later accept still quits: Cancel did not wedge the quit path.
    quitting = true;
    await junto.app.evaluate(({ dialog, app }) => {
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
      app.quit();
    });
    await expect.poll(() => lines.join("\n"), { timeout: 30_000 }).toContain("quit, exit code 0");
    console.log(`quit-cancel lines:\n${lines.join("\n")}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await junto.close().catch(() => undefined);
  }
});
