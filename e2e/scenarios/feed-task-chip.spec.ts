/**
 * A task named in a feed card's sentence (0.11.4, task 378): a seat writes
 * "#1 ..." in its signal and the card draws task 1 as a chip; pressing it
 * leaves the feed and opens the task on its board.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/feed-task-chip.spec.ts
 *
 * Asserts:
 *   - the card's sentence carries the words either side of one task chip
 *   - the chip says "#1" and the task's title, and is named by its number
 *   - Enter on the chip opens the task: the feed's answer keys stand down there
 *   - a press closes the feed and opens the task, named in its own detail
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import type { AgentSignal } from "../../src/shared/agent-signals";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { taskNodeId, type TaskCommand } from "../../src/shared/task-model";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";

const SHOTS = process.env.JUNTO_SHOTS_DIR ?? join(process.cwd(), "test-results", "feed-task-chip");
const CANVAS = "feed-task-chip";
const TITLE = "Ship the release notes";

const decode = (value: unknown) => Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })(value);

const fixture = () =>
  modelFixture(
    [
      modelRegion({ id: "build", label: "Build", x: 0, y: 0, width: 1200, height: 700, z: 0 }),
      modelSeat({ id: "atlas", key: "local:e2e-task-chip-atlas", label: "Atlas", harness: "claude", x: 60, y: 120 }),
      modelSeat({ id: "bravo", key: "local:e2e-task-chip-bravo", label: "Bravo", harness: "claude", x: 60, y: 320 }),
      decode({ kind: "task", id: "board", name: "Board", x: 520, y: 120, width: 320, height: 220, z: 0 }),
    ],
    [],
  );

// Numbering starts at 1 on a fresh canvas, so the card names the task the walk creates.
const SIGNALS: ReadonlyArray<AgentSignal> = [
  {
    signalId: "task-chip",
    canvasName: CANVAS,
    nodeId: "atlas",
    kind: "feedback",
    text: `#1 ${TITLE} is ready for you`,
    createdAt: Date.now() - 5 * 60_000,
    state: "open",
  },
  // The selected card's answer keys must not reach a chip on another card.
  {
    signalId: "task-chip-other",
    canvasName: CANVAS,
    nodeId: "bravo",
    kind: "escalate",
    text: "Which name do we ship?",
    createdAt: Date.now() - 4 * 60_000,
    state: "open",
  },
];

const shot = async (page: Page, theme: string, name: string): Promise<void> => {
  const dir = join(SHOTS, theme);
  await mkdir(dir, { recursive: true });
  await page.evaluate((next) => window.junto!.settingsPatch({ appearance: { theme: next as "dark" | "bright" } }), theme);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(dir, `${name}.png`) });
};

test("a task named in a card's words is a chip that opens it", async () => {
  test.setTimeout(180_000);
  const junto = await launchJunto({ seedModels: { [CANVAS]: fixture() }, seedAgentSignals: SIGNALS });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="board"]')).toBeVisible({ timeout: 30_000 });

    const taskId = mintItemId();
    const ruling = await page.evaluate(
      ({ canvas, node, taskId, opId, command }) => window.junto!.resource!.task!.apply(canvas, node, taskId, opId, command),
      {
        canvas: CANVAS,
        node: taskNodeId(asNodeId("board")),
        taskId,
        opId: mintOpId(),
        command: { kind: "create", taskId, title: TITLE } as TaskCommand,
      },
    );
    expect(ruling.kind).toBe("applied");

    await page.keyboard.press("Meta+I");
    const feed = page.getByTestId("operator-feed");
    await expect(feed).toBeVisible({ timeout: 10_000 });

    // Bravo's escalation sorts first; the task is named on Atlas's card.
    const card = feed.getByTestId("operator-feed-card").filter({ hasText: "Atlas" });
    await expect(card).toBeVisible({ timeout: 10_000 });
    const chip = card.locator('.operator-feed__text .resource-chip[data-kind="task"]');
    await expect(chip).toHaveCount(1);
    await expect(chip).toContainText("#1");
    await expect(chip).toContainText(TITLE);
    await expect(card.locator(".operator-feed__text")).toContainText("is ready for you");
    // Named by the number first, so speech says which task this is.
    await expect(feed.getByRole("button", { name: /^#1 /u })).toHaveCount(1);

    await shot(page, "dark", "1-task-chip");
    await shot(page, "bright", "2-task-chip-bright");
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));

    // A press leaves the feed and opens the task on its board.
    await chip.click();
    await expect(feed).toBeHidden({ timeout: 10_000 });
    await expect(page.getByText(TITLE).first()).toBeVisible({ timeout: 10_000 });

    // Enter, the key an operator reaches for first, opens the task rather than
    // answering the need: the feed's answer keys stand down inside a chip, even
    // with another card selected, which is whose keys they would otherwise be.
    await page.keyboard.press("Meta+I");
    await expect(feed).toBeVisible({ timeout: 10_000 });
    await feed.getByTestId("operator-feed-card").filter({ hasText: "Bravo" }).click();
    await chip.focus();
    await page.keyboard.press("Enter");
    await expect(feed).toBeHidden({ timeout: 10_000 });
    await expect(page.getByTestId("signal-reply")).toHaveCount(0);
    await expect(page.getByText(TITLE).first()).toBeVisible({ timeout: 10_000 });
    await expect(feed).toBeHidden({ timeout: 10_000 });
    await expect(page.getByText(TITLE).first()).toBeVisible({ timeout: 10_000 });
  } finally {
    await junto.close();
  }
});
