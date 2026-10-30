/**
 * Real app: what still works for a running seat after the core is killed.
 *
 * The kill -9 proof (core-restart-catch-up.spec.ts) shows the window's path
 * comes back. A seat is a different client of the same core: it holds a
 * generation credential minted at spawn, talks over the work control socket,
 * receives mail through the terminal plane, and its state rides the core's
 * registry. This measures all four before and after a SIGKILL of the core and
 * says which survive, so a restart that strands running seats is named.
 *   bun run cli:build && bun run test:e2e:fast e2e/scenarios/core-restart-seats.spec.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { crashCoreNow } from "../harness/crash-core";
import { expect, launchJunto, test } from "../harness/launch";
import { grantOverseer, modelFixture, modelSeat } from "../harness/model";

const CANVAS = "corerestartseats";
const O = modelSeat({ id: "overseer", label: "Overseer", x: 480, y: 40 });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

const coreLog = (dir: string): string => {
  try {
    return readdirSync(dir)
      .sort()
      .map((name) => readFileSync(join(dir, name), "utf8"))
      .join("\n");
  } catch {
    return "";
  }
};

const pidsIn = (log: string): ReadonlyArray<number> =>
  [...log.matchAll(/\[core\] pid (\d+)/gu)].map((match) => Number(match[1]));

/** A process is there if signal 0 is admitted; ESRCH means it is gone. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Known failure, quarantined: measured on 2026-10-30 against a clean build of
 * 94d3c60e6, a core restart leaves a running seat with none of its four ways
 * into Junto (task 01M669F50YX5PR806JQ7GSFK3R). Crash survival was stopped by
 * operator order, so this stays as the record and runs nowhere until that is
 * reopened; remove `fixme` then and it becomes the lock.
 */
test.fixme("a running seat's four ways into Junto, before and after the core is killed", async () => {
  test.setTimeout(300_000);
  mkdirSync(join(process.cwd(), "test-results"), { recursive: true });
  const logDir = mkdtempSync(join(process.cwd(), "test-results", "core-restart-seats-"));
  process.env.JUNTO_E2E_MAIN_LOG = logDir;
  const junto = await launchJunto({
    windowContentSize: { width: 1400, height: 880 },
    seedModels: { [CANVAS]: modelFixture([O]) },
    afterSeed: installCrewSeatHarness,
  });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="overseer"]')).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    const seat = crewSeat(junto.sandbox, CANVAS, "overseer");
    await crewOccupySeat(page, CANVAS, O, seat);
    await grantOverseer(page, CANVAS, "overseer");
    await page.locator('.react-flow__node[data-id="overseer"]').dblclick();
    await expect(page.locator(".xterm").first()).toBeVisible({ timeout: 30_000 });
    const terminal = page.locator(".xterm").first();

    const measure = async (phase: "before" | "after") => {
      // 1. The seat's own work control socket, with the credential it was spawned with.
      const op = await seat
        .op("ping", {}, { awaitMs: 20_000 })
        .then((answer) => answer.ok, (error: unknown) => String(error));
      // 2. The junto CLI, spawned the way a seat spawns it.
      const cli = await seat
        .cli(["ping"], { awaitMs: 20_000 })
        .then((result) => ({ ok: result.ok, exitCode: result.exitCode, stderr: result.stderr.slice(0, 240) }), (error: unknown) => String(error));
      // 3. The terminal still types: keys reach the seat's own PTY.
      const typed = `typed-${phase}`;
      const before = (await seat.stdinLog()).length;
      await terminal.click();
      await page.keyboard.type(`${typed} `);
      await sleep(900);
      const stdin = await seat.stdinLog();
      const typing = { grew: stdin.length > before, arrived: stdin.includes(typed) };
      // 4. The seat's state reaches the core and the window: the seat prints,
      // the observer reads it, the core publishes, main relays.
      await seat.print(`state-${phase}`);
      await sleep(1_200);
      const states = await page.evaluate(async () => {
        const snapshot = await window.junto!.agentSeatStateSnapshot();
        return Array.isArray(snapshot) ? snapshot.map((event) => (event as { state?: string }).state ?? "?") : [];
      });
      return { phase, op, cli, typing, states };
    };

    await page.evaluate(() => {
      const heard: { restarted: number } = { restarted: 0 };
      (window as unknown as { __restart: typeof heard }).__restart = heard;
      window.junto!.onCoreRestarted(() => { heard.restarted += 1; });
    });

    const before = await measure("before");
    await expect.poll(() => pidsIn(coreLog(logDir)).length, { timeout: 60_000 }).toBeGreaterThan(0);
    const killed = await crashCoreNow(junto, logDir);
    await expect.poll(() => pidsIn(coreLog(logDir)).some((pid) => pid !== killed), { timeout: 60_000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __restart: { restarted: number } }).__restart.restarted), { timeout: 150_000 }).toBeGreaterThan(0);
    const after = await measure("after");
    // A second look, with the seat's view opened again: does a fresh attach
    // reach the PTY the first one could not?
    await page.locator('.react-flow__node[data-id="overseer"]').dblclick().catch(() => undefined);
    await sleep(1_500);
    const afterReopen = await measure("after-reopen");

    const seatPid = (await seat.ready()).pid;
    const report = { killed, pids: pidsIn(coreLog(logDir)), seatPid, seatAliveAfter: alive(seatPid), before, after, afterReopen };
    writeFileSync(join(process.cwd(), "test-results", "seat-restart.json"), `${JSON.stringify(report, null, 1)}\n`);
    await test.info().attach("seat-restart.json", { body: JSON.stringify(report, null, 1), contentType: "application/json" });

    // The contract after a restart: a seat that was running keeps every way it
    // had into Junto. Today it keeps none of them, and the view opening again
    // does not bring them back (see the JSON above).
    expect(before.op, "the seat's own socket answers before the kill").toBe(true);
    expect(before.cli, "the seat's CLI reaches the core before the kill").toMatchObject({ ok: true });
    expect(before.typing.grew, "the seat's terminal takes keys before the kill").toBe(true);
    expect(before.states.length, "the seat's state reaches the window before the kill").toBeGreaterThan(0);
    expect(after.op, "the seat's own socket answers after the kill").toBe(true);
    expect(after.cli, "the seat's CLI reaches the core after the kill").toMatchObject({ ok: true });
    expect(after.typing.grew, "the seat's terminal still takes keys after the kill").toBe(true);
    expect(after.states.length, "the seat's state still reaches the window after the kill").toBeGreaterThan(0);
  } finally {
    await junto.close().catch(() => undefined);
  }
});
