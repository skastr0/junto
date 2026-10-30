/**
 * The Needs you feed's filters (0.11.5): a field that says "Search needs", one
 * chip per kind named as every surface names it, the seats folded behind one
 * toggle, and Clear.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/feed-filters.spec.ts
 *
 * Asserts:
 *   - the field's placeholder, and a chip for each kind the feed holds with its count
 *   - the seats are folded until the toggle opens them, then a chip per seat by name
 *   - the chosen seat stays in the bar with its own clear
 *   - the words narrow the cards, a kind chip narrows them, both together narrow further
 *   - Clear puts every card back, empties the field, and drops the seat
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { AgentSignal } from "../../src/shared/agent-signals";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = process.env.JUNTO_SHOTS_DIR ?? join(process.cwd(), "test-results", "feed-filters");
const CANVAS = "feed-filters";
const MINUTE = 60_000;

const fixture = () =>
  modelFixture(
    [
      modelRegion({ id: "build", label: "Build", x: 0, y: 0, width: 1200, height: 700, z: 0 }),
      modelSeat({ id: "atlas", key: "local:e2e-filters-atlas", label: "Atlas", harness: "claude", x: 60, y: 120 }),
      modelSeat({ id: "bravo", key: "local:e2e-filters-bravo", label: "Bravo", harness: "claude", x: 520, y: 120 }),
    ],
    [],
  );

const signal = (seatId: string, n: number, kind: AgentSignal["kind"], text: string): AgentSignal => ({
  signalId: `filter-${seatId}-${n}`,
  canvasName: CANVAS,
  nodeId: seatId,
  kind,
  text,
  createdAt: Date.now() - (5 + n) * MINUTE,
  state: "open",
});

const SIGNALS: ReadonlyArray<AgentSignal> = [
  signal("atlas", 0, "escalate", "Ana asks about the rates"),
  signal("atlas", 1, "work", "Ship the release notes"),
  signal("bravo", 0, "blocked", "Bravo is stuck on a sign-in"),
];

const shot = async (page: Page, name: string): Promise<void> => {
  await mkdir(SHOTS, { recursive: true });
  await page.mouse.move(4, 700);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

test("the feed narrows by words, kind and seat, and Clear puts it back", async () => {
  test.setTimeout(180_000);
  const junto = await launchJunto({ seedModels: { [CANVAS]: fixture() }, seedAgentSignals: SIGNALS });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow__node", { hasText: "Atlas" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("operator-feed-trigger")).toHaveAttribute("aria-label", "Needs you, 3", { timeout: 10_000 });
    await page.keyboard.press("Meta+I");
    const feed = page.getByTestId("operator-feed");
    await expect(feed).toBeVisible({ timeout: 10_000 });
    const cards = feed.getByTestId("operator-feed-card");
    await expect(cards).toHaveCount(3);

    // The field says what it does, and every kind the feed holds has a chip.
    const bar = page.getByTestId("feed-filter-bar");
    await expect(bar.locator(".operator-feed__search")).toHaveAttribute("placeholder", "Search needs");
    const kind = (name: string) => bar.getByTestId("feed-kind-chip").filter({ hasText: name });
    const seat = (name: string) => bar.getByTestId("feed-seat-chip").filter({ hasText: name });
    await expect(kind("Waiting on you")).toHaveCount(1);
    await expect(kind("To do")).toHaveCount(1);
    await expect(kind("Blocked")).toHaveCount(1);
    // The seats are folded away until the operator asks for them.
    const seats = bar.getByTestId("feed-seats-toggle");
    const seatRow = bar.getByTestId("feed-seats-row");
    await expect(seats).toHaveAttribute("aria-expanded", "false");
    await expect(seatRow).toBeHidden();
    await seats.click();
    await expect(seats).toHaveAttribute("aria-expanded", "true");
    await expect(seatRow).toBeVisible();
    await expect(seat("Atlas")).toHaveCount(1);
    await expect(seat("Bravo")).toHaveCount(1);
    await shot(page, "1-filter-bar");

    // Words narrow the cards.
    await bar.locator(".operator-feed__search").fill("rates");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("Ana asks about the rates");

    // A kind and a seat narrow it further, each on its own axis.
    await bar.locator(".operator-feed__search").fill("");
    await kind("Blocked").click();
    await expect(cards).toHaveCount(1);
    await expect(kind("Blocked")).toHaveAttribute("aria-pressed", "true");
    await seat("Atlas").click();
    await expect(cards).toHaveCount(0);
    await expect(page.getByTestId("feed-no-matches")).toBeVisible();
    // The chosen seat stays in the bar, folded or not, with its own clear.
    await seats.click();
    await expect(seatRow).toBeHidden();
    await expect(bar.getByTestId("feed-seat-chosen")).toContainText("Atlas");
    // The header says the part, not the whole, and the live region can say it too.
    await expect(page.locator(".operator-feed__status")).toHaveText("0 of 3 shown");
    await expect(page.locator(".operator-feed__announce")).toHaveText("0 of 3 shown with these filters");
    await shot(page, "2-nothing-matches");

    // Clear puts every card back, empties the field, and drops the seat.
    await page.getByTestId("feed-clear-filters").click();
    await expect(cards).toHaveCount(3);
    await expect(bar.locator(".operator-feed__search")).toHaveValue("");
    await expect(bar.getByTestId("feed-seat-chosen")).toHaveCount(0);
    // Clear takes the keyboard with it: the next Tab is in the bar, not on the header's Close.
    await expect(bar.locator(".operator-feed__search")).toBeFocused();
    await expect(kind("Blocked")).toHaveAttribute("aria-pressed", "false");
    await shot(page, "3-cleared");
  } finally {
    await junto.close();
  }
});
