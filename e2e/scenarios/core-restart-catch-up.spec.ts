/**
 * Real app: kill -9 the core with a window open. Main starts a new core, asks
 * it every watch again, and the window catches up with no relaunch. The window
 * still shows a seat when the core dies, so its operator hold has to survive
 * too: a new core has no holds, and main sends each window's last report again
 * (term/operator-holds-ipc.ts, junto/ipc.ts).
 *   bun run cli:build && bun run test:e2e:fast e2e/scenarios/core-restart-catch-up.spec.ts
 *
 * The core's pid is read from the core's own log: it prints `[core] pid <n>` as
 * it starts, and main's stdout carries every core's stdio, so the test never
 * has to guess which process in the app's process list is the core. The same
 * log carries each window's report (`[seats] window <id> shows <bindings>`),
 * which is where a report sent again after the restart is read.
 *
 * Both changes after the restart come through the window itself: a canvas
 * command and a settings patch, each answered by the new core, whose push is
 * what the window draws. A settings answer never reaches onSettingsChanged, so
 * the push is the only way that assertion can pass.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";
import { grantOverseer, modelFixture, modelSeat } from "../harness/model";

const CANVAS = "corerestart";
const O = modelSeat({ id: "overseer", label: "Overseer", x: 480, y: 40 });

/** The core's own lines, as main's stdout tee writes them. */
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

/** The ids a window last said it shows, from the core's own report line. */
const windowReports = (log: string): ReadonlyArray<{ readonly at: number; readonly ids: ReadonlyArray<string> }> =>
  [...log.matchAll(/\[seats\] window \d+ shows (.+)$/gmu)]
    .map((match) => ({ at: match.index ?? 0, ids: (match[1] ?? "").split(" ").filter((id) => id.length > 0 && id !== "nothing") }))
    .filter((report) => report.ids.length > 0);

test("a window and its seat's hold survive the core being killed", async () => {
  test.setTimeout(300_000);
  mkdirSync(join(process.cwd(), "test-results"), { recursive: true });
  const logDir = mkdtempSync(join(process.cwd(), "test-results", "core-restart-log-"));
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

    // Opening the seat's terminal in the window is what makes it report the
    // binding to the core; a seat the window does not show is not held.
    await page.locator('.react-flow__node[data-id="overseer"]').dblclick();
    await expect(page.locator(".xterm").first()).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => windowReports(coreLog(logDir)).length, { timeout: 60_000 })
      .toBeGreaterThan(0);
    const shownBefore = windowReports(coreLog(logDir)).at(-1)!.ids;

    // The core's pid, from the core's own first line.
    await expect.poll(() => pidsIn(coreLog(logDir)).length, { timeout: 60_000 }).toBeGreaterThan(0);
    const before = pidsIn(coreLog(logDir))[0]!;
    await page.evaluate(() => {
      const heard = { restarted: 0, settings: [] as string[] };
      (window as unknown as { __heard: typeof heard }).__heard = heard;
      window.junto!.onCoreRestarted(() => { heard.restarted += 1; });
      window.junto!.onSettingsChanged((settings) => { heard.settings.push(settings.appearance.theme); });
    });

    process.kill(before, "SIGKILL");
    // Main starts a new core: a second pid, different from the first.
    await expect
      .poll(() => pidsIn(coreLog(logDir)).filter((pid) => pid !== before).length, { timeout: 60_000 })
      .toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __heard: { restarted: number } }).__heard.restarted), { timeout: 150_000 }).toBeGreaterThan(0);

    // The window still shows the seat, and the new core is told so again: the
    // hold is back where the cache cut asks, without the operator touching it.
    await expect
      .poll(() => {
        const log = coreLog(logDir);
        const restartedAt = log.lastIndexOf("[core] pid");
        return windowReports(log).some((report) => report.at > restartedAt && shownBefore.every((id) => report.ids.includes(id)));
      }, { timeout: 120_000 })
      .toBe(true);

    // A canvas change after the core returned reaches the open window: the
    // window's own authoring path, through main to the new core and back on
    // its push.
    const noteId = "after-restart";
    const added = await page.evaluate(async (id) => {
      return window.junto!.modelCommand({
        _tag: "Add",
        canvas: "corerestart",
        nodes: [{ id, kind: "note", text: "Written after the restart.", x: 40, y: 320, width: 220, height: 84, z: 0 }],
        wires: [],
      } as never);
    }, noteId);
    expect(added, "the new core took the window's authoring").toBeTruthy();
    await expect(page.getByText("Written after the restart.")).toBeVisible({ timeout: 15_000 });

    // A setting changed after the core returned reaches the window on the new core's push.
    const theme = await page.evaluate(async () => {
      const got = await window.junto!.settingsGet();
      const next = got.settings?.appearance.theme === "bright" ? "dark" : "bright";
      await window.junto!.settingsPatch({ appearance: { theme: next } });
      return next;
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __heard: { settings: string[] } }).__heard.settings.at(-1)), { timeout: 15_000 }).toBe(theme);

    // A quit asked with a seat open still finishes: the core drains and the app goes.
    // The close event is watched before the ask, since the app may go at once.
    const closed = junto.app.waitForEvent("close");
    await junto.app.evaluate(({ app }) => { app.quit(); });
    const outcome = await Promise.race([
      closed.then(() => "closed" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => { resolve("timeout"); }, 120_000)),
    ]);
    expect(outcome, "the app quit with a seat open").toBe("closed");
  } finally {
    await junto.close().catch(() => undefined);
  }
});
