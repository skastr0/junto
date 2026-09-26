/**
 * Agent portraits — captures seeded agent seats on the canvas, the agent
 * focus modal (header portrait + connection cards), and every way into the
 * customize-agent editor (seat toolbar, right-click, selection bar, focus
 * header) in dark and bright. Frames land in test-results/agent-portraits/.
 *   bun run test:e2e:fast e2e/scenarios/agent-portraits.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessId } from "../../src/shared/managed-terminal-templates";
import { agentTextNode, canvasDoc, verbEdge } from "../harness/sandbox";
import type { Locator, Page } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "agent-portraits");

const seats: ReadonlyArray<readonly [id: string, label: string, harness: HarnessId]> = [
  ["planner", "planner", "claude"],
  ["builder", "builder", "codex"],
  ["reviewer", "reviewer", "claude"],
  ["scout", "scout", "grok"],
  ["docs", "docs writer", "pi"],
  ["tester", "tester", "amp"],
  ["fixer", "fixer", "cursor"],
  ["ops", "ops", "hermes"],
];

const nodes = seats.map(([id, label, harness], index) =>
  agentTextNode({
    id,
    key: `local:e2e-portrait-${id}`,
    label,
    harness,
    x: 40 + (index % 4) * 290,
    y: 40 + Math.floor(index / 4) * 160,
  }),
);

/** A page shot around an element, with room for what floats beside it. */
const shotAround = async (page: Page, target: Locator, path: string, pad = 120): Promise<void> => {
  const box = await target.boundingBox();
  if (!box) throw new Error(`nothing to capture for ${path}`);
  const viewport = page.viewportSize() ?? { width: 1400, height: 900 };
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  await page.screenshot({
    path,
    clip: {
      x,
      y,
      width: Math.min(viewport.width - x, box.width + pad * 2),
      height: Math.min(viewport.height - y, box.height + pad * 2),
    },
  });
};

const fixture = canvasDoc(nodes, [
  verbEdge("e-planner-builder", "planner", "builder", "messages", nodes),
  verbEdge("e-reviewer-planner", "reviewer", "planner", "reviews", nodes),
  verbEdge("e-planner-scout", "planner", "scout", "messages", nodes),
]);

