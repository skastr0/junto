/**
 * Needs-you: what only the canvas knows reaches the feed.
 *   bun run test:e2e:fast e2e/scenarios/needs-you-canvas-needs.spec.ts
 *
 * The top bar popover used to be the only place a work stoppage showed. It
 * is gone, so the feed must carry those needs. Real work is seeded through
 * the task store: a task assigned to Atlas and left waiting on the
 * operator (the stoppage, which holds Atlas up). It is
 * written with origin times in the past, before the app has ever started: the
 * app that shows it never saw it begin, as after a quit and relaunch, so the
 * only place the times can come from is the task store.
 *
 * Asserts:
 *   - the stoppage and the held seat each appear as a feed row, in their region
 *   - the top bar button counts them, and its number is the feed header's
 *   - the button toggles the feed and no popover exists
 *   - each row shows the time its need truly began, on first launch and after a reload
 */
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Locator } from "@playwright/test";
import { makeStateEngineLive } from "../../src/main/junto/state/engine";
import type { Sandbox } from "../harness/sandbox";
import { modelFixture, modelNode, modelRegion, modelSeat } from "../harness/model";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "needs-you-canvas";
// When each need began, well before this app process exists.
const STOPPED_AT = Date.now() - 47 * 60_000;

const ops = modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 760, height: 360 });
const atlas = modelSeat({ id: "atlas", key: "local:e2e-needs-atlas", label: "Atlas", harness: "claude", x: 40, y: 80 });
const board = modelNode({ kind: "task", id: "board", x: 400, y: 80, width: 240, height: 120, z: 0 });
const nodes = [ops, atlas, board];
// Atlas reaches the Tasks node through the Ops region, with no wire (01).
const fixture = modelFixture(nodes, []);

/** Atlas's task waiting on the operator, as the task store holds it. */
const seedWork = async (sandbox: Sandbox): Promise<void> => {
  const runtime = ManagedRuntime.make(makeStateEngineLive(join(sandbox.homeDir, ".junto", "state", "junto.db")));
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(
          `INSERT INTO task_heads (canvas_name, task_id, number, node_id, title, state, assignee_node_id, epoch, stamps_required, reviewers_json, depends_on_json, checks_json, created_at, updated_at, state_since)
           VALUES (?, ?, 1, ?, 'Run the accounts migration.', 'input-required', ?, 0, 0, '[]', '[]', '[]', ?, ?, ?)`,
          [CANVAS, "01JZ00000000000000000000M1", board.id, atlas.id, STOPPED_AT - 30 * 60_000, STOPPED_AT, STOPPED_AT],
        );
      }),
    );
  } finally {
    await runtime.dispose();
  }
};

test("a work stoppage and the seat it holds up are feed rows, counted, and show when they truly began", async () => {
  const junto = await launchJunto({ seedModels: { [CANVAS]: fixture }, afterSeed: seedWork });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow__node", { hasText: "Atlas" })).toBeVisible({ timeout: 30_000 });

    // The button carries the count; there is no number in the label at zero.
    const trigger = page.getByTestId("operator-feed-trigger");
    await expect(trigger).toHaveAttribute("aria-label", "Needs you, 2", { timeout: 20_000 });
    await expect(trigger.locator(".operator-feed-trigger__count")).toHaveText("2");

    // Pressing it opens the feed itself: the popover is gone.
    await trigger.click();
    const modal = page.locator('[data-layer="operator"][data-operator-modal="feed"]');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId("needs-you-inbox")).toHaveCount(0);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(modal.locator(".operator-feed__status")).toHaveText("2 waiting");
    const regionOf = (itemId: string): Locator =>
      modal.locator(".operator-feed__region", { has: page.locator(`[data-item-id='${itemId}']`) });

    // The stoppage: the task sink whose claimed task waits on the operator.
    const stoppage = modal.locator("[data-item-id='stoppage:board']");
    await expect(stoppage).toHaveAttribute("data-kind", "blocked");
    await expect(stoppage).toContainText("holding up 1 other");
    await expect(regionOf("stoppage:board").locator(".operator-feed__region-label")).toHaveText("Ops");

    // The held node: the seat that work stops, in its region.
    const held = modal.locator("[data-item-id='held:atlas']");
    await expect(held).toHaveAttribute("data-kind", "blocked");
    await expect(held.locator(".operator-feed__kind")).toHaveText("blocked");
    await expect(held).toContainText("waiting on blocked work upstream");
    await expect(regionOf("held:atlas").locator(".operator-feed__region-label")).toHaveText("Ops");

    await expect(modal.getByTestId("operator-feed-card")).toHaveCount(2);

    // The same press closes it, like the chord.
    await trigger.dispatchEvent("click");
    await expect(modal).toHaveCount(0);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    // Each row says when its need truly began: the stoppage and the seat it
    // holds up since the task started waiting.
    const began: ReadonlyArray<readonly [string, number]> = [
      ["stoppage:board", STOPPED_AT],
      ["held:atlas", STOPPED_AT],
    ];
    const expectTrueTimes = async (): Promise<void> => {
      for (const [id, at] of began) {
        const row = modal.locator(`[data-item-id='${id}'] time`);
        // The tooltip layer may have moved the title into its own attribute.
        const said = await row.evaluate((time) => time.getAttribute("title") ?? time.getAttribute("data-junto-tooltip"));
        expect(said).toBe(await page.evaluate((ms) => new Date(ms).toLocaleString(), at));
      }
      await expect(modal.locator("[data-item-id='stoppage:board'] time")).toHaveText(/^4[78]m$/);
    };
    await trigger.click();
    await expectTrueTimes();
    await page.keyboard.press("Escape");

    // A reload reads the same store: nothing is restamped as now.
    await page.reload();
    await expect(page.locator(".react-flow__node", { hasText: "Atlas" })).toBeVisible({ timeout: 30_000 });
    await expect(trigger).toHaveAttribute("aria-label", "Needs you, 2", { timeout: 20_000 });
    await trigger.click();
    await expectTrueTimes();
  } finally {
    await junto.close();
  }
});
