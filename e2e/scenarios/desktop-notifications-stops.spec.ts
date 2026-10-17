/**
 * Desktop notifications rank on the need ladder and post stops as Stopped.
 * Opt-in: the plane is off in a hidden harness run, so this needs a visible
 * macOS run. An unsigned development Electron is refused by macOS, so this
 * proves what main posts (probed at Notification.show), not the banner.
 *
 *   electron-vite build
 *   JUNTO_E2E_SHOW=1 bun run test:e2e:fast e2e/scenarios/desktop-notifications-stops.spec.ts
 *
 * Asserts, with Junto minimised:
 *   - a usage limit with its reset time and a sign-in error each post one Stopped banner in the feed's words
 *   - a permission dialog after a Stopped banner replaces it with Needs you
 *   - a declared block then a dialog on one seat posts once
 */
import { Schema } from "effect";
import { encodeAgentSeatStatus } from "../../src/shared/agent-seat-state";
import { defaultNotifications } from "../../src/shared/settings";
import { initialSnapshot, reduceSeatSignals, topNeed, type SeatSignal, type SignalSource } from "../../src/shared/harness-domain";
import { notifyNeed } from "../../src/shared/need-surfaces";
import { BindingId } from "../../src/shared/terminal-session-domain";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";
import { expect, launchJunto, test } from "../harness/launch";

test.skip(process.env.JUNTO_E2E_SHOW !== "1" || process.platform !== "darwin", "needs a visible macOS run");

const CANVAS = "notify-stops";
const MINUTE = 60_000;
const SEATS = [
  ["limit", "Atlas"],
  ["signin", "Brook"],
  ["dialog", "Cedar"],
] as const;

const nodes = [
  modelRegion({ id: "build", label: "Build", color: "4", x: 0, y: 0, width: 1000, height: 460 }),
  ...SEATS.map(([id, label], index) =>
    modelSeat({ id, key: `local:e2e-notify-${id}`, label, x: 40 + index * 270, y: 80 }),
  ),
];

const statusOf = (id: string, at: number, steps: ReadonlyArray<readonly [SignalSource, SeatSignal]>) => {
  const seat = Schema.decodeSync(BindingId)(`local:e2e-notify-${id}`);
  const snapshot = reduceSeatSignals(
    initialSnapshot(seat, at),
    steps.map(([source, signal], index) => ({
      seat,
      at: at + index,
      source,
      fidelity: source === "screen" ? ("screen" as const) : ("native" as const),
      signal,
    })),
  );
  return encodeAgentSeatStatus({ snapshot, need: topNeed(snapshot) });
};

const seatEvent = (id: string, state: string, at: number, extra: { reason?: string; status?: unknown } = {}) => ({
  bindingId: `local:e2e-notify-${id}`,
  epoch: "e2e",
  state,
  reason: extra.reason ?? "test",
  confidence: "high",
  at,
  ...(extra.status === undefined ? {} : { status: extra.status }),
});

type Probe = { shown: { title: string; subtitle: string; body: string }[] };

const watchBanners = (app: import("@playwright/test").ElectronApplication) =>
  app.evaluate(({ Notification }) => {
    const probe: Probe = { shown: [] };
    (globalThis as { __notifyProbe?: Probe }).__notifyProbe = probe;
    const show = Notification.prototype.show;
    Notification.prototype.show = function (this: Electron.Notification) {
      probe.shown.push({ title: this.title, subtitle: this.subtitle, body: this.body });
      return show.call(this);
    };
  });

const banners = (app: import("@playwright/test").ElectronApplication) =>
  app.evaluate(() => (globalThis as { __notifyProbe?: Probe }).__notifyProbe?.shown ?? []);

const minimise = async (app: import("@playwright/test").ElectronApplication) => {
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.minimize();
  });
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => w.isMinimized())))
    .toBe(true);
};

const sendSeatEvents = (app: import("@playwright/test").ElectronApplication, events: ReadonlyArray<unknown>) =>
  app.evaluate(({ BrowserWindow }, sent) => {
    for (const window of BrowserWindow.getAllWindows()) {
      for (const event of sent) window.webContents.send("junto:agent-seat-state-changed", event);
    }
  }, events);

