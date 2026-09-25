/**
 * Command groups on the hotbar: save a multi-selection to a slot with the
 * platform modifier plus a digit, recall it with the bare digit, and save
 * from the multi-select menu's slot picker.
 *
 * The contract itself is unit-tested in tests/command-groups.test.ts; this
 * only proves the wiring in the real app.
 * Run: `bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/command-groups.spec.ts`
 */
import { canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const note = (id: string, text: string, x: number) => ({
  id,
  type: "text" as const,
  text,
  x,
  y: 40,
  width: 180,
  height: 80,
});

const fixtureDoc = canvasDoc([
  note("n-alpha", "alpha", 40),
  note("n-beta", "beta", 280),
  note("n-gamma", "gamma", 520),
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
    if (!name) name = (await api.createCanvas("groups")).name;
    const read = await api.readCanvas(name);
    await api.writeCanvas(name, document, read.revision);
  }, fixtureDoc);
};

test("command groups: save, recall, and save from the menu", async ({ junto }) => {
  const { page } = junto;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await installBoard(page);

  const alpha = page.locator('.react-flow__node[data-id="n-alpha"]');
  const beta = page.locator('.react-flow__node[data-id="n-beta"]');
  const gamma = page.locator('.react-flow__node[data-id="n-gamma"]');
  await expect(alpha).toBeVisible({ timeout: 30_000 });
  await expect(gamma).toBeVisible({ timeout: 30_000 });

  const mod = process.platform === "darwin" ? "Meta" : "Control";

  await alpha.click({ modifiers: ["Shift"] });
  await beta.click({ modifiers: ["Shift"] });
  await expect(alpha).toHaveClass(/selected/);
  await expect(beta).toHaveClass(/selected/);

  // Save the two-node selection to slot 2.
  await page.keyboard.press(`${mod}+Digit2`);
  const slot2 = page.getByTestId("hotbar-slot-2");
  await expect(slot2).toHaveAttribute("data-tenure", "group");
  await expect(slot2).toContainText("alpha +1");

  // Clear, then recall: both come back selected.
  await page.keyboard.press("Escape");
  await expect(alpha).not.toHaveClass(/selected/);
  await page.keyboard.press("Digit2");
  await expect(alpha).toHaveClass(/selected/);
  await expect(beta).toHaveClass(/selected/);
  await expect(gamma).not.toHaveClass(/selected/);
  await expect(slot2).toHaveAttribute("aria-pressed", "true");

  // Save a different selection from the multi-select menu into slot 5.
  await page.keyboard.press("Escape");
  await expect(alpha).not.toHaveClass(/selected/);
  await expect(beta).not.toHaveClass(/selected/);
  await beta.click({ modifiers: ["Shift"] });
  await gamma.click({ modifiers: ["Shift"] });
  await expect(alpha).not.toHaveClass(/selected/);
  await expect(beta).toHaveClass(/selected/);
  await expect(gamma).toHaveClass(/selected/);
  await gamma.click({ button: "right" });
  const pick5 = page.getByRole("button", { name: "Save 2 nodes to group 5, empty" });
  await expect(pick5).toBeVisible();
  // Slot 2 shows what a save there would replace.
  await expect(
    page.getByRole("button", { name: "Save 2 nodes to group 2, replaces alpha, beta" }),
  ).toBeVisible();
  await pick5.click();
  const slot5 = page.getByTestId("hotbar-slot-5");
  await expect(slot5).toHaveAttribute("data-tenure", "group");
  await expect(slot5).toContainText("beta +1");
  await expect(slot2).toHaveAttribute("data-tenure", "group");
});
