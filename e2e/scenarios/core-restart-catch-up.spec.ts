/**
 * Real app: kill -9 the core with a window open. Main starts a new core, asks
 * it every watch again, and the window catches up with no relaunch.
 *   bun run cli:build && bun run test:e2e:fast e2e/scenarios/core-restart-catch-up.spec.ts
 *
 * The canvas change comes from the built CLI, typed in an overseer seat. No CLI
 * command writes settings, so the setting is patched through the bridge; its
 * answer never reaches onSettingsChanged, only the new core's push does.
 */
import { execFileSync } from "node:child_process";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";
import { grantOverseer, modelFixture, modelSeat } from "../harness/model";

const CANVAS = "corerestart";
const O = modelSeat({ id: "overseer", label: "Overseer", x: 480, y: 40 });

/** The core's pid: main's utility child running the core entry, by its service name. */
const corePid = (mainPid: number): number | undefined => {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n");
  for (const row of rows) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(row);
    if (match && Number(match[2]) === mainPid && /--type=utility/u.test(match[3]!) && /Junto Core/iu.test(match[3]!)) return Number(match[1]);
  }
  return undefined;
};

test("a window catches up with a canvas and a setting after the core is killed", async () => {
  test.setTimeout(240_000);
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

    const mainPid = await junto.app.evaluate(() => process.pid);
    const before = corePid(mainPid);
    expect(before, "the core is running").toBeDefined();
    await page.evaluate(() => {
      const heard = { restarted: 0, settings: [] as string[] };
      (window as unknown as { __heard: typeof heard }).__heard = heard;
      window.junto!.onCoreRestarted(() => { heard.restarted += 1; });
      window.junto!.onSettingsChanged((settings) => { heard.settings.push(settings.appearance.theme); });
    });

    process.kill(before!, "SIGKILL");
    await expect.poll(() => { const now = corePid(mainPid); return now !== undefined && now !== before; }, { timeout: 60_000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __heard: { restarted: number } }).__heard.restarted), { timeout: 150_000 }).toBeGreaterThan(0);

    // A canvas change from the CLI after the core returned reaches the open window.
    const created = await seat.cli(["overseer", "node", "create", JSON.stringify({ node: { kind: "note", text: "Written after the restart.", x: 0, y: 0, width: 220, height: 84 } })]);
    expect(created.exitCode, `${created.stdout.slice(0, 300)} ${created.stderr.slice(0, 300)}`).toBe(0);
    await expect(page.getByText("Written after the restart.")).toBeVisible({ timeout: 15_000 });

    // A setting changed after the core returned reaches the window on the new core's push.
    const theme = await page.evaluate(async () => {
      const got = await window.junto!.settingsGet();
      const next = got.settings?.appearance.theme === "bright" ? "dark" : "bright";
      await window.junto!.settingsPatch({ appearance: { theme: next } });
      return next;
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __heard: { settings: string[] } }).__heard.settings.at(-1)), { timeout: 15_000 }).toBe(theme);
  } finally {
    await junto.close();
  }
});
