/**
 * Operator feed views — the region filter, the order pick, and the quiet answer.
 *   bun run test:e2e:fast e2e/scenarios/operator-feed-views.spec.ts
 *
 * Asserts:
 *   - the controls row carries the region and order dropdowns
 *   - narrowing to one region drops the rest and the status reads "N of M waiting in X"
 *   - ordering by newest and oldest reorders the cards the way it says
 *   - a region that empties while picked shows the filtered empty state
 *   - Send quietly records the answer: the card leaves and the count drops
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { AgentSignal } from "../../src/shared/agent-signals";
import type { Region, Seat as ModelSeat } from "../../src/shared/model";
import { modelFixture, modelRegion, modelSeat, type ModelFixture } from "../harness/model";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "operator-feed-views");
const CANVAS = "operator-feed-views";
const MINUTE = 60_000;

const region = (id: string, label: string, color: string | undefined, y: number): Region =>
  modelRegion({ id, label, ...(color ? { color } : {}), x: 0, y, width: 1000, height: 400 });

const seat = (id: string, x: number, y: number): ModelSeat =>
  modelSeat({ id, key: `local:e2e-views-${id}`, label: id, harness: "claude", x, y });

const fixture = (): ModelFixture =>
  modelFixture(
    [
      region("build", "Build", "4", 0),
      region("docs", "Docs", "6", 600),
      seat("atlas", 40, 80),
      seat("brook", 310, 80),
      seat("grove", 40, 680),
      seat("nova", 1400, 80),
    ],
    [],
  );

// atlas and brook sit in Build, grove in Docs, nova in the open field.
const signal = (seatId: string, n: number, minutesAgo: number): AgentSignal => ({
  signalId: `sig-${seatId}-${n}`,
  canvasName: CANVAS,
  nodeId: seatId,
  kind: n === 0 ? "blocked" : "feedback",
  text: `${seatId} asks number ${n}`,
  createdAt: Date.now() - minutesAgo * MINUTE,
  state: "open",
});

const SIGNALS: ReadonlyArray<AgentSignal> = [
  signal("atlas", 0, 30),
  signal("atlas", 1, 5),
  signal("brook", 0, 20),
  signal("grove", 0, 10),
  signal("nova", 0, 2),
];

const openFeed = async (page: Page) => {
  await page.keyboard.press("Meta+I");
  const feed = page.getByTestId("operator-feed");
  await expect(feed).toBeVisible({ timeout: 10_000 });
  return feed;
};

const shot = async (page: Page, name: string): Promise<void> => {
  await page.mouse.move(4, 700);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, name) });
};

const setTheme = async (page: Page, theme: "dark" | "bright"): Promise<void> => {
  await page.evaluate((mode) => window.junto!.settingsPatch({ appearance: { theme: mode } }), theme);
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
  await page.waitForTimeout(250);
};

test("the feed narrows to a region, reorders, and answers quietly", async () => {
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({ seedModels: { [CANVAS]: fixture() }, seedAgentSignals: SIGNALS });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow__node", { hasText: "atlas" })).toBeVisible({ timeout: 30_000 });

    const trigger = page.getByTestId("operator-feed-trigger");
    await expect(trigger).toHaveAttribute("aria-label", "Needs you, 5", { timeout: 10_000 });
    const feed = await openFeed(page);
    const cards = feed.getByTestId("operator-feed-card");
    await expect(cards).toHaveCount(5);
    await shot(page, "views-controls.png");

    // The region menu lists every waiting region and the open field.
    await page.getByRole("button", { name: "Filter needs by region" }).click();
    const menu = page.getByRole("listbox", { name: "Filter needs by region" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("option")).toHaveText(["All regions", "Build (3)", "Docs (1)", "open field (1)"]);
    await shot(page, "views-region-menu.png");

    // Picking Build keeps only its three, and says so in the status line.
    await menu.getByRole("option", { name: "Build (3)" }).click();
    await expect(cards).toHaveCount(3);
    await expect(page.locator(".operator-feed__status")).toHaveText("3 of 5 waiting in Build");
    await shot(page, "views-filtered-build.png");

    // Newest first puts nova... no — nova is in the open field, filtered out.
    // Within Build, newest first is atlas-1 (5m), brook-0 (20m), atlas-0 (30m).
    await page.getByRole("button", { name: "Order needs" }).click();
    await page.getByRole("listbox", { name: "Order needs" }).getByRole("option", { name: "Newest first" }).click();
    await expect(cards.first()).toHaveAttribute("data-item-id", "signal:sig-atlas-1");
    await expect(cards.last()).toHaveAttribute("data-item-id", "signal:sig-atlas-0");
    await shot(page, "views-newest-first.png");

    // Oldest flips it back; urgency puts the two blocked rows first.
    await page.getByRole("button", { name: "Order needs" }).click();
    await page.getByRole("listbox", { name: "Order needs" }).getByRole("option", { name: "Oldest first" }).click();
    await expect(cards.first()).toHaveAttribute("data-item-id", "signal:sig-atlas-0");
    await page.getByRole("button", { name: "Order needs" }).click();
    await page.getByRole("listbox", { name: "Order needs" }).getByRole("option", { name: "Most urgent first" }).click();

    // A quiet answer records the response and clears the card — no mail,
    // nothing typed into the seat (covered end to end by the transport spec;
    // here the card must leave and the count drop).
    const quiet = feed.locator("[data-item-id='signal:sig-atlas-1']");
    await quiet.getByRole("button", { name: "Write reply" }).click();
    const reply = quiet.getByLabel("Your reply");
    await reply.fill("Noted, carry on.");
    await shot(page, "views-quiet-reply.png");
    await quiet.getByRole("button", { name: "Send quietly" }).click();
    await expect(quiet).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator(".operator-feed__status")).toHaveText("2 of 4 waiting in Build");
    await expect(trigger).toHaveAttribute("aria-label", "Needs you, 4");

    // Clear the rest of Build; the picked region empties into its own state.
    for (const id of ["signal:sig-atlas-0", "signal:sig-brook-0"]) {
      const card = feed.locator(`[data-item-id='${id}']`);
      await card.getByTestId("quick-replies").getByRole("button").first().click();
      await expect(card).toHaveCount(0, { timeout: 10_000 });
    }
    await expect(feed).toContainText("Nothing waiting in Build");
    await shot(page, "views-region-empty.png");

    // Back to all regions: grove and nova are still waiting.
    await page.getByRole("button", { name: "Show all regions" }).click();
    await expect(cards).toHaveCount(2);
    await expect(page.locator(".operator-feed__status")).toHaveText("2 waiting across 2 regions");
    await shot(page, "views-back-to-all.png");
    await page.keyboard.press("Escape");
    await expect(feed).toHaveCount(0);

    // The same pass in bright: controls, a filtered region, the reply row.
    await setTheme(page, "bright");
    await openFeed(page);
    await expect(cards).toHaveCount(2);
    await shot(page, "views-controls-bright.png");
    await page.getByRole("button", { name: "Filter needs by region" }).click();
    await page
      .getByRole("listbox", { name: "Filter needs by region" })
      .getByRole("option", { name: "Docs (1)" })
      .click();
    await expect(cards).toHaveCount(1);
    await expect(page.locator(".operator-feed__status")).toHaveText("1 of 2 waiting in Docs");
    await feed.locator("[data-item-id='signal:sig-grove-0']").getByRole("button", { name: "Write reply" }).click();
    await shot(page, "views-quiet-reply-bright.png");
  } finally {
    await junto.close();
  }
});
