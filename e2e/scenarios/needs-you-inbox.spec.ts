/**
 * The top-right inbox: needs-you entries as notifications.
 *   bun run test:e2e:fast e2e/scenarios/needs-you-inbox.spec.ts
 *
 * Asserts:
 *   - the inbox button carries the live count
 *   - pressed, it lists who needs the operator, newest first, each need in plain words
 *   - a row goes to its seat: the popover closes and the seat is selected
 *   - the full feed is one link away
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { AgentSignal } from "../../src/shared/agent-signals";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "needs-you-inbox");
const CANVAS = "needs-you-inbox";
const MINUTE = 60_000;

const doc = canvasDoc(
  [
    agentTextNode({ id: "atlas", key: "local:e2e-inbox-atlas", label: "Atlas", harness: "claude", x: 40, y: 80 }),
    agentTextNode({ id: "nova", key: "local:e2e-inbox-nova", label: "Nova", harness: "codex", x: 420, y: 80 }),
  ],
  [],
);

const signal = (nodeId: string, kind: AgentSignal["kind"], text: string, minutesAgo: number): AgentSignal => ({
  signalId: `sig-${nodeId}`,
  canvasName: CANVAS,
  nodeId,
  kind,
  text,
  createdAt: Date.now() - minutesAgo * MINUTE,
  state: "open",
});

const setTheme = async (page: Page, theme: "dark" | "bright"): Promise<void> => {
  await page.evaluate((mode) => window.junto!.settingsPatch({ appearance: { theme: mode } }), theme);
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
  await page.waitForTimeout(250);
};

test("the inbox lists who needs you, newest first, and a row goes to the seat", async () => {
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({
    seedCanvases: { [CANVAS]: doc },
    seedAgentSignals: [
      signal("atlas", "blocked", "I need the staging database password to run the migration.", 12),
      signal("nova", "feedback", "The settings page redesign is ready for a look.", 2),
    ],
  });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow__node", { hasText: "Atlas" })).toBeVisible({ timeout: 30_000 });

    const trigger = page.getByTestId("operator-feed-trigger");
    await expect(trigger).toHaveAttribute("aria-label", "Open needs-you feed, 2 waiting", { timeout: 10_000 });

    const inbox = page.getByTestId("needs-you-inbox");
    for (const theme of ["dark", "bright"] as const) {
      await setTheme(page, theme);
      await trigger.click();
      await expect(inbox).toBeVisible();
      const rows = inbox.getByTestId("needs-you-row");
      await expect(rows).toHaveCount(2);
      // Newest first: Nova asked two minutes ago, Atlas twelve.
      await expect(rows.nth(0)).toHaveAttribute("data-node-id", "nova");
      await expect(rows.nth(0)).toContainText("review requested");
      await expect(rows.nth(1)).toHaveAttribute("data-node-id", "atlas");
      await expect(rows.nth(1)).toContainText("blocked");
      await expect(rows.nth(1)).toContainText("staging database password");
      // It opens under the button, in the top-right corner.
      const box = await inbox.boundingBox();
      const width = await page.evaluate(() => window.innerWidth);
      expect(box ? box.x + box.width > width * 0.6 && box.y < 120 : false).toBe(true);
      await page.screenshot({ path: join(SHOTS, `inbox-${theme}.png`) });
      await page.keyboard.press("Escape");
      await expect(inbox).not.toBeVisible();
    }

    // A row goes to its seat: the popover closes and the seat is selected.
    await trigger.click();
    await inbox.getByTestId("needs-you-row").filter({ hasText: "Atlas" }).click();
    await expect(inbox).not.toBeVisible();
    await expect(page.locator(".react-flow__node", { hasText: "Atlas" })).toHaveClass(/selected/);
    await expect(page.locator(".react-flow__node", { hasText: "Nova" })).not.toHaveClass(/selected/);

    // The full feed, for answering in place, is one link away.
    await trigger.click();
    await inbox.getByRole("button", { name: /full feed/i }).click();
    await expect(page.getByTestId("operator-feed")).toBeVisible();
    await expect(inbox).not.toBeVisible();
  } finally {
    await junto.close();
  }
});
