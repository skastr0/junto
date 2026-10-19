/**
 * The needs-you list holds still: only the operator moves it.
 *   bun run test:e2e:fast e2e/scenarios/feed-scroll-stable.spec.ts
 *
 * Answering a card jerked the list to the bottom: the card left the tree
 * for one render before it was put back to fade, its region (when it was
 * the region's last card) came back at the end of the list, and the reply
 * box still open on it took focus again and scrolled there.
 *
 * The list sits on the left; the selected card's pills, buttons and reply
 * box live in the detail pane beside it, so answering is done there and the
 * list is what must hold still.
 *
 * Asserts, in one feed of three regions:
 *   - a reply to a region's only card leaves the scroll where it was
 *   - answering mid-list, quietly or with a quick reply: the scroll does not
 *     move, the card below slides up into the answered card's place
 *   - a quick reply by key hands the selection on without scrolling to it
 *   - a card leaving above the viewport moves nothing on screen
 *   - a card arriving above the viewport moves nothing on screen, and a
 *     blocked one that outranks the region in view does not re-rank it
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { AgentSignal } from "../../src/shared/agent-signals";
import type { Region, Seat as ModelSeat } from "../../src/shared/model";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "feed-scroll-stable");
const CANVAS = "feed-scroll-stable";
const MINUTE = 60_000;

const region = (id: string, label: string, color: string, y: number): Region =>
  modelRegion({ id, label, color, x: 0, y, width: 1000, height: 400 });

const seat = (id: string, x: number, y: number): ModelSeat =>
  modelSeat({ id, key: `local:e2e-scroll-${id}`, label: id, harness: "claude", x, y });

const signal = (id: string, seatId: string, minutesAgo: number, kind: AgentSignal["kind"] = "feedback"): AgentSignal => ({
  signalId: id,
  canvasName: CANVAS,
  nodeId: seatId,
  kind,
  text: `${seatId} has ${id} ready for you to look at.`,
  createdAt: Date.now() - minutesAgo * MINUTE,
  state: "open",
});

// Lead holds one card and ranks first (oldest), then Build, then Docs.
// Build is long enough that the list rows, short in the split feed, still
// push Docs below the first screen.
const SIGNALS: ReadonlyArray<AgentSignal> = [
  signal("l0", "lea", 120),
  ...Array.from({ length: 14 }, (_, n) => signal(`b${n}`, n % 2 === 0 ? "bo" : "bri", 110 - n * 2)),
  ...Array.from({ length: 7 }, (_, n) => signal(`d${n}`, n % 2 === 0 ? "dot" : "dex", 60 - n * 2)),
];

const shot = async (page: Page, name: string): Promise<void> => {
  await page.mouse.move(4, 880);
  await page.screenshot({ path: join(SHOTS, name) });
};

/** Equal to the pixel: layout is whole pixels at a scale of 1. */
const expectAt = (actual: number, expected: number, what: string): void => {
  expect(Math.abs(actual - expected), `${what}: ${actual} against ${expected}`).toBeLessThanOrEqual(1);
};

