/**
 * Needs you answers: the four ways to close a signal, from the list, in the
 * built app, and the split feed they live in.
 *   bun run test:e2e:fast e2e/scenarios/feed-answers.spec.ts
 *
 * Asserts:
 *   - the feed splits: the list on the left, the selected item whole on the
 *     right, with its details, both pill rows (1-9 waking, Shift+1-9 quiet)
 *     and its key hints (d, a, Shift+1-9); rows in the list carry no pills
 *   - d dismisses: the signal is dismissed with no answer
 *   - a acknowledges: answered, recorded as "Acknowledged, no note"
 *   - Shift+1 sends the first quiet note: answered with its words
 *   - 1 sends the first quick reply: answered, and the seat is mailed
 *   - Enter opens the composer in the pane; each button's hover (its
 *     tooltip) says what it does; Shift+Cmd+Enter with no text acknowledges
 *   - Settings carries the quiet notes next to the quick replies
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { AGENT_SIGNAL_ACKNOWLEDGED_RESPONSE, type AgentSignal } from "../../src/shared/agent-signals";
import type { Region, Seat as ModelSeat } from "../../src/shared/model";
import { modelFixture, modelRegion, modelSeat, type ModelFixture } from "../harness/model";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "feed-answers");
const CANVAS = "feed-answers";
const MINUTE = 60_000;

const region = (id: string, label: string, color: string, y: number): Region =>
  modelRegion({ id, label, color, x: 0, y, width: 1000, height: 400 });

const seat = (id: string, x: number, y: number): ModelSeat =>
  modelSeat({ id, key: `local:e2e-answers-${id}`, label: id, harness: "claude", x, y });

const fixture = (): ModelFixture =>
  modelFixture(
    [
      region("build", "Build", "4", 0),
      seat("atlas", 40, 80),
      seat("brook", 310, 80),
      seat("grove", 580, 80),
    ],
    [],
  );

const signal = (signalId: string, nodeId: string, minutesAgo: number, extra: Partial<AgentSignal>): AgentSignal => ({
  signalId,
  canvasName: CANVAS,
  nodeId,
  kind: "feedback",
  text: `${signalId} is ready`,
  createdAt: Date.now() - minutesAgo * MINUTE,
  state: "open",
  ...extra,
});

// One region, most urgent first: the blocked one leads, then the escalation,
// then the reviews oldest first. The keys below walk them in that order.
const SIGNALS: ReadonlyArray<AgentSignal> = [
  signal("sig-migrate", "atlas", 40, {
    kind: "blocked",
    text: "The migration needs a decision on the old ids before it can run.",
    detail:
      "## What I found\n\nTwo specs disagree on how ids are formed. `docs/ids.md` says ULIDs, the schema says integers.\n\n- I tried both on a copy of the database.\n- ULIDs keep the sort order the feed relies on.\n\nI would go with ULIDs unless you know a reason not to.",
  }),
  signal("sig-stale", "brook", 30, { kind: "escalate", text: "An old question about the cache, probably settled." }),
  signal("sig-review", "grove", 20, { text: "The docs pass is done and ready for review." }),
  signal("sig-note", "atlas", 10, { text: "Lint rules updated, nothing for you to do." }),
  signal("sig-go", "brook", 5, { text: "The release notes are drafted." }),
  signal("sig-compose", "grove", 2, { text: "One more look at the onboarding copy?" }),
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

const stateOf = async (page: Page, signalId: string) => {
  const signals = await page.evaluate((canvas) => window.junto!.agentSignalsList(canvas), CANVAS);
  const found = signals.find((candidate) => candidate.signalId === signalId);
  return { state: found?.state, response: found?.response?.text };
};

test("the feed answers four ways from the list, split into list and detail", async () => {
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({ seedModels: { [CANVAS]: fixture() }, seedAgentSignals: SIGNALS });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow__node", { hasText: "atlas" })).toBeVisible({ timeout: 30_000 });
    const trigger = page.getByTestId("operator-feed-trigger");
    await expect(trigger).toHaveAttribute("aria-label", "Needs you, 6", { timeout: 10_000 });

    const feed = await openFeed(page);
    const rows = feed.getByTestId("operator-feed-card");
    const pane = page.getByTestId("operator-feed-detail");
    await expect(rows).toHaveCount(6);

    // The first item is selected and whole in the pane: details without an
    // expander, both pill rows, its keys. No row in the list carries pills.
    await expect(pane).toHaveAttribute("data-item-id", "signal:sig-migrate");
    await expect(pane.locator(".operator-feed__detail")).toContainText("ULIDs keep the sort order");
    await expect(pane.getByTestId("quick-replies").getByRole("button")).toHaveText([
      /Yes/,
      /Looks good/,
      /Go on/,
      /Not now/,
      /I disagree/,
      /Let's discuss/,
    ]);
    await expect(pane.getByTestId("quiet-notes").getByRole("button")).toHaveText([/Acknowledged/, /Good/]);
    await expect(pane.getByTestId("quiet-notes").getByRole("button").first()).toHaveAttribute(
      "data-junto-tooltip",
      'Send "Acknowledged" quietly: answered, the seat is not woken (⇧1)',
    );
    await expect(rows.getByTestId("quick-replies")).toHaveCount(0);
    await expect(rows.getByTestId("quiet-notes")).toHaveCount(0);
    const keys = pane.getByTestId("operator-feed-keys");
    await expect(keys).toContainText("quick reply");
    await expect(keys).toContainText("quiet note");
    await expect(keys).toContainText("acknowledge");
    await expect(keys).toContainText("dismiss");
    await shot(page, "split-selected-both-rows.png");
    await keys.screenshot({ path: join(SHOTS, "key-hints.png") });
    await pane.locator(".operator-feed__answer").screenshot({ path: join(SHOTS, "pill-rows.png") });

    // j moves the pane with the selection.
    await page.keyboard.press("j");
    await expect(pane).toHaveAttribute("data-item-id", "signal:sig-stale");
    await shot(page, "split-moved-with-j.png");

    // d dismisses: closed, no answer, the seat is not told.
    await page.keyboard.press("d");
    await expect(feed.locator("[data-item-id='signal:sig-stale']")).toHaveCount(0, { timeout: 10_000 });
    expect(await stateOf(page, "sig-stale")).toEqual({ state: "dismissed", response: undefined });

    // The neighbour took the selection; a acknowledges it with no note.
    await expect(pane).toHaveAttribute("data-item-id", "signal:sig-review");
    await page.keyboard.press("a");
    await expect(feed.locator("[data-item-id='signal:sig-review']")).toHaveCount(0, { timeout: 10_000 });
    expect(await stateOf(page, "sig-review")).toEqual({ state: "answered", response: AGENT_SIGNAL_ACKNOWLEDGED_RESPONSE });

    // Shift+1 sends the first quiet note.
    await expect(pane).toHaveAttribute("data-item-id", "signal:sig-note");
    await page.keyboard.press("Shift+Digit1");
    await expect(feed.locator("[data-item-id='signal:sig-note']")).toHaveCount(0, { timeout: 10_000 });
    expect(await stateOf(page, "sig-note")).toEqual({ state: "answered", response: "Acknowledged" });

    // 1 sends the first quick reply, which mails and wakes the seat.
    await expect(pane).toHaveAttribute("data-item-id", "signal:sig-go");
    await page.keyboard.press("1");
    await expect(feed.locator("[data-item-id='signal:sig-go']")).toHaveCount(0, { timeout: 10_000 });
    expect(await stateOf(page, "sig-go")).toEqual({ state: "answered", response: "Yes" });
    await expect(trigger).toHaveAttribute("aria-label", "Needs you, 2");

    // Enter opens the composer in the pane. Each button says what it does.
    await rows.filter({ hasText: "onboarding copy" }).click();
    await expect(pane).toHaveAttribute("data-item-id", "signal:sig-compose");
    await page.keyboard.press("Enter");
    const reply = pane.getByLabel("Your reply");
    await expect(reply).toBeFocused();
    await expect(pane.getByRole("button", { name: "Dismiss" })).toHaveAttribute("data-junto-tooltip", "Dismiss: closes it, the seat is not told");
    await expect(pane.getByRole("button", { name: "Send quietly" })).toHaveAttribute(
      "data-junto-tooltip",
      /^Send quietly: answered, the seat is not woken/,
    );
    await expect(pane.getByRole("button", { name: "Send reply" })).toHaveAttribute("data-junto-tooltip", /^Send reply: mails and wakes the seat/);
    // Empty, Send quietly is still there to press: it acknowledges.
    await expect(pane.getByRole("button", { name: "Send quietly" })).toBeEnabled();
    await expect(pane.getByRole("button", { name: "Send reply" })).toBeDisabled();
    await pane.getByRole("button", { name: "Send quietly" }).hover();
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(SHOTS, "composer-open.png") });

    // Shift+Cmd+Enter with no text acknowledges from the composer.
    await page.keyboard.press("Shift+Meta+Enter");
    await expect(feed.locator("[data-item-id='signal:sig-compose']")).toHaveCount(0, { timeout: 10_000 });
    expect(await stateOf(page, "sig-compose")).toEqual({ state: "answered", response: AGENT_SIGNAL_ACKNOWLEDGED_RESPONSE });
    await page.keyboard.press("Escape");

    // Settings: the quiet notes sit next to the quick replies.
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.locator(".settings-nav__item", { hasText: "Replies" }).click();
    const notes = page.getByTestId("settings-quiet-notes-section");
    await expect(notes.getByRole("textbox", { name: /^Quiet note \d+$/ })).toHaveCount(2);
    await shot(page, "settings-replies.png");
  } finally {
    await junto.close();
  }
});
