/**
 * Real app, real seat: its state comes from the core process to the window on
 * the push, with nothing injected, and the offboard buttons are answered by the
 * core rather than saying Junto is still starting.
 *   bun run test:e2e:fast e2e/scenarios/seat-state-reaches-window.spec.ts
 */
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelRegion, modelSeat, modelWire } from "../harness/model";

const CANVAS = "seatstatewindow";
const SEAT = modelSeat({ id: "scout", label: "Scout", x: 480, y: 40 });
/** A second seat, idle: the switcher lists more than one place to go. */
const IDLE = modelSeat({ id: "lookout", label: "Lookout", x: 480, y: 220 });
/** Both seats in one region: a seat reaches its region's co-members. */
const REGION = modelRegion({ id: "floor", label: "Floor", x: 400, y: 0, width: 700, height: 460 });

test("a running seat's state reaches the window and offboard is answered", async () => {
  test.setTimeout(120_000);
  const junto = await launchJunto({
    windowContentSize: { width: 1400, height: 880 },
    seedModels: { [CANVAS]: modelFixture([SEAT]) },
    afterSeed: installCrewSeatHarness,
  });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="scout"]')).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    await page.evaluate(() => {
      const heard: string[] = [];
      (window as unknown as { __states: string[] }).__states = heard;
      window.junto!.onAgentSeatStateChanged((event) => { heard.push(event.state); });
    });
    await crewOccupySeat(page, CANVAS, SEAT, crewSeat(junto.sandbox, CANVAS, "scout"));
    await expect.poll(() => page.evaluate(() => (window as unknown as { __states: string[] }).__states.length), { timeout: 30_000 }).toBeGreaterThan(0);
    const [status] = await page.evaluate((canvas) => window.junto!.seatOffboardStatus!(canvas, ["scout"]), CANVAS);
    const now = status!.now as { readonly allowed: boolean; readonly reason?: string };
    expect(now.reason ?? "").not.toContain("still starting");
  } finally {
    await junto.close();
  }
});

/**
 * The attention surfaces, read from one real running seat with nothing
 * injected: a working seat takes a hotbar digit, Cmd+Backquote steps to it, a
 * seat's own `junto escalate` shows on its card and in the command center, an
 * answer to that signal is typed into the seat, and mail held on a busy seat
 * is counted as waiting.
 */
test("a running seat's attention reaches the hotbar, the switcher, the card, the command center, its signal answer and the mail count", async () => {
  test.setTimeout(180_000);
  const junto = await launchJunto({
    windowContentSize: { width: 1400, height: 880 },
    seedModels: { [CANVAS]: modelFixture([REGION, SEAT, IDLE], [modelWire("wire-scout-lookout", "scout", "lookout", "messages", [SEAT, IDLE])]) },
    afterSeed: installCrewSeatHarness,
  });
  const seat = crewSeat(junto.sandbox, CANVAS, "scout");
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="scout"]')).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    await crewOccupySeat(page, CANVAS, SEAT, seat);
    await seat.ready();

    // (1) The hotbar digit comes from live activity: a working seat is leased a slot.
    await seat.control({ screen: { mode: "working" } });
    const slot = page.locator('[data-testid^="hotbar-slot-"][data-node-id="scout"]');
    await expect(slot).toHaveCount(1, { timeout: 30_000 });
    await expect(slot).toHaveAttribute("data-tenure", "leased");

    // (2) Cmd+Backquote (urgency.next) steps to that seat: held Cmd, the tap
    // opens the switcher on it, and letting Cmd go puts it in front.
    await page.keyboard.down("Meta");
    await page.keyboard.press("Backquote");
    await expect(page.getByTestId("focus-switcher")).toBeVisible({ timeout: 15_000 });
    // Every seat is listed, and stepping lands on the one that is working.
    await expect(page.getByRole("option").filter({ hasText: "Scout" })).toHaveCount(1);
    for (let step = 0; step < 4; step += 1) {
      if (await page.getByTestId("focus-switcher-selected").getByText("Scout").count() > 0) break;
      await page.keyboard.press("Backquote");
    }
    await expect(page.getByTestId("focus-switcher-selected")).toContainText("Scout");
    await page.keyboard.up("Meta");
    const front = page.locator(".workbench-pane:not(.workbench-pane--parked)");
    await expect(front.locator("header").first()).toContainText("Scout", { timeout: 20_000 });

    // (3) The seat raises its own hand: attention on its card, and in the command center.
    const raised = await seat.cli(["escalate", "Which vault does the export read?"]);
    expect(raised.exitCode, raised.stderr).toBe(0);
    const card = page.locator('.react-flow__node[data-id="scout"]');
    // The declared escalate is on the card's own instrument, and raises the
    // seat's tone on the hotbar chip: the one urgency ladder, read in two places.
    await expect(card.locator(".junto-mark").first()).toHaveAttribute("aria-label", /1 open signal, escalate/);
    await expect(slot).toHaveAttribute("data-tone", "amber", { timeout: 30_000 });
    // The seat's own screen shows a dialog: proven attention, the amber ring.
    await seat.control({ screen: { mode: "attention" } });
    await expect(card.locator('.junto-mark[data-activity-tone="amber"]').first()).toHaveCount(1, { timeout: 30_000 });
    await page.keyboard.press("Meta+k");
    await expect(page.getByRole("option", { name: /Scout/ }).first()).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");

    // (3b) The operator answers that signal in the window, and the core types
    // the answer into the seat: the signal is answered from the seat's own
    // details, with no API call of ours.
    const ANSWER = "Use the archive vault.";
    await front.getByTestId("seat-details-button").click();
    const details = page.getByTestId("seat-details-popover");
    await expect(details).toBeVisible({ timeout: 15_000 });
    await details.getByTestId("seat-signal-row").first().click();
    const signal = page.getByTestId("seat-signal-popover");
    await expect(signal).toBeVisible({ timeout: 15_000 });
    await signal.locator("textarea").first().fill(ANSWER);
    await signal.getByRole("button", { name: "Send reply" }).click();
    // The dialog the seat showed is the answer's own; with it gone the held
    // answer is typed into the seat.
    await seat.control({ screen: { mode: "idle" } });
    await expect.poll(() => seat.stdinLog(), { timeout: 45_000 }).toContain(ANSWER);

    // (4) Mail along the edge reaches the far seat: it is in that seat's box,
    // which the seat reads back through its own credential. The mail-waiting
    // fact itself waits 30 minutes (mail-waiting.ts MAIL_WAITING_AFTER_MS), so
    // a short run cannot see the count without injecting a clock.
    const sent = await seat.cli(["msg", "send", JSON.stringify({ target: "scout", text: "Status?" })]);
    expect(sent.exitCode, sent.stderr).toBe(0);
    // It sits in the seat's box, which the seat reads back over its credential.
    await expect
      .poll(async () => (await seat.cli(["msg", "list"])).stdout, { timeout: 45_000 })
      .toContain("Status?");
  } finally {
    await junto.close();
  }
});