test("the needs-you list moves only when the operator moves it", async () => {
  test.setTimeout(180_000);
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({
    seedModels: {
      [CANVAS]: modelFixture(
        [
          region("lead", "Lead", "4", 0),
          region("build", "Build", "6", 600),
          region("docs", "Docs", "2", 1200),
          seat("lea", 40, 80),
          seat("bo", 40, 680),
          seat("bri", 310, 680),
          seat("dot", 40, 1280),
          seat("dex", 310, 1280),
        ],
        [],
      ),
    },
    seedAgentSignals: SIGNALS,
  });
  try {
    const { app, page } = junto;
    await expect(page.getByTestId("rf__node-lea")).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await page.keyboard.press("Meta+I");
    const feed = page.getByTestId("operator-feed");
    await expect(feed).toBeVisible({ timeout: 10_000 });
    const cardOf = (id: string): Locator => feed.locator(`[data-item-id='signal:${id}']`);
    // Select a card by click (never a scroll) and act in its detail pane.
    const paneOf = async (id: string): Promise<Locator> => {
      await cardOf(id).click();
      const pane = page.locator(`[data-testid='operator-feed-detail'][data-item-id='signal:${id}']`);
      await expect(pane).toBeVisible();
      return pane;
    };
    await expect(feed.getByTestId("operator-feed-card")).toHaveCount(SIGNALS.length);

    const scrollTop = (): Promise<number> => feed.evaluate((el) => el.scrollTop);
    const edge = (): Promise<{ top: number; bottom: number }> =>
      feed.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return { top: Math.round(box.top), bottom: Math.round(box.bottom) };
      });
    const topOf = (id: string): Promise<number> => cardOf(id).evaluate((el) => Math.round(el.getBoundingClientRect().top));
    const bottomOf = (id: string): Promise<number> =>
      cardOf(id).evaluate((el) => Math.round(el.getBoundingClientRect().bottom));
    // The operator's own scrolling: put a card `offset` px under the list's top edge.
    const place = (id: string, offset: number): Promise<void> =>
      feed.evaluate(
        (el, { selector, offset }) => {
          const card = el.querySelector(selector)!;
          el.scrollTop += card.getBoundingClientRect().top - el.getBoundingClientRect().top - offset;
        },
        { selector: `[data-item-id='signal:${id}']`, offset },
      );
    const gone = async (id: string): Promise<void> => {
      await expect(cardOf(id)).toHaveCount(0, { timeout: 10_000 });
      await page.waitForTimeout(150);
    };
    // What main sends the window when a seat raises a signal.
    const arrive = (raised: AgentSignal): Promise<void> =>
      app.evaluate(({ BrowserWindow }, value) => {
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send("junto:agent-signal", value);
      }, raised);

    // 1. A reply to Lead's only card, from the top of the list.
    expect(await scrollTop()).toBe(0);
    const lead = await paneOf("l0");
    expect(await scrollTop(), "selecting a card scrolls nothing").toBe(0);
    await lead.getByRole("button", { name: "Write reply" }).click();
    await lead.getByLabel("Your reply").fill("Looks right, ship it.");
    await shot(page, "1-lead-reply-typed.png");
    await lead.getByRole("button", { name: "Send reply" }).click();
    await gone("l0");
    await shot(page, "1-lead-answered.png");
    expect(await scrollTop(), "a reply to a region's only card scrolls nothing").toBe(0);
    await expect(feed.locator(".operator-feed__region-label")).toHaveText(["Build", "Docs"]);

    // 2. Mid-list, answered quietly: b4 slides up into b3's place.
    await place("b3", 90);
    const mid = await paneOf("b3");
    await mid.getByRole("button", { name: "Write reply" }).click();
    await mid.getByLabel("Your reply").fill("Noted, carry on.");
    const quietAt = await scrollTop();
    const quietTop = await topOf("b3");
    await shot(page, "2-mid-quiet-typed.png");
    await mid.getByRole("button", { name: "Send quietly" }).click();
    await gone("b3");
    await shot(page, "2-mid-quiet-answered.png");
    expectAt(await scrollTop(), quietAt, "a quiet answer mid-list keeps the scroll");
    expectAt(await topOf("b4"), quietTop, "the card below takes the answered card's place");

    // 3. Mid-list, a quick reply: b5 slides up into b4's place.
    const pills = (await paneOf("b4")).getByTestId("quick-replies").getByRole("button");
    expect(await pills.count()).toBeGreaterThan(0);
    const quickAt = await scrollTop();
    const quickTop = await topOf("b4");
    await pills.first().click();
    await gone("b4");
    expectAt(await scrollTop(), quickAt, "a quick reply mid-list keeps the scroll");
    expectAt(await topOf("b5"), quickTop, "the card below takes the answered card's place");

    // 4. A quick reply by key: j/k may reveal the card they select, but the
    // answer handing the selection on to d2, out of sight, scrolls nothing.
    for (let step = 0; step < 20 && (await cardOf("d1").getAttribute("aria-current")) !== "true"; step += 1) {
      await page.keyboard.press("j");
    }
    await expect(cardOf("d1")).toHaveAttribute("aria-current", "true");
    const list = await edge();
    await place("d1", list.bottom - list.top - ((await bottomOf("d1")) - (await topOf("d1"))) - 8);
    expect(await topOf("d2"), "d2 starts out of sight").toBeGreaterThan(list.bottom - 12);
    const keyAt = await scrollTop();
    await page.keyboard.press("1");
    await gone("d1");
    await expect(cardOf("d2")).toHaveAttribute("aria-current", "true");
    expectAt(await scrollTop(), keyAt, "an answer by key hands the selection on without scrolling");

    // 5. A card leaving above the viewport: d4 stays where the operator sees it.
    await place("d4", 140);
    const view = await edge();
    expect(await bottomOf("b7"), "b7 sits above the viewport").toBeLessThan(view.top);
    const d4Top = await topOf("d4");
    const dismissed = await page.evaluate(() => window.junto!.agentSignalDismiss("b6"));
    expect(dismissed.ok).toBe(true);
    await gone("b6");
    expectAt(await topOf("d4"), d4Top, "a card leaving above moves nothing on screen");

    // 6. A card arriving above the viewport, at the end of Build.
    expect(await topOf("d0"), "Docs starts above the viewport").toBeLessThan(view.top);
    await arrive(signal("b20", "bo", 0));
    await expect(cardOf("b20")).toHaveCount(1, { timeout: 10_000 });
    await page.waitForTimeout(150);
    expectAt(await topOf("d4"), d4Top, "a card arriving above moves nothing on screen");
    await shot(page, "6-arrived-above.png");

    // 7. A blocked card for Docs outranks Build: it joins the top of Docs,
    // above the viewport, and the regions keep their order on screen.
    await arrive(signal("d7", "dex", 0, "blocked"));
    await expect(cardOf("d7")).toHaveCount(1, { timeout: 10_000 });
    await page.waitForTimeout(150);
    expectAt(await topOf("d4"), d4Top, "a re-rank moves nothing on screen");
    await expect(feed.locator(".operator-feed__region-label")).toHaveText(["Build", "Docs"]);
    expect(await feed.locator(".operator-feed__region").nth(1).getByTestId("operator-feed-card").first().getAttribute("data-item-id")).toBe(
      "signal:d7",
    );
  } finally {
    await junto.close();
  }
});
