/**
 * Desktop notifications on a real desktop: minimise Junto, raise a blocked
 * seat, and capture the native banner macOS shows. Opt-in only: it needs a
 * visible run (banners are off while the harness isolates focus) and it puts
 * a notification on the screen of whoever runs it. macOS delivers banners
 * only to a code-signed app, so against the unsigned development Electron
 * this proves the post and macOS's refusal, not the banner.
 *
 *   electron-vite build
 *   JUNTO_E2E_SHOW=1 bun run test:e2e:fast e2e/scenarios/desktop-notifications-live.spec.ts
 *
 * The screen capture lands in JUNTO_SHOTS_DIR, else
 * test-results/desktop-notifications-live/ (disposable, never committed).
 */
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = process.env.JUNTO_SHOTS_DIR ?? join(process.cwd(), "test-results", "desktop-notifications-live");

const CANVAS = "notify-live";
const seatNode = modelSeat({ id: "live-proof", label: "Maple", x: 40, y: 80 });
const nodes = [modelRegion({ id: "build", label: "Build", color: "4", x: 0, y: 0, width: 600, height: 400 }), seatNode];

test.skip(process.env.JUNTO_E2E_SHOW !== "1" || process.platform !== "darwin", "needs a visible macOS run");

test("a seat blocked while Junto is minimised posts a native banner, and its click brings Junto back", async () => {
  test.setTimeout(120_000);
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture(nodes, []) }, afterSeed: installCrewSeatHarness });
  try {
    const { page, app, sandbox } = junto;
    await expect(page.locator(".react-flow__node", { hasText: "Maple" })).toBeVisible({ timeout: 60_000 });
    // A fake harness sits in Maple's seat, with the real seat CLI.
    await crewPlayFactory(page);
    const maple = crewSeat(sandbox, CANVAS, seatNode.id);
    await crewOccupySeat(page, CANVAS, seatNode, maple);
    expect((await maple.op("onboard", {})).ok, "Maple onboards").toBe(true);

    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.minimize();
    });
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => w.isMinimized())))
      .toBe(true);

    // Watch main's banners: how many were shown, and what macOS said back.
    await app.evaluate(({ Notification }) => {
      const probe = { supported: Notification.isSupported(), shown: 0, displayed: 0, failed: "" };
      (globalThis as { __notifyProbe?: typeof probe }).__notifyProbe = probe;
      const show = Notification.prototype.show;
      Notification.prototype.show = function (this: Electron.Notification) {
        probe.shown += 1;
        (globalThis as { __notifyLast?: Electron.Notification }).__notifyLast = this;
        this.on("show", () => {
          probe.displayed += 1;
        });
        this.on("failed", (_event, error) => {
          probe.failed = String(error);
        });
        return show.call(this);
      };
    });

    // Maple raises a blocked signal itself; the window reports the need to main.
    const raised = await maple.cli(["blocked", "cannot reach the staging database, needs a new password"]);
    expect(raised.ok, `${raised.stdout}${raised.stderr}`).toBe(true);

    // It settles for 1.5 s, then posts; give the banner time to slide in.
    await page.waitForTimeout(3_500);
    execFileSync("screencapture", ["-x", join(SHOTS, "banner.png")]);
    const probe = await app.evaluate(() => (globalThis as { __notifyProbe?: unknown }).__notifyProbe);
    console.log("notification probe", JSON.stringify(probe));
    // Main posted exactly one banner. An unsigned development Electron is
    // refused by macOS (UNErrorDomain error 1); a signed build shows it.
    expect(probe).toMatchObject({ supported: true, shown: 1 });
    expect(
      await app.evaluate(({ app: electron }) => (process.platform === "darwin" ? electron.getBadgeCount() : 1)),
    ).toBe(1);

    // The operator clicks the banner: Junto comes back to the front.
    await app.evaluate(() => {
      (globalThis as { __notifyLast?: Electron.Notification }).__notifyLast?.emit("click");
    });
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => !w.isMinimized())))
      .toBe(true);
  } finally {
    await junto.close();
  }
});
