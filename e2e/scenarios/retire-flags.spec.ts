/**
 * Retired operator flags and scope pause, in the real app: a selected agent
 * seat's toolbar carries no pause and no flag, Stop names the agent's process
 * and confirms in words, the RTS command card has no flag or pause keys, and
 * the multi-select menu has no flag entries. Both themes.
 * Screenshots land in test-results/retire-flags/ (never committed).
 *
 * Run: `bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/retire-flags.spec.ts`
 */
import { agentTextNode, canvasDoc, textNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const shots = "test-results/retire-flags";

const fixtureDoc = canvasDoc([
  agentTextNode({ id: "seat-a", key: "local:alpha", label: "alpha", x: 0, y: 0 }),
  agentTextNode({ id: "seat-b", key: "local:beta", label: "beta", x: 420, y: 0 }),
  textNode("note", "release checklist", 0, 260),
]);

const installBoard = async (page: import("@playwright/test").Page): Promise<void> => {
  await expect
    .poll(
      async () =>
        page.evaluate(() => Boolean((globalThis as { junto?: { listCanvases?: unknown } }).junto?.listCanvases)),
      { timeout: 30_000 },
    )
    .toBe(true);
  await page.evaluate(async (document) => {
    const api = window.junto!;
    let name = (await api.listCanvases())[0]?.name;
    if (!name) name = (await api.createCanvas("retire-flags")).name;
    const read = await api.readCanvas(name);
    await api.writeCanvas(name, document, read.revision);
  }, fixtureDoc);
};

const center = async (locator: import("@playwright/test").Locator) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error("node never laid out");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

const tour = async (page: import("@playwright/test").Page, theme: string): Promise<void> => {
  const seat = page.locator('.react-flow__node[data-id="seat-a"]');
  const other = page.locator('.react-flow__node[data-id="seat-b"]');

  // Single seat: toolbar and command card.
  await page.keyboard.press("Escape");
  const a = await center(seat);
  await page.mouse.click(a.x, a.y);
  await expect(seat).toHaveClass(/selected/);
  await expect(page.getByTestId("node-toolbar-pause")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Flag|Clear) (blocker|attention|parked)/ })).toHaveCount(0);
  await expect(page.getByTestId("rts-pause-node")).toHaveCount(0);
  const stop = page.getByRole("button", { name: "Stop this agent's process" });
  await expect(stop).toBeVisible();
  await page.screenshot({ path: `${shots}/${theme}-1-seat-selected.png` });

  // First click arms: the confirm reads as words. Never click it twice here.
  await stop.click();
  const confirm = page.getByRole("button", { name: "Confirm: stop this agent's process" });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("Stop process?");
  await page.screenshot({ path: `${shots}/${theme}-2-stop-armed.png` });
  await page.keyboard.press("Escape");

  // Multi-select: no flag entries in the menu, no flag keys on the card.
  await page.keyboard.down("Shift");
  await page.mouse.click(a.x, a.y);
  const b = await center(other);
  await page.mouse.click(b.x, b.y);
  await page.keyboard.up("Shift");
  await expect(page.getByTestId("rts-multi-command")).toBeVisible();
  await expect(page.getByTestId("rts-multi-command").getByRole("button", { name: /flag|Clear all flags/i })).toHaveCount(0);
  await page.mouse.click(b.x, b.y, { button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("button", { name: /Flag blocker|Clear flags/ })).toHaveCount(0);
  await page.screenshot({ path: `${shots}/${theme}-3-multi-menu.png` });
  await page.keyboard.press("Escape");
};

test("retired flags and scope pause stay gone; Stop says it stops the agent's process", async ({ junto }) => {
  const { page } = junto;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await installBoard(page);
  for (const id of ["seat-a", "seat-b", "note"]) {
    await expect(page.locator(`.react-flow__node[data-id="${id}"]`)).toBeVisible({ timeout: 30_000 });
  }
  await page.getByRole("button", { name: "Fit all nodes" }).click();
  await page.waitForTimeout(600);

  for (const theme of ["Dark", "Bright"] as const) {
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
    await page.getByRole("radio", { name: theme }).click();
    // Dark is the base palette: it carries no data-theme attribute.
    if (theme === "Bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
    else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
    await page.locator(".settings-panel__close").click();
    await page.waitForTimeout(400);
    await tour(page, theme.toLowerCase());
  }
});
