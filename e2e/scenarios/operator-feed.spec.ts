/**
 * Operator feed — the needs-you surface.
 *   bun run test:e2e:fast e2e/scenarios/operator-feed.spec.ts
 *
 * Signals are seeded as durable rows, so every answer below goes through
 * main's real answer path (operator mail to the seat, then the signal is
 * recorded answered) and comes back as the same event the store listens to.
 *
 * Asserts:
 *   - thirty open signals group under their regions, each header wearing the region's own colour
 *   - no card carries a side stripe; the kind rides on the portrait instead
 *   - the top bar entry carries the live count
 *   - a quick reply sends by key (1..9) and by click; the answered card leaves
 *   - Enter opens the written reply, which sends with ⌘↵; Dismiss closes without mail
 *   - Settings > Quick replies edits, reorders, and removes replies, and the feed follows
 *   - one signal reads calmly; answering it leaves the calm empty state
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { AgentSignal } from "../../src/shared/agent-signals";
import type { CanvasDoc, GroupNode, TextNode } from "../../src/shared/canvas";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "operator-feed");
const CANVAS = "operator-feed";
const MINUTE = 60_000;

const region = (
  id: string,
  label: string,
  color: string | undefined,
  x: number,
  y: number,
  width: number,
  height: number,
): GroupNode => ({ id, type: "group", label, ...(color ? { color } : {}), x, y, width, height });

type Seat = { readonly id: string; readonly label: string; readonly x: number; readonly y: number };

const row = (names: ReadonlyArray<string>, x0: number, y: number): ReadonlyArray<Seat> =>
  names.map((label, index) => ({ id: label.toLowerCase(), label, x: x0 + index * 270, y }));

const BUILD = row(["Atlas", "Brook", "Cedar", "Delta", "Ember", "Flint"], 40, 80);
const DOCS = row(["Grove", "Harbor", "Iris", "Juniper"], 40, 680);
const OPS = row(["Kestrel", "Lumen", "Moss"], 1340, 680);
const FIELD = row(["Nova", "Onyx"], 2400, 80);
const SEATS = [...BUILD, ...DOCS, ...OPS, ...FIELD];

const seatNode = (seat: Seat, index: number): TextNode =>
  agentTextNode({
    id: seat.id,
    key: `local:e2e-feed-${seat.id}`,
    label: seat.label,
    harness: index % 2 === 0 ? "claude" : "codex",
    x: seat.x,
    y: seat.y,
  });

const doc = (seats: ReadonlyArray<Seat>): CanvasDoc =>
  canvasDoc(
    [
      region("build", "Build", "4", 0, 0, 1700, 460),
      region("docs", "Docs", "6", 0, 600, 1160, 360),
      region("ops", "Ops", "2", 1300, 600, 900, 360),
      ...seats.map(seatNode),
    ],
    [],
  );

const ASKS: ReadonlyArray<Pick<AgentSignal, "kind" | "text"> & { readonly detail?: string }> = [
  {
    kind: "blocked",
    text: "I need the staging database password to run the migration.",
    detail: "The migration in `db/0042_accounts.sql` needs **write** access.\n\n- tried the read replica\n- the vault entry is empty",
  },
  { kind: "escalate", text: "Two tests disagree on the date format; I picked ISO 8601 and kept going." },
  { kind: "feedback", text: "The settings page redesign is ready for a look." },
  { kind: "feedback", text: "Draft release notes are in the pad." },
  { kind: "blocked", text: "The deploy key was rotated and CI can no longer push tags." },
  { kind: "escalate", text: "The spec says soft delete but the table has no deleted_at column. Add one?" },
  { kind: "feedback", text: "Benchmarks for the new cache are attached; p95 dropped from 41 ms to 12 ms." },
  { kind: "escalate", text: "Should the export include archived projects, or only live ones?" },
];

const signals = (seats: ReadonlyArray<Seat>, perSeat: number): ReadonlyArray<AgentSignal> =>
  seats.flatMap((seat, seatIndex) =>
    Array.from({ length: perSeat }, (_, n) => {
      const index = seatIndex * perSeat + n;
      const ask = ASKS[index % ASKS.length]!;
      return {
        signalId: `sig-${seat.id}-${n}`,
        canvasName: CANVAS,
        nodeId: seat.id,
        kind: ask.kind,
        text: ask.text,
        ...(ask.detail ? { detail: ask.detail } : {}),
        createdAt: Date.now() - (3 + index * 4) * MINUTE,
        state: "open" as const,
      };
    }),
  );

const setTheme = async (page: Page, theme: "dark" | "bright"): Promise<void> => {
  await page.evaluate((mode) => window.junto!.settingsPatch({ appearance: { theme: mode } }), theme);
  // Dark is the default edition and carries no attribute.
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
  await page.waitForTimeout(250);
};

test("the operator feed at thirty: regions in colour, quick replies, real answers", async () => {
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: doc(SEATS) }, seedAgentSignals: signals(SEATS, 2) });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow__node", { hasText: "Atlas" })).toBeVisible({ timeout: 30_000 });
    await setTheme(page, "dark");

    const trigger = page.getByTestId("operator-feed-trigger");
    await expect(trigger).toHaveAttribute("aria-label", "Open needs-you feed, 30 waiting", { timeout: 10_000 });
    await page.screenshot({ path: join(SHOTS, "topbar-count.png"), clip: { x: 0, y: 0, width: 1400, height: 60 } });

    await page.keyboard.press("Meta+I");
    const feed = page.getByTestId("operator-feed");
    await expect(feed).toBeVisible({ timeout: 10_000 });
    const cards = feed.getByTestId("operator-feed-card");
    await expect(cards).toHaveCount(30);
    // Regions order by their most urgent need; every region is present.
    const labels = await feed.locator(".operator-feed__region-label").allTextContents();
    expect([...labels].sort()).toEqual(["Build", "Docs", "Ops", "open field"]);

    // Each region wears its own colour; no card carries a side stripe.
    const swatches = await feed
      .locator(".operator-feed__region:not([data-open-field]) .operator-feed__region-swatch")
      .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).backgroundColor));
    expect(new Set(swatches).size).toBe(3);
    const stripes = await cards.evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).borderLeftWidth).filter((width) => width !== "0px"),
    );
    expect(stripes).toEqual([]);
    await page.screenshot({ path: join(SHOTS, "feed-30-dark.png") });

    // Details expand in place.
    const first = cards.first();
    const detailed = feed.locator("[data-item-id='signal:sig-atlas-0']");
    await detailed.getByRole("button", { name: "Details" }).click();
    await expect(detailed.locator(".operator-feed__detail")).toContainText("tried the read replica");
    await expect(detailed).toHaveAttribute("aria-current", "true");
    await expect(detailed.getByTestId("quick-replies").getByRole("button")).toHaveText([
      "1Yes",
      "2No",
      "3Continue",
      "4Go on",
      "5Stop doing this",
    ]);
    await page.screenshot({ path: join(SHOTS, "feed-selected-dark.png") });

    // Key 1 sends "Yes" through the real answer path; the card leaves.
    await page.keyboard.press("1");
    await expect(detailed).toHaveCount(0, { timeout: 10_000 });
    await expect(trigger).toHaveAttribute("aria-label", "Open needs-you feed, 29 waiting");
    // The selection moved on to the next card.
    await expect(feed.locator("[aria-current='true']")).toHaveCount(1);

    // A click on a pill sends it too.
    const byClick = await first.getAttribute("data-item-id");
    await first.getByTestId("quick-replies").getByRole("button", { name: /Go on/ }).click();
    await expect(feed.locator(`[data-item-id='${byClick}']`)).toHaveCount(0, { timeout: 10_000 });
    await expect(trigger).toHaveAttribute("aria-label", "Open needs-you feed, 28 waiting");

    // Enter opens the written reply; ⌘↵ sends it.
    const written = await feed.locator("[aria-current='true']").getAttribute("data-item-id");
    const writtenCard = feed.locator(`[data-item-id='${written}']`);
    await page.keyboard.press("Enter");
    const reply = writtenCard.getByLabel("Your reply");
    await expect(reply).toBeVisible();
    await expect(writtenCard.getByTestId("quick-replies")).toBeVisible();
    await reply.fill("Use the new deploy key from the vault, then retry.");
    await page.screenshot({ path: join(SHOTS, "feed-reply-dark.png") });
    await page.keyboard.press("Meta+Enter");
    await expect(writtenCard).toHaveCount(0, { timeout: 10_000 });
    await expect(trigger).toHaveAttribute("aria-label", "Open needs-you feed, 27 waiting");

    // Dismiss closes a signal without mail.
    const dismissed = await cards.first().getAttribute("data-item-id");
    await cards.first().getByRole("button", { name: "Write reply" }).click();
    await feed.locator(`[data-item-id='${dismissed}']`).getByRole("button", { name: "Dismiss" }).click();
    await expect(feed.locator(`[data-item-id='${dismissed}']`)).toHaveCount(0, { timeout: 10_000 });
    await expect(trigger).toHaveAttribute("aria-label", "Open needs-you feed, 26 waiting");

    await page.keyboard.press("Escape");
    await expect(feed).toHaveCount(0);

    // Settings > Quick replies: add, reorder, remove; the feed follows.
    await setTheme(page, "bright");
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.locator(".settings-nav__item", { hasText: "Quick replies" }).click();
    const section = page.getByTestId("settings-quick-replies-section");
    await expect(section.getByRole("textbox", { name: /^Quick reply \d+$/ })).toHaveCount(5);
    await section.getByLabel("New quick reply").fill("Ship it");
    await section.getByRole("button", { name: "Add" }).click();
    await expect(section.getByRole("textbox", { name: /^Quick reply \d+$/ })).toHaveCount(6);
    await section.getByRole("button", { name: 'Move "Ship it" up' }).click();
    await section.getByRole("button", { name: 'Remove "No"' }).click();
    await expect(section.getByRole("textbox", { name: /^Quick reply \d+$/ })).toHaveCount(5);
    await expect(section.getByLabel("Quick reply 4")).toHaveValue("Ship it");
    await page.screenshot({ path: join(SHOTS, "settings-quick-replies-bright.png") });
    await page.locator(".settings-panel__close").click();

    await page.keyboard.press("Meta+I");
    await expect(feed).toBeVisible();
    await expect(cards.first().getByTestId("quick-replies").getByRole("button")).toHaveText([
      "Yes",
      "Continue",
      "Go on",
      "Ship it",
      "Stop doing this",
    ]);
    await page.screenshot({ path: join(SHOTS, "feed-30-bright.png") });
    await cards.first().click({ position: { x: 200, y: 30 } });
    await page.keyboard.press("j");
    await page.screenshot({ path: join(SHOTS, "feed-selected-bright.png") });
    await page.keyboard.press("Escape");
    await expect(feed).toHaveCount(0);
  } finally {
    await junto.close();
  }
});

test("the operator feed with one waiting, then none", async () => {
  await mkdir(SHOTS, { recursive: true });
  const one = [DOCS[0]!];
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: doc(one) }, seedAgentSignals: signals(one, 1) });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow__node", { hasText: "Grove" })).toBeVisible({ timeout: 30_000 });
    for (const theme of ["dark", "bright"] as const) {
      await setTheme(page, theme);
      await page.keyboard.press("Meta+I");
      const feed = page.getByTestId("operator-feed");
      await expect(feed.getByTestId("operator-feed-card")).toHaveCount(1, { timeout: 10_000 });
      await page.screenshot({ path: join(SHOTS, `feed-1-${theme}.png`) });
      if (theme === "bright") {
        await feed.getByTestId("quick-replies").getByRole("button", { name: /Continue/ }).click();
        await expect(feed).toContainText("Nobody needs you right now", { timeout: 10_000 });
        await page.screenshot({ path: join(SHOTS, "feed-empty-bright.png") });
      }
      await page.keyboard.press("Escape");
      await expect(feed).toHaveCount(0);
    }
    await setTheme(page, "dark");
    await page.keyboard.press("Meta+I");
    await expect(page.getByTestId("operator-feed")).toContainText("Nobody needs you right now");
    await page.screenshot({ path: join(SHOTS, "feed-empty-dark.png") });
  } finally {
    await junto.close();
  }
});