test("agent portraits render on seats and in the focus modal", async () => {
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({ seedCanvases: { "agent-portraits": fixture } });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    for (const mode of ["dark", "bright"] as const) {
      // Pick each mode through the real settings path; the default follows
      // the OS, so neither mode can be assumed.
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
      await expect(planner.locator(".agent-portrait img")).toBeVisible();
      await expect(planner.locator(".agent-portrait__badge")).toBeVisible();
      await page.waitForTimeout(600);
      await page.locator(".react-flow").screenshot({ path: join(SHOTS, `${mode}-canvas.png`) });
      await planner.screenshot({ path: join(SHOTS, `${mode}-node.png`) });

      // Entry 1: the seat toolbar. Selecting the seat shows "Customize
      // character" beside open terminal; it opens the editor beside the seat.
      await planner.click();
      const toolbarKey = page.getByTestId("toolbar-customize-agent");
      await expect(toolbarKey).toBeVisible({ timeout: 10_000 });
      await toolbarKey.hover();
      await page.waitForTimeout(300);
      await shotAround(page, planner, join(SHOTS, `${mode}-entry-toolbar.png`));
      await toolbarKey.click();
      const editor = page.getByTestId("agent-editor");
      await expect(editor).toBeVisible({ timeout: 10_000 });
      await expect(editor.getByRole("tab", { name: "look" })).toHaveAttribute("aria-selected", "true");
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(SHOTS, `${mode}-editor-look.png`) });
      await editor.screenshot({ path: join(SHOTS, `${mode}-editor.png`) });
      // Hovering an option tries it on the big stage; face traits zoom in.
      await editor.getByRole("radiogroup", { name: "hats and props" }).getByRole("radio").nth(4).hover();
      await expect(editor.locator(".agent-editor__plate")).toHaveAttribute("data-previewing", "true");
      await page.waitForTimeout(400);
      await editor.screenshot({ path: join(SHOTS, `${mode}-editor-preview.png`) });
      const eyes = editor.getByRole("radiogroup", { name: "eyes" });
      await eyes.scrollIntoViewIfNeeded();
      await eyes.getByRole("radio").nth(2).hover();
      await page.waitForTimeout(400);
      await editor.screenshot({ path: join(SHOTS, `${mode}-editor-face-traits.png`) });
      await editor.getByRole("tab", { name: "mood" }).click();
      await page.waitForTimeout(400);
      await editor.screenshot({ path: join(SHOTS, `${mode}-editor-mood.png`) });
      await page.keyboard.press("Escape");
      await expect(editor).toBeHidden({ timeout: 5_000 });

      // Entry 2: right-click the seat. "rename" opens the editor on Name.
      await planner.click({ button: "right" });
      const menu = page.getByTestId("seat-menu");
      await expect(menu).toBeVisible({ timeout: 5_000 });
      await menu.getByRole("button", { name: "Customize character" }).hover();
      await page.waitForTimeout(200);
      await shotAround(page, menu, join(SHOTS, `${mode}-entry-context-menu.png`));
      await menu.getByRole("button", { name: "Rename agent" }).click();
      await expect(editor).toBeVisible({ timeout: 10_000 });
      await expect(editor.getByRole("tab", { name: "name" })).toHaveAttribute("aria-selected", "true");
      const nameField = editor.getByTestId("agent-editor-name");
      const nextName = mode === "dark" ? "lead planner" : "planner";
      await nameField.fill(nextName);
      await nameField.press("Enter");
      await expect(planner).toContainText(nextName);
      await expect(editor.locator("header")).toContainText(nextName);
      await page.waitForTimeout(300);
      await editor.screenshot({ path: join(SHOTS, `${mode}-editor-name.png`) });
      await page.keyboard.press("Escape");
      await expect(editor).toBeHidden({ timeout: 5_000 });

      // Entry 3: the selection bar with one agent selected.
      const barKey = page.getByTestId("rts-customize-agent");
      await expect(barKey).toBeVisible({ timeout: 10_000 });
      await barKey.hover();
      await page.waitForTimeout(300);
      await page.locator(".rts-bar-panel").screenshot({ path: join(SHOTS, `${mode}-entry-selection-bar.png`) });
      await barKey.click();
      await expect(editor).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS, `${mode}-editor-from-bar.png`) });
      await page.keyboard.press("Escape");
      await expect(editor).toBeHidden({ timeout: 5_000 });

      await planner.dblclick();
      const focus = page.locator('[data-focus-surface="1"]');
      await expect(focus).toBeVisible({ timeout: 20_000 });
      await expect(focus.locator("header .agent-portrait").first()).toBeVisible();
      const glance = focus.getByTestId("actor-edges-glance");
      await expect(glance.locator(".agent-portrait").first()).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(600);
      await focus.screenshot({ path: join(SHOTS, `${mode}-focus.png`) });

      // Entry 4: the focus header portrait. Hover shows a pencil and a
      // "Customize" tag; a press opens the editor. Pick a body, see the
      // preview and the saved override.
      const headerKey = focus.locator("header").getByTestId("customize-agent-button");
      await headerKey.hover();
      await expect(headerKey.locator(".customize-agent-button__tag")).toHaveCSS("opacity", "1");
      await shotAround(page, headerKey, join(SHOTS, `${mode}-entry-focus-hover.png`), 80);
      await headerKey.click();
      await expect(editor).toBeVisible({ timeout: 10_000 });
      if (mode === "dark") {
        await editor.getByRole("radio", { name: "body Toast", exact: true }).click();
        await expect(editor.getByRole("radio", { name: "body Toast", exact: true })).toHaveAttribute("aria-checked", "true");
        // Saved in junto.db through main: the store round-trips it.
        await expect
          .poll(() => page.evaluate(async () => (await window.junto!.portraitOverridesList())["planner"]?.shape))
          .toBe("toast");
      }
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(SHOTS, `${mode}-editor-in-focus.png`) });
      await page.keyboard.press("Escape");
      await expect(editor).toBeHidden({ timeout: 5_000 });
      await glance.screenshot({ path: join(SHOTS, `${mode}-connections.png`) });
      await focus.locator("header").getByRole("button", { name: "Close view", exact: true }).first().click();
      await expect(focus).toBeHidden({ timeout: 10_000 });
      await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
    }
  } finally {
    await junto.close();
  }
});