/**
 * The operator's typing and the core's own nudge, on one real seat and with
 * nothing injected: a key typed in the window's terminal holds the seat where
 * the cache cut asks (the core's clock, not a map in main), and the onboarding
 * nudge the core owes a fresh seat is typed by the core's supervisor once the
 * operator speaks to it.
 */
test("a real seat's typing holds it in the core, and the core types the onboarding nudge", async () => {
  test.setTimeout(150_000);
  const junto = await launchJunto({
    windowContentSize: { width: 1400, height: 880 },
    seedModels: { [CANVAS]: modelFixture([SEAT]) },
    afterSeed: installCrewSeatHarness,
  });
  const seat = crewSeat(junto.sandbox, CANVAS, "scout");
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="scout"]')).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    await crewOccupySeat(page, CANVAS, SEAT, seat);
    await seat.ready();

    // The seat at rest as the core's own offboard clock reads it. Its
    // still-since is the core's answer (seatOffboardStatus is answered by the
    // core, not by a copy in main), and typing moves it to the key.
    const stillSince = async (): Promise<number | undefined> => {
      const [status] = await page.evaluate(
        (canvas) => window.junto!.seatOffboardStatus!(canvas, ["scout"]),
        CANVAS,
      );
      return status?.stillSince;
    };
    await expect.poll(async () => typeof (await stillSince()) === "number", { timeout: 30_000 }).toBe(true);
    const before = await stillSince();
    if (before === undefined) throw new Error("the core never read the seat at rest");

    // The seat's terminal, in front, with the operator's keyboard in it.
    await page.locator('.react-flow__node[data-id="scout"]').dblclick();
    const front = page.locator(".workbench-pane:not(.workbench-pane--parked)");
    await expect(front.locator("header").first()).toContainText("Scout", { timeout: 20_000 });
    await front.locator(".xterm").first().click();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea") === true))
      .toBe(true);

    // A key typed in the window reaches the core's holds and warms its clock:
    // a main-side map (0.11.7) would move nothing here.
    await page.keyboard.type("hello");
    await expect.poll(stillSince, { timeout: 20_000 }).toBeGreaterThan(before);

    // The operator's first message starts a turn the core's supervisor reads,
    // and the nudge it owes this fresh seat is typed by the core itself.
    await page.keyboard.press("Enter");
    await expect.poll(() => seat.stdinLog(), { timeout: 30_000 }).toContain("junto onboard");
  } finally {
    await junto.close();
  }
});
