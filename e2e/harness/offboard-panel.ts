/**
 * What the operator reads in a seat's offboard panel (nodes/SeatOffboard.tsx):
 * opened from the toolbar above the seat's card, read once the core's status
 * for the seat has arrived, then closed again.
 */
import { expect, type Page } from "@playwright/test";

/**
 * Why Offboard now is refused for one seat, as the panel says it, or null
 * when the panel says nothing against it. The session line marks the core's
 * status as arrived: the core always sends the session's work minutes.
 */
export const offboardNowBlockOf = async (page: Page, seatId: string): Promise<string | null> => {
  const seat = page.locator(`.react-flow__node[data-id="${seatId}"]`);
  await expect(seat).toBeVisible({ timeout: 30_000 });
  await seat.click();
  await page.getByTestId("seat-offboard-open").click();
  const panel = page.getByRole("dialog", { name: /^Offboard / }).getByTestId("seat-offboard-panel");
  await expect(panel.getByTestId("seat-offboard-session")).toBeVisible({ timeout: 20_000 });
  const block = panel.getByTestId("seat-offboard-now-block");
  const text = (await block.count()) === 0 ? null : await block.textContent();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden({ timeout: 10_000 });
  return text;
};

/**
 * Offboard now on one seat, as the operator does it: open its panel, press
 * Offboard now twice (the first press arms it), and read the line the panel
 * answers with.
 */
export const offboardNowFromPanel = async (page: Page, seatId: string): Promise<string> => {
  const seat = page.locator(`.react-flow__node[data-id="${seatId}"]`);
  await expect(seat).toBeVisible({ timeout: 30_000 });
  await seat.click();
  await page.getByTestId("seat-offboard-open").click();
  const panel = page.getByRole("dialog", { name: /^Offboard / }).getByTestId("seat-offboard-panel");
  await expect(panel.getByTestId("seat-offboard-session")).toBeVisible({ timeout: 20_000 });
  const now = panel.getByTestId("seat-offboard-now");
  await now.click();
  await expect(now).toHaveAttribute("data-armed", "true");
  await now.click();
  const status = panel.getByTestId("seat-offboard-status");
  // The line says "Closing…" while the call runs, then the core's answer.
  await expect(status).not.toHaveText(/^(|Closing…)$/u, { timeout: 20_000 });
  const line = (await status.textContent()) ?? "";
  await page.keyboard.press("Escape");
  return line;
};
