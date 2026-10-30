/**
 * The 0.11.5 walk on a factory-sized canvas: 47 seats across six regions.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/release-0115-verify.spec.ts
 *
 * (1) Needs you: the seats fold behind a Seats chip, open at no more than two
 *     lines, a region pick narrows them, the chosen seat stays clearable in
 *     the bar, and Escape folds the row before it closes the feed.
 * (2) Seat Threads: mail between seats carries no count and no amber; the
 *     header counts only mail written to the operator in a thread they are
 *     in; the operator's own mail and a Needs you answer are read; the
 *     operator's threads list first.
 * Both walks are framed dark and bright.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { AgentSignal } from "../../src/shared/agent-signals";
import type { Seat as ModelSeat } from "../../src/shared/model";
import { expect, launchJunto, test } from "../harness/launch";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { modelFixture, modelRegion, modelSeat, modelWire } from "../harness/model";

const CANVAS = "release-0115";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? join("test-results", "release-0115");
const MINUTE = 60_000;

const TEAMS = [
  { id: "product", label: "Product", color: "4" },
  { id: "cli", label: "CLI", color: "6" },
  { id: "pty", label: "PTY", color: "3" },
  { id: "remote", label: "Remote", color: "5" },
  { id: "canvas", label: "Canvas", color: "1" },
] as const;
const ROLES = ["lead", "design", "feed", "modals", "shell", "settings", "keyboard", "verify", "automation"] as const;

const regions = [
  modelRegion({ id: "junto", label: "Junto", color: "2", x: 0, y: 0, width: 5400, height: 1300, z: 0 }),
  ...TEAMS.map((team, i) =>
    modelRegion({ id: team.id, label: team.label, color: team.color, x: 40 + i * 1060, y: 60, width: 1000, height: 1180, z: 1 }),
  ),
  modelRegion({ id: "ops", label: "Ops", color: "7", x: 0, y: 1500, width: 3000, height: 700, z: 0 }),
];
const teamSeats: ModelSeat[] = TEAMS.flatMap((team, t) =>
  ROLES.map((role, r) =>
    modelSeat({
      id: `${team.id}-${role}`,
      key: `local:r0115-${team.id}-${role}`,
      label: `${team.id}-${role}`,
      harness: "claude",
      x: 80 + t * 1060 + (r % 3) * 320,
      y: 140 + Math.floor(r / 3) * 360,
    }),
  ),
);
const scout = modelSeat({
  id: "scout",
  key: "local:r0115-scout",
  label: "Scout",
  harness: "codex",
  cwd: mkdtempSync(join(tmpdir(), "junto-r0115-scout-")),
  x: 40,
  y: 1560,
});
const ada = modelSeat({
  id: "ada",
  key: "local:r0115-ada",
  label: "Ada",
  harness: "codex",
  cwd: mkdtempSync(join(tmpdir(), "junto-r0115-ada-")),
  x: 2400,
  y: 1560,
});
const nodes = [...regions, ...teamSeats, scout, ada];

const KINDS: ReadonlyArray<AgentSignal["kind"]> = ["escalate", "blocked", "feedback", "work"];
const SIGNALS: ReadonlyArray<AgentSignal> = [
  ...teamSeats.map((seat, i): AgentSignal => ({
    signalId: `r0115-${seat.id}`,
    canvasName: CANVAS,
    nodeId: seat.id,
    kind: KINDS[i % KINDS.length]!,
    text: `${seat.id} asks about item ${i}`,
    createdAt: Date.now() - (20 + i) * MINUTE,
    state: "open",
  })),
  {
    signalId: "r0115-ada",
    canvasName: CANVAS,
    nodeId: "ada",
    kind: "escalate",
    text: "Ada asks: ship the pricing copy today?",
    createdAt: Date.now() - 2 * MINUTE,
    state: "open",
  },
];

const report: string[] = [];
const note = (line: string): void => {
  report.push(line);
  console.log(`R0115 ${line}`);
};

const shot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.mouse.move(4, 880);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

const setTheme = async (page: Page, mode: "dark" | "bright"): Promise<void> => {
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
  const choice = page
    .getByRole("radiogroup", { name: "Theme", exact: true })
    .getByRole("radio", { name: mode === "bright" ? "Bright" : "Dark", exact: true });
  await choice.click();
  await expect(choice).toHaveAttribute("aria-checked", "true");
  await page.locator(".settings-panel__close").click();
  await page.waitForTimeout(400);
};

const walkFeed = async (page: Page, mode: "dark" | "bright"): Promise<void> => {
  await page.keyboard.press("Meta+I");
  const feed = page.getByTestId("operator-feed");
  await expect(feed).toBeVisible({ timeout: 10_000 });
  const bar = page.getByTestId("feed-filter-bar");
  const toggle = bar.getByTestId("feed-seats-toggle");
  const row = bar.getByTestId("feed-seats-row");
  const chips = bar.getByTestId("feed-seat-chip");

  // Folded behind the Seats chip.
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(row).toBeHidden();
  note(`${mode} (1a) folded: toggle reads ${JSON.stringify((await toggle.innerText()).replace(/\s+/g, " "))}, row hidden`);
  await shot(page, `${mode}-1a-seats-folded`);

  // Open: every seat is a chip, the row is at most two chips tall.
  await toggle.click();
  await expect(row).toBeVisible();
  const all = await chips.count();
  const box = await row.evaluate((el) => {
    const chip = el.querySelector<HTMLElement>("[data-testid='feed-seat-chip']")!;
    const frame = el.getBoundingClientRect();
    const tops = new Set(
      [...el.querySelectorAll<HTMLElement>("[data-testid='feed-seat-chip']")]
        .map((c) => c.getBoundingClientRect())
        .filter((r) => r.top >= frame.top - 1 && r.bottom <= frame.bottom + 1)
        .map((r) => Math.round(r.top)),
    );
    return { rowHeight: el.clientHeight, scrollHeight: el.scrollHeight, chipHeight: chip.offsetHeight, visibleLines: tops.size };
  });
  note(`${mode} (1b) open: ${all} seat chips, row ${box.rowHeight}px tall (scroll ${box.scrollHeight}px), chip ${box.chipHeight}px, ${box.visibleLines} lines in view`);
  expect(all, "a chip per waiting seat").toBeGreaterThanOrEqual(46);
  expect(box.rowHeight, "the row opens at no more than two lines").toBeLessThan(box.chipHeight * 3);
  await shot(page, `${mode}-1b-seats-open-all`);

  // A region pick narrows the seats to that region's.
  await page.getByTestId("feed-region-chip").filter({ hasText: "CLI" }).click();
  await expect(chips).toHaveCount(ROLES.length, { timeout: 10_000 });
  const titles = await chips.evaluateAll((els) => els.map((el) => `${el.getAttribute("data-seat") ?? ""}:${el.getAttribute("title") ?? el.getAttribute("data-junto-tooltip") ?? ""}`));
  const inCli = titles.every((t) => t.startsWith("cli-"));
  note(`${mode} (1c) CLI picked: ${titles.length} seat chips, all CLI seats: ${inCli} (${titles[0]})`);
  expect(inCli, titles.join(" | ")).toBe(true);
  await shot(page, `${mode}-1c-region-narrows-seats`);

  // The chosen seat shows in the bar, clearable, folded or not.
  await chips.filter({ hasText: "cli-feed" }).click();
  await toggle.click();
  await expect(row).toBeHidden();
  const chosen = bar.getByTestId("feed-seat-chosen");
  await expect(chosen).toContainText("cli-feed");
  await expect(chosen.getByRole("button", { name: "Clear seat cli-feed" })).toBeVisible();
  await expect(feed.getByTestId("operator-feed-card")).toHaveCount(1);
  note(`${mode} (1d) cli-feed chosen: in the bar with its clear, 1 card`);
  await shot(page, `${mode}-1d-seat-chosen-folded`);
  await chosen.getByRole("button", { name: "Clear seat cli-feed" }).click();
  await expect(chosen).toHaveCount(0);

  // Escape folds the row first, then closes the feed.
  await toggle.click();
  await expect(row).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(row).toBeHidden();
  await expect(feed).toBeVisible();
  note(`${mode} (1e) Escape with the row open: row folded, feed still open`);
  await page.getByTestId("feed-region-chip").filter({ hasText: "All" }).click();
  await page.keyboard.press("Escape");
  await expect(feed).toBeHidden({ timeout: 10_000 });
  note(`${mode} (1e) second Escape: feed closed`);
};

test("0.11.5: the feed's seat row and the seat Threads count on a 47-seat canvas", async () => {
  test.setTimeout(600_000);
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: { [CANVAS]: modelFixture(nodes, [modelWire("e-scout-ada", "scout", "ada", "messages", nodes)]) },
    seedAgentSignals: SIGNALS,
    afterSeed: installCrewSeatHarness,
  });
  try {
    const { page, sandbox } = junto;
    await expect(page.getByTestId("operator-feed-trigger")).toHaveAttribute("aria-label", `Needs you, ${SIGNALS.length}`, { timeout: 30_000 });

    // (1) Needs you, dark then bright.
    for (const mode of ["dark", "bright"] as const) {
      await setTheme(page, mode);
      await walkFeed(page, mode);
    }
    await setTheme(page, "dark");

    // (2) Seat Threads.
    const adaCard = page.locator(`.react-flow__node[data-id="ada"]`);
    await crewPlayFactory(page);
    const scoutSeat = crewSeat(sandbox, CANVAS, "scout");
    const adaSeat = crewSeat(sandbox, CANVAS, "ada");
    await crewOccupySeat(page, CANVAS, scout, scoutSeat);
    await crewOccupySeat(page, CANVAS, ada, adaSeat);
    expect((await scoutSeat.op("onboard", {})).ok).toBe(true);
    expect((await adaSeat.op("onboard", {})).ok).toBe(true);
    for (const text of ["Read the release notes before standup?", "And the pricing page changed twice."]) {
      const sent = await scoutSeat.cli(["msg", "send", JSON.stringify({ target: "Ada", text })]);
      expect(sent.exitCode, sent.stderr.slice(0, 300)).toBe(0);
    }

    const openAda = async (): Promise<void> => {
      // At the whole-canvas zoom Ada stacks with Scout; tap 1 (Ada's slot) to select and center it.
      await page.locator(".react-flow__pane").click({ position: { x: 1400, y: 200 }, timeout: 5000 });
      await page.keyboard.press("1");
      await page.waitForTimeout(800);
      if (!(await adaCard.isVisible())) {
        for (let i = 0; i < 4 && !(await adaCard.isVisible()); i += 1) {
          await page.keyboard.press("Meta+Equal");
          await page.waitForTimeout(500);
        }
      }
      await adaCard.dblclick({ timeout: 10_000 });
      await expect(page.getByTestId("seat-threads-button")).toBeVisible({ timeout: 30_000 });
    };
    const closeModals = async (): Promise<void> => {
      for (let i = 0; i < 3; i += 1) {
        if ((await page.locator(".focus-surface").count()) === 0) return;
        // Escape belongs to the seat's terminal here; Close is the operator's way out.
        const close = page.locator(".focus-surface").last().getByRole("button", { name: /^close/i }).first();
        if (await close.isVisible().catch(() => false)) await close.click({ timeout: 5000 });
        else await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      }
    };
    const trigger = page.getByTestId("seat-threads-button");
    const count = trigger.getByTestId("seat-threads-button-unread");

    // Agent-to-agent mail: no count, no amber.
    await openAda();
    await page.waitForTimeout(3000);
    await expect(trigger).not.toHaveAttribute("data-unread", "true");
    await expect(count).toHaveCount(0);
    const quietColor = await trigger.evaluate((el) => getComputedStyle(el).color);
    note(`(2a) two Scout-to-Ada mails: button data-unread=${await trigger.getAttribute("data-unread")}, count shown ${await count.count()}, color ${quietColor}`);
    await shot(page, "dark-2a-between-seats-no-count");

    // The operator writes to Ada: their own mail is read.
    await trigger.click();
    await expect(page.getByTestId("seat-threads")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("seat-threads-between-seats").getByTestId("seat-threads-row")).toHaveCount(2, { timeout: 20_000 });
    await expect(page.getByTestId("seat-threads-row-unread")).toHaveCount(0);
    await page.getByTestId("seat-threads-new").click();
    const input = page.getByTestId("thread-composer-input");
    await input.click();
    await input.fill("Ada, where is the pricing copy?");
    await input.press("Enter");
    await expect(page.getByTestId("seat-threads-message")).toHaveCount(1, { timeout: 20_000 });
    await closeModals();
    await openAda();
    await page.waitForTimeout(1500);
    await expect(count).toHaveCount(0);
    note("(2b) operator wrote to Ada: still no count");

    // Ada replies to the operator: that one counts.
    const listed = await adaSeat.cli(["msg", "list", "{}"]);
    // The operator's mail is the one whose text the operator typed above.
    let parentId: string | undefined;
    const walk = (value: unknown): void => {
      if (parentId !== undefined || value === null || typeof value !== "object") return;
      const row = value as Record<string, unknown>;
      if (typeof row.messageId === "string" && JSON.stringify(row).includes("where is the pricing copy")) {
        parentId = row.messageId;
        return;
      }
      for (const child of Object.values(row)) walk(child);
    };
    walk(JSON.parse(listed.stdout));
    expect(parentId, listed.stdout.slice(0, 600)).toBeDefined();
    const replied = await adaSeat.cli(["msg", "reply", JSON.stringify({ target: "operator", inReplyTo: parentId, text: "Draft is in, two lines left." })]);
    expect(replied.exitCode, replied.stderr.slice(0, 300) + replied.stdout.slice(0, 300)).toBe(0);
    await expect(count).toHaveText("1", { timeout: 30_000 });
    await expect(trigger).toHaveAttribute("data-unread", "true");
    note(`(2c) Ada replied to the operator: button count ${await count.innerText()}, color ${await trigger.evaluate((el) => getComputedStyle(el).color)}`);
    await shot(page, "dark-2c-reply-to-operator-counts");
    await closeModals();

    // A Needs you answer is the operator's mail: read, the count holds.
    await page.keyboard.press("Meta+I");
    const feed = page.getByTestId("operator-feed");
    await expect(feed).toBeVisible({ timeout: 10_000 });
    await feed.getByTestId("operator-feed-card").filter({ hasText: "ship the pricing copy today" }).click();
    await expect(page.getByTestId("operator-feed-detail")).toHaveAttribute("data-item-id", "signal:r0115-ada");
    await page.keyboard.press("1");
    await expect(feed.locator("[data-item-id='signal:r0115-ada']")).toHaveCount(0, { timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(feed).toBeHidden({ timeout: 10_000 });
    await openAda();
    await page.waitForTimeout(2000);
    await expect(count).toHaveText("1");
    note(`(2d) answered Ada's need with quick reply 1: button count still ${await count.innerText()}`);

    // The popup: the operator's threads first, no count on between-seats rows.
    await trigger.click();
    await expect(page.getByTestId("seat-threads")).toBeVisible({ timeout: 20_000 });
    const withYou = page.getByTestId("seat-threads-with-you");
    const between = page.getByTestId("seat-threads-between-seats");
    await expect(withYou.getByTestId("seat-threads-row").first()).toBeVisible({ timeout: 20_000 });
    const order = await page.getByTestId("seat-threads").evaluate((el) => {
      const a = el.querySelector("[data-testid='seat-threads-with-you']");
      const b = el.querySelector("[data-testid='seat-threads-between-seats']");
      return a !== null && b !== null && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    });
    const withYouRows = await withYou.getByTestId("seat-threads-row").count();
    const betweenCounts = await between.getByTestId("seat-threads-row-unread").count();
    note(`(2e) popup: ${withYouRows} operator threads listed before ${await between.getByTestId("seat-threads-row").count()} between-seats threads: ${order}; counts on between-seats rows: ${betweenCounts}`);
    expect(order).toBe(true);
    expect(betweenCounts).toBe(0);
    await shot(page, "dark-2e-popup-operator-first");
    await closeModals();

    await setTheme(page, "bright");
    await openAda();
    await page.waitForTimeout(1000);
    note(`(2f) bright: button count shown ${await count.count()}`);
    await shot(page, "bright-2-button");
    await trigger.click();
    await expect(page.getByTestId("seat-threads")).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(800);
    await shot(page, "bright-2e-popup-operator-first");
  } finally {
    console.log(`R0115-REPORT\n${report.join("\n")}`);
    await junto.close();
  }
});