test("stops post as Stopped, and a dialog replaces a stop", async () => {
  test.setTimeout(120_000);
  const now = Date.now();
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture(nodes, []) } });
  try {
    const { page, app } = junto;
    await expect(page.locator(".react-flow__node", { hasText: "Atlas" })).toBeVisible({ timeout: 60_000 });
    await minimise(app);
    await watchBanners(app);

    await sendSeatEvents(app, [
      seatEvent("limit", "idle", now, {
        status: statusOf("limit", now, [
          ["screen", { _tag: "TurnStarted" }],
          ["transcript", { _tag: "UsageLimitHit", scope: "weekly", resetsAt: now + 3 * 60 * MINUTE, message: "You've hit your weekly limit" }],
        ]),
      }),
      seatEvent("signin", "idle", now, {
        status: statusOf("signin", now, [
          ["transcript", { _tag: "ErrorRaised", kind: "auth", message: "authentication_failed: OAuth token has expired" }],
        ]),
      }),
    ]);
    await expect.poll(async () => (await banners(app)).length, { timeout: 15_000 }).toBe(2);
    const stops = await banners(app);
    console.log("stops", JSON.stringify(stops));
    expect(stops.find((b) => b.title === "Atlas")).toMatchObject({ subtitle: "Stopped", body: expect.stringContaining("hit a usage limit, resets") });
    expect(stops.find((b) => b.title === "Brook")).toMatchObject({ subtitle: "Stopped", body: "stopped on a sign-in error" });

    // Cedar stops, then shows a permission dialog.
    await sendSeatEvents(app, [
      seatEvent("dialog", "idle", now + 1, {
        status: statusOf("dialog", now + 1, [
          ["screen", { _tag: "TurnStarted" }],
          ["transcript", { _tag: "UsageLimitHit", scope: "weekly", message: "You've hit your weekly limit" }],
        ]),
      }),
    ]);
    await expect.poll(async () => (await banners(app)).length, { timeout: 15_000 }).toBe(3);
    expect((await banners(app))[2]).toMatchObject({ title: "Cedar", subtitle: "Stopped" });

    await sendSeatEvents(app, [seatEvent("dialog", "attention", now + 2, { reason: "Allow Bash to run rm -rf build?" })]);
    await expect.poll(async () => (await banners(app)).length, { timeout: 15_000 }).toBe(4);
    const all = await banners(app);
    console.log("after dialog", JSON.stringify(all[3]));
    expect(all[3]).toMatchObject({ title: "Cedar", subtitle: "Needs you" });
  } finally {
    await junto.close();
  }
});

test("a declared block then a dialog on one seat posts once", async () => {
  test.setTimeout(120_000);
  const junto = await launchJunto({});
  try {
    const { page, app } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 60_000 });
    await minimise(app);
    await watchBanners(app);

    const report = (key: string, need: ReturnType<typeof notifyNeed>, text: string) =>
      page.evaluate(
        ({ key, need, text, prefs }) =>
          window.junto?.notificationsReport?.({
            canvasName: "main",
            subjects: [{ key, ...need!, canvasName: "main", nodeId: "maple", seatName: "Maple", text }],
            badge: 1,
            prefs,
          }),
        { key, need: notifyNeed("seat_blocked") === undefined ? undefined : need, text, prefs: defaultNotifications() },
      );
    expect((await report("signal:maple", notifyNeed("seat_blocked"), "needs a new staging password"))?.ok).toBe(true);
    await expect.poll(async () => (await banners(app)).length, { timeout: 15_000 }).toBe(1);

    expect((await report("attention:maple:1", notifyNeed("dialog"), "Allow Bash to run npm test?"))?.ok).toBe(true);
    await page.waitForTimeout(4_000);
    const all = await banners(app);
    console.log("block then dialog", JSON.stringify(all));
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ title: "Maple", subtitle: "Blocked" });
  } finally {
    await junto.close();
  }
});
