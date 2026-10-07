/**
 * The harness picker inside the agent editor's Launch tab, and the model
 * cascade in Add item: the harness list scrolls in its own box instead of
 * running over the hint and the profile row, the model cascade flies out
 * above the editor instead of under it, and the defaults row leads, lit.
 * Both themes; screenshots land in JUNTO_SHOTS_DIR, else
 * test-results/harness-picker/ (never committed).
 *
 * Run: `bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/harness-picker-layers.spec.ts`
 */
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { HARNESS_IDS } from "../../src/shared/managed-terminal-templates";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = process.env.JUNTO_SHOTS_DIR ?? join(process.cwd(), "test-results", "harness-picker");

const CLAUDE_MODELS = [
  { value: "claude-opus-4-6", label: "Opus 4.6" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5" },
  { value: "claude-opus-4-5", label: "Opus 4.5" },
  { value: "claude-sonnet-4-5", label: "Sonnet 4.5" },
  { value: "claude-opus-4-1", label: "Opus 4.1" },
  { value: "claude-sonnet-4", label: "Sonnet 4" },
  { value: "claude-haiku-3-5", label: "Haiku 3.5" },
];

const setTheme = async (page: Page, theme: "Dark" | "Bright") => {
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
  await page.getByRole("radio", { name: theme }).click();
  await page.locator(".settings-panel__close").click();
  await page.waitForTimeout(300);
};

/** The topmost element at a point belongs to `owner`. */
const onTop = async (page: Page, owner: string, x: number, y: number): Promise<boolean> =>
  page.evaluate(
    ({ owner, x, y }) => Boolean(document.elementFromPoint(x, y)?.closest(owner)),
    { owner, x, y },
  );

const box = async (locator: Locator) => {
  const found = await locator.boundingBox();
  if (!found) throw new Error("no box");
  return found;
};

test("the Launch tab keeps the harness list in its own box and the model cascade on top", async () => {
  test.setTimeout(120_000);
  const junto = await launchJunto({
    seedHarnessInstalls: HARNESS_IDS,
    claudeModelCache: CLAUDE_MODELS,
    seedCanvases: {
      portfolio: canvasDoc([agentTextNode({ id: "seat-ada", key: "local:ada", label: "Ada", harness: "claude" })]),
    },
  });
  try {
    const { page } = junto;
    const seat = page.locator('.react-flow__node[data-id="seat-ada"]');
    await expect(seat).toBeVisible({ timeout: 30_000 });

    for (const theme of ["Dark", "Bright"] as const) {
      await setTheme(page, theme);
      const tag = theme.toLowerCase();

      await page.getByRole("button", { name: "Fit all nodes" }).click();
      await page.waitForTimeout(600);
      const seatBox = await box(seat);
      await page.mouse.click(seatBox.x + seatBox.width / 2, seatBox.y + seatBox.height / 2, { button: "right" });
      await page.getByRole("button", { name: "Edit soul and instructions" }).click();
      await page.getByRole("tab", { name: "launch" }).click();

      const list = page.locator(".customize-launch__pick .agent-harness-pick__list");
      const claude = list.getByRole("button", { name: "Current Claude Code" });
      await expect(claude).toBeVisible();
      const hint = page.getByText("Picking a harness, model, or effort restarts this agent on it.", { exact: false });
      const save = page.getByRole("button", { name: "Save as profile" });

      // The list scrolls inside its box; nothing below it is covered.
      const scrolls = await list.evaluate((element) => element.scrollHeight > element.clientHeight + 1);
      expect(scrolls).toBe(true);
      const listBox = await box(list);
      expect(listBox.y + listBox.height).toBeLessThanOrEqual((await box(hint)).y + 0.5);
      const saveBox = await box(save);
      expect(await onTop(page, ".customize-launch__profile", saveBox.x + saveBox.width / 2, saveBox.y + saveBox.height / 2)).toBe(true);

      // The model cascade flies out above the editor, where it overlaps it too.
      await claude.hover();
      const models = page.getByRole("menu", { name: "Claude Code models" });
      await expect(models.getByRole("menuitem", { name: "Opus 4.6", exact: true })).toBeVisible();
      const defaults = models.getByRole("menuitem").first();
      await expect(defaults).toHaveAccessibleName("Use harness defaults");
      await expect(defaults).toHaveClass(/is-default/);
      const menuBox = await box(models);
      for (const [x, y] of [
        [menuBox.x + 6, menuBox.y + 6],
        [menuBox.x + menuBox.width / 2, menuBox.y + menuBox.height / 2],
        [menuBox.x + 6, menuBox.y + menuBox.height - 6],
      ] as const) {
        expect(await onTop(page, ".agent-cascade", x, y)).toBe(true);
      }
      await page.screenshot({ path: join(SHOTS, `${tag}-launch-cascade.png`) });

      // Close the cascade and the editor.
      await page.keyboard.press("Escape");
      await page.mouse.move(4, 4);
      await expect(page.locator(".agent-cascade")).toHaveCount(0);
      await page.screenshot({ path: join(SHOTS, `${tag}-launch.png`) });
      await page.keyboard.press("Escape");
      await expect(page.getByRole("tab", { name: "launch" })).toHaveCount(0);

      // Add item: the defaults row leads, lit; the search narrows the list.
      await page.getByRole("button", { name: "Add canvas item" }).click();
      const deck = page.getByRole("dialog", { name: "Add canvas item" });
      await deck.getByRole("button", { name: "Claude Code", exact: true }).hover();
      const deckModels = page.getByRole("menu", { name: "Claude Code models" });
      await expect(deckModels.getByRole("menuitem", { name: "Opus 4.6", exact: true })).toBeVisible();
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(SHOTS, `${tag}-add-item-cascade.png`) });
      await deckModels.getByRole("textbox", { name: "Search Claude Code models" }).click();
      await page.keyboard.type("son");
      await expect(deckModels.getByRole("menuitem")).toHaveText(["Sonnet 4.6", "Sonnet 4.5", "Sonnet 4", "sonnet", "sonnet[1m]"]);
      await page.screenshot({ path: join(SHOTS, `${tag}-add-item-search.png`) });
      await page.keyboard.press("Escape");
      await expect(deckModels.getByRole("menuitem").first()).toHaveAccessibleName("Use harness defaults");
      await page.keyboard.press("Escape");
      await expect(page.locator(".agent-cascade")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(deck).toHaveCount(0);
    }
  } finally {
    await junto.close();
  }
});
