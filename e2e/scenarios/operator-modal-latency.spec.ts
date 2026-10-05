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

test("an operator modal opens above a working modal, and Escape closes one layer at a time", async ({ junto }) => {
  const { page } = junto;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

  // A working modal: the canvas digest, opened from the command bar.
  await page.keyboard.press("Meta+k");
  await page.getByTestId("command-bar-input").fill(">digest");
  await page.keyboard.press("Enter");
  const digest = page.getByTestId("canvas-digest");
  await expect(digest).toBeVisible();
  await expect(page.locator('[data-layer="operator"]')).toHaveCount(0);

  // Search opens over it and owns the middle of the screen.
  await page.keyboard.press("Meta+k");
  const input = page.getByTestId("command-bar-input");
  await expect(input).toBeFocused();
  const topLayer = await page.evaluate(() => {
    const box = document.querySelector('[data-operator-modal="search"] [role="dialog"]')!.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit?.closest("[data-layer]")?.getAttribute("data-layer");
  });
  expect(topLayer).toBe("operator");

  // Escape closes search only; the digest is still there.
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-layer="operator"]')).toHaveCount(0);
  await expect(digest).toBeVisible();

  // The next Escape closes the working modal.
  await page.keyboard.press("Escape");
  await expect(digest).toHaveCount(0);
});

test("search and the feed swap in one shell, and closing returns focus to the start", async ({ junto }) => {
  const { page } = junto;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  const trigger = page.locator(".station-command-trigger");
  await trigger.focus();
  const shells = page.locator('[data-layer="operator"]');

  await page.keyboard.press("Meta+k");
  await expect(shells).toHaveAttribute("data-operator-modal", "search");

  // The other chord swaps: one shell, one dim, never two.
  await page.keyboard.press("Meta+i");
  await expect(shells).toHaveCount(1);
  await expect(shells).toHaveAttribute("data-operator-modal", "feed");
  await expect(page.locator("[data-layer-backdrop]")).toHaveCount(1);
  expect(await page.evaluate(() => document.activeElement?.closest("[data-operator-modal]") !== null)).toBe(true);

  await page.keyboard.press("Meta+k");
  await expect(shells).toHaveAttribute("data-operator-modal", "search");
  await expect(page.getByTestId("command-bar-input")).toBeFocused();

  // Ctrl chords are not the operator's on macOS: the field keeps them.
  await page.keyboard.press("Control+k");
  await expect(shells).toHaveAttribute("data-operator-modal", "search");

  // Closing after two swaps still returns to where the operator started.
  await page.keyboard.press("Escape");
  await expect(shells).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
