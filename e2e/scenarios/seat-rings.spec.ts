/**
 * Seats and rings: captures seeded agent seats on the canvas in dark and
 * bright, and the in-app ring gallery (#/gallery/marks), for design review.
 * Frames land in test-results/activity-marks/.
 *   bun run test:e2e:fast e2e/scenarios/seat-rings.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessId } from "../../src/shared/managed-terminal-templates";
import { agentTextNode, canvasDoc, verbEdge } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "activity-marks");

const seats: ReadonlyArray<readonly [id: string, label: string, harness: HarnessId]> = [
  ["planner", "planner", "claude"],
  ["builder", "builder", "codex"],
  ["reviewer", "reviewer", "claude"],
  ["scout", "scout", "grok"],
  ["docs", "docs writer", "pi"],
  ["tester", "tester", "amp"],
];

const nodes = seats.map(([id, label, harness], index) =>
  agentTextNode({
    id,
    key: `local:e2e-seat-${id}`,
    label,
    harness,
    x: 40 + (index % 3) * 300,
    y: 40 + Math.floor(index / 3) * 140,
  }),
);

const fixture = canvasDoc(nodes, [
  verbEdge("e-planner-builder", "planner", "builder", "messages", nodes),
  verbEdge("e-reviewer-planner", "reviewer", "planner", "reviews", nodes),
]);

test("agent seats and their connection cards hold portraits in rings; the gallery renders", async () => {
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({ seedCanvases: { "seat-rings": fixture } });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    for (const mode of ["dark", "bright"] as const) {
      await page.getByRole("button", { name: "Open settings" }).click();
      await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
      const choice = page
        .getByRole("radiogroup", { name: "Theme", exact: true })
        .getByRole("radio", { name: mode === "bright" ? "Bright" : "Dark", exact: true });
      await choice.click();
      await expect(choice).toHaveAttribute("aria-checked", "true");
      await page.locator(".settings-panel__close").click();
      await page.waitForTimeout(400);
      const planner = page.locator('.react-flow__node[data-id="planner"]');
      await expect(planner).toBeVisible({ timeout: 30_000 });
      const seat = planner.getByTestId("agent-seat");
      await expect(seat).toBeVisible();
      await expect(seat.locator('.junto-mark[data-mark-size="seat"] .agent-portrait img')).toBeVisible();
      await page.waitForTimeout(600);
      await page.locator(".react-flow").screenshot({ path: join(SHOTS, `app-${mode}-canvas.png`) });
      await planner.screenshot({ path: join(SHOTS, `app-${mode}-seat.png`) });
      // Chrome appears only on selection (and hover).
      await planner.click();
      await page.waitForTimeout(300);
      await planner.screenshot({ path: join(SHOTS, `app-${mode}-seat-selected.png`) });

      // Connection cards show each agent peer as its seat: portrait in a ring.
      await planner.dblclick();
      const focus = page.locator('[data-focus-surface="1"]');
      await expect(focus).toBeVisible({ timeout: 20_000 });
      const glance = focus.getByTestId("actor-edges-glance");
      await expect(glance.locator('.junto-mark[data-mark-size="glance"] .agent-portrait').first()).toBeVisible({
        timeout: 10_000,
      });
      await page.waitForTimeout(600);
      await glance.screenshot({ path: join(SHOTS, `app-${mode}-connections.png`) });
      // The focus header leads with the same ringed portrait.
      await expect(focus.locator("header .junto-mark .agent-portrait").first()).toBeVisible();
      await focus.locator("header").first().screenshot({ path: join(SHOTS, `app-${mode}-focus-header.png`) });
      await focus.locator("header").getByRole("button", { name: "Close view", exact: true }).first().click();
      await expect(focus).toBeHidden({ timeout: 10_000 });
    }
    // A clean view: nothing selected, every seat in frame.
    await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
    await page.getByRole("button", { name: /fit all/i }).first().click();
    await page.waitForTimeout(400);
    // Preambles are not in the canvas document: main sends them on
    // junto:preamble. Staging one is a send to the window.
    const now = Date.now();
    const staged = [
      { nodeId: "planner", text: "splitting the migration into two steps" },
      { nodeId: "builder", text: "thrashing", provenance: "ai", action: "health", tone: "amber" },
      { nodeId: "reviewer", text: "blocked: needs the prod DB password", provenance: "agent", action: "signal", tone: "crimson" },
      { nodeId: "scout", text: "claimed a task", provenance: "agent", action: "tool", tone: "indigo" },
      { nodeId: "docs", text: "done, ready for review", provenance: "system", action: "state", tone: "green" },
      { nodeId: "tester", text: "mail from planner: rebase is done", provenance: "agent", action: "mail-in", tone: "violet" },
    ].map((fields, i) => ({ preambleId: `stage-${String(i)}`, canvasName: "seat-rings", expiresAt: now + 60_000, ...fields }));
    await junto.app.evaluate(({ BrowserWindow }, events) => {
      for (const window of BrowserWindow.getAllWindows()) {
        for (const event of events) window.webContents.send("junto:preamble", event);
      }
    }, staged);
    await expect(page.getByTestId("node-preamble")).toHaveCount(staged.length, { timeout: 10_000 });
    await page.waitForTimeout(500);
    await page.locator(".react-flow").screenshot({ path: join(SHOTS, "app-preambles-canvas.png") });

    // The dev gallery is a hash route on the same renderer.
    await page.evaluate(() => {
      window.location.hash = "#/gallery/marks";
      window.location.reload();
    });
    await expect(page.getByText("Seats and rings")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("agent-seat").first()).toBeVisible();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(SHOTS, "app-gallery.png") });
    await page.locator("section", { hasText: "colour is the action" }).first().screenshot({
      path: join(SHOTS, "app-gallery-preambles.png"),
    });
  } finally {
    await junto.close();
  }
});
