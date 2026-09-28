/**
 * Command groups in the top bar: save a multi-selection to a slot with the
 * platform modifier plus a digit, recall it with the bare digit, save from
 * the multi-select menu's slot picker, and keep groups past nine, which show
 * without a key. Chips carry their seats' faces in live rings; the bottom bar
 * holds no groups. Screenshots land in $JUNTO_SHOTS_DIR or
 * test-results/command-groups/ (never committed), both themes.
 *
 * The contract itself is unit-tested in tests/command-groups.test.ts; this
 * only proves the wiring in the real app.
 * Run: `bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/command-groups.spec.ts`
 */
import { agentTextNode, canvasDoc } from "../harness/sandbox";
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

const shots = process.env.JUNTO_SHOTS_DIR ?? "test-results/command-groups";

const installBoard = async (
  page: import("@playwright/test").Page,
  document: ReturnType<typeof canvasDoc> = fixtureDoc,
): Promise<void> => {
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
  }, document);
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

const crewDoc = canvasDoc([
  agentTextNode({ id: "seat-a", key: "local:alpha", label: "alpha", x: 0, y: 0 }),
  agentTextNode({ id: "seat-b", key: "local:beta", label: "beta", x: 300, y: 0, harness: "claude" }),
  agentTextNode({ id: "seat-c", key: "local:gamma", label: "gamma", x: 600, y: 0 }),
  ...Array.from({ length: 10 }, (_, index) => ({
    ...note(`n${index + 1}`, `note ${index + 1}`, index * 220),
    y: 260,
  })),
]);

const setTheme = async (page: import("@playwright/test").Page, theme: "Dark" | "Bright") => {
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
  await page.getByRole("radio", { name: theme }).click();
  await page.locator(".settings-panel__close").click();
  await page.waitForTimeout(300);
};

for (const theme of ["Dark", "Bright"] as const) {
  test(`command groups (${theme}): in the top bar, with faces, and past nine without a key`, async ({ junto }) => {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await setTheme(page, theme);
    await installBoard(page, crewDoc);
    const node = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
    await expect(node("seat-c")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Fit all nodes" }).click();
    await page.waitForTimeout(600);
    const mod = process.platform === "darwin" ? "Meta" : "Control";

    // The groups live in the top bar; the bottom bar holds none.
    const bar = page.locator("header.station-bar").getByRole("toolbar", { name: "Command groups" });
    await expect(bar).toBeVisible();
    await expect(bar.locator('[data-testid^="hotbar-slot-"]')).toHaveCount(9);
    await expect(page.locator('.rts-shell [data-testid^="hotbar-slot-"]')).toHaveCount(0);
    // The bottom bar is only its sections: no groups, no notify strip.
    await expect(page.locator(".rts-shell").getByRole("region", { name: "Notifications" })).toHaveCount(0);
    await expect(page.locator(".rts-shell > *")).toHaveCount(3);

    // Two seats to slot 1: the chip shows both faces in their rings.
    await node("seat-a").click({ modifiers: ["Shift"] });
    await node("seat-b").click({ modifiers: ["Shift"] });
    await page.keyboard.press(`${mod}+Digit1`);
    const slot1 = bar.getByTestId("hotbar-slot-1");
    await expect(slot1).toHaveAttribute("data-tenure", "group");
    await expect(slot1.locator(".group-chip__face")).toHaveCount(2);
    await expect(slot1.locator(".group-chip__face img, .group-chip__face svg").first()).toBeVisible();
    await expect(slot1.locator(".group-chip__key")).toHaveText("1");
    await page.keyboard.press("Escape");
    await page.locator("header.station-bar").screenshot({ path: `${shots}/${theme.toLowerCase()}-slot-1.png` });

    // Notes fill slots 2 to 9.
    for (let slot = 2; slot <= 9; slot += 1) {
      await page.keyboard.press("Escape");
      await node(`n${slot - 1}`).click();
      await page.keyboard.press(`${mod}+Digit${slot}`);
      await expect(bar.getByTestId(`hotbar-slot-${slot}`)).toHaveAttribute("data-tenure", "fixed");
    }

    // All nine held: a new group goes past nine, shown without a key.
    await page.keyboard.press("Escape");
    await node("seat-c").click({ modifiers: ["Shift"] });
    await node("n9").click({ modifiers: ["Shift"] });
    await bar.getByRole("button", { name: "Save the selection as a new group" }).click();
    const extra1 = bar.getByTestId("command-group-extra-1");
    await expect(extra1).toHaveAttribute("data-hotkey", "none");
    await expect(extra1.locator(".group-chip__key")).toHaveCount(0);
    await expect(extra1.locator(".group-chip__face")).toHaveCount(2);
    await page.keyboard.press("Escape");
    await node("n10").click();
    await bar.getByRole("button", { name: "Save the selection as a new group" }).click();
    await expect(bar.getByTestId("command-group-extra-2")).toHaveAttribute("data-hotkey", "none");
    await expect(bar.locator('[data-hotkey="none"]')).toHaveCount(2);

    // A group past nine is recalled by a click.
    await page.keyboard.press("Escape");
    await extra1.click();
    await expect(node("seat-c")).toHaveClass(/selected/);
    await expect(node("n9")).toHaveClass(/selected/);
    await expect(extra1).toHaveAttribute("aria-pressed", "true");
    const tag = theme.toLowerCase();
    await page.locator("header.station-bar").screenshot({ path: `${shots}/${tag}-top-bar.png` });
    await page.screenshot({ path: `${shots}/${tag}-window.png` });

    // Dragging it onto slot 9 gives it that key; slot 9's note moves past nine.
    const slot9 = bar.getByTestId("hotbar-slot-9");
    await extra1.scrollIntoViewIfNeeded();
    await extra1.dragTo(slot9);
    await expect(slot9).toHaveAttribute("data-tenure", "group");
    await expect(slot9.locator(".group-chip__face")).toHaveCount(2);
    await expect(bar.getByTestId("command-group-extra-1")).toContainText("note 8");
  });
}
