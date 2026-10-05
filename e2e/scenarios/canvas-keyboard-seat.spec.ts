/**
 * A seat worked by keyboard: focus shows, selection is said, and the seat menu
 * takes focus, moves by arrows, and closes on Escape back to the seat.
 */
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

test.use({
  juntoOptions: {
    seedCanvases: {
      "keyboard-seat": canvasDoc([
        agentTextNode({ id: "seat", key: "local:keyboard-seat", label: "Keyboard seat", x: 0, y: 0 }),
      ]),
    },
  },
});

test("a focused seat shows a ring, says it is selected, and its menu works by keys", async ({ junto }) => {
  const { page } = junto;
  const seat = page.getByTestId("rf__node-seat");
  await expect(seat).toBeVisible({ timeout: 30_000 });

  // Keyboard focus shows a ring.
  await seat.focus();
  await page.keyboard.press("Shift");
  await expect(seat).toBeFocused();
  await expect.poll(() => seat.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");

  // Enter selects, and the name says so.
  await expect(seat).toHaveAttribute("aria-label", "Keyboard seat");
  await page.keyboard.press("Enter");
  await expect(seat).toHaveAttribute("aria-label", "Keyboard seat, selected");

  // The menu key opens the seat menu and focus enters at its first row.
  await seat.dispatchEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 400, clientY: 300 });
  const menu = page.getByTestId("seat-menu");
  await expect(menu).toBeVisible();
  const rows = menu.getByRole("menuitem");
  await expect(rows.first()).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(rows.last()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(rows.first()).toBeFocused();

  // Escape closes it and focus goes back to the seat.
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(seat).toBeFocused();
});
