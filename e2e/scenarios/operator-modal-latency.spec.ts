import { canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

/**
 * Operator modal open latency and the shell's focus contract.
 *
 * The shell records every open as the performance measure
 * "operator-modal-open": from the operator's ask to the first painted frame.
 * This spec opens search repeatedly over a populated canvas and holds the
 * median under a budget, so a heavy mount on the open path fails here.
 */

const NODES = Array.from({ length: 120 }, (_, index) => ({
  id: `n-${index}`,
  type: "text" as const,
  x: (index % 12) * 280,
  y: Math.floor(index / 12) * 140,
  width: 240,
  height: 90,
  text: `Note ${index}\nbody line for note ${index}`,
}));

test.use({ juntoOptions: { seedCanvases: { probe: canvasDoc(NODES) } } });

const OPEN_BUDGET_MS = 100;

test("search opens within budget and returns focus where it was", async ({ junto }) => {
  const { page } = junto;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

  const trigger = page.locator(".station-command-trigger");
  await trigger.focus();
  const modal = page.locator('[data-layer="operator"][data-operator-modal="search"]');

  for (let round = 0; round < 12; round += 1) {
    await page.keyboard.press("Meta+k");
    await expect(modal).toBeVisible();
    await expect(page.getByTestId("command-bar-input")).toBeFocused();
    // One dim, never two.
    await expect(page.locator("[data-layer-backdrop]")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }

  const durations = await page.evaluate(() =>
    performance.getEntriesByName("operator-modal-open").map((entry) => entry.duration),
  );
  expect(durations.length).toBe(12);
  const sorted = [...durations].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const worst = sorted[sorted.length - 1]!;
  console.log(
    `operator-modal-open search over ${NODES.length} nodes: median ${median.toFixed(1)}ms, worst ${worst.toFixed(1)}ms, n=${durations.length}`,
  );
  expect(median).toBeLessThan(OPEN_BUDGET_MS);
});
