/**
 * The artifact keymap (0.10.3, product-keyboard) in the real app: the list
 * moves with Up and Down and opens into the content with Enter, Cmd+Alt and
 * an arrow step between list, content and comments, Cmd+Shift+M opens and
 * closes the comments with the caret in the document, Cmd+B leaves the rail
 * alone, and the Keys button lists it all. Frames in dark and bright.
 *
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/artifact-keys.spec.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";

const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/artifact-keys";
const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({
  kind: "artifacts",
  id: "shelf",
  label: "Shelf",
  x: 60,
  y: 60,
  width: 280,
  height: 160,
  z: 0,
});

const shot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

const seedDocument = (page: Page, canvas: string, title: string, markdown: string) =>
  page.evaluate(
    ({ canvas, node, artifactId, opId, title, markdown }) =>
      window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, { op: "create", title, body: { type: "document", markdown } }),
    { canvas, node: asNodeId("shelf"), artifactId: mintItemId(), opId: mintOpId(), title, markdown },
  );

/** Which pane holds the keyboard: sidebar, main, rail, or none. */
const paneWithFocus = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    const pane = active?.closest(".two-pane__sidebar, .two-pane__main, .two-pane__rail");
    return pane ? pane.className.replace("two-pane__", "") : "none";
  });

const toBright = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
  const bright = page.getByRole("radiogroup", { name: "Theme", exact: true }).getByRole("radio", { name: /Bright/ });
  await bright.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  await page.locator(".settings-panel__close").click();
  await page.waitForTimeout(400);
};

for (const theme of ["dark", "bright"] as const) {
  test(`artifact keys in the real app, ${theme}`, async () => {
    test.setTimeout(240_000);
    const canvas = `artifact-keys-${theme}`;
    const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [canvas]: modelFixture([shelf], []) } });
    try {
      const { page } = junto;
      const card = page.locator('.react-flow__node[data-id="shelf"]');
      await expect(card).toBeVisible({ timeout: 30_000 });
      if (theme === "bright") await toBright(page);
      await seedDocument(page, canvas, "Launch plan", "# Launch plan\n\nThe pitch lands on the desktop app first.");
      await seedDocument(page, canvas, "Release notes", "# Release notes\n\nWhat shipped in 0.10.3.");
      await card.dblclick();
      const list = page.getByRole("list", { name: "Artifacts" });
      await expect(list.locator("button")).toHaveCount(2, { timeout: 20_000 });
      const title = page.locator(".artifact-head__title");

      // The list: Down moves the pick and the keyboard, Enter opens into the content.
      await list.locator("button").first().focus();
      const first = await title.inputValue();
      await page.keyboard.press("ArrowDown");
      await expect(title).not.toHaveValue(first);
      await expect(list.locator("button[data-selected='true']")).toBeFocused();
      await shot(page, `${theme}-1-list-moved`);
      // The keys every list shares: K back up, J down again, Home to the top.
      await page.keyboard.press("k");
      await expect(title).toHaveValue(first);
      await page.keyboard.press("j");
      await expect(title).not.toHaveValue(first);
      await page.keyboard.press("Home");
      await expect(title).toHaveValue(first);
      await page.keyboard.press("End");
      await expect(list.locator("button[data-selected='true']")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect.poll(() => paneWithFocus(page)).toBe("main");

      // Cmd+Shift+M opens the comments with the caret in the document; Cmd+B does not.
      await page.locator(".cm-content").click();
      await page.keyboard.press("Meta+B");
      await expect(page.locator(".two-pane")).toHaveAttribute("data-rail", "collapsed");
      await page.keyboard.press("Meta+Shift+M");
      await expect(page.locator(".two-pane")).toHaveAttribute("data-rail", "true");
      await shot(page, `${theme}-2-comments-open`);

      // Cmd+Alt and an arrow: content, comments, then round to the list.
      await page.keyboard.press("Meta+Alt+ArrowRight");
      await expect.poll(() => paneWithFocus(page)).toBe("rail");
      await page.keyboard.press("Meta+Alt+ArrowRight");
      await expect.poll(() => paneWithFocus(page)).toBe("sidebar");
      await page.keyboard.press("Meta+Alt+ArrowLeft");
      await expect.poll(() => paneWithFocus(page)).toBe("rail");

      // Closing from the composer leaves the keyboard on the edge, not the page.
      await page.getByLabel("New comment").focus();
      await page.keyboard.press("Meta+Shift+M");
      await expect(page.locator(".two-pane")).toHaveAttribute("data-rail", "collapsed");
      await expect(page.locator(".artifact-comments-edge")).toBeFocused();

      // The Keys button lists the pane's keys and the document's.
      await page.locator(".artifact-head").getByRole("button", { name: "Keys", exact: true }).click();
      const keys = page.getByRole("dialog", { name: "Artifact keys" });
      await expect(keys).toBeVisible();
      await expect(keys).toContainText("Open or close the artifact's comments");
      await expect(keys).toContainText("Move the keyboard to the next pane");
      await expect(keys).toContainText("Stop writing and read the document");
      await shot(page, `${theme}-3-keys-popover`);
    } finally {
      await junto.close();
    }
  });
}

test("pad keys and a collapsed sidebar in the real app", async () => {
  test.setTimeout(240_000);
  const canvas = "artifact-keys-pad";
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [canvas]: modelFixture([shelf], []) } });
  try {
    const { page } = junto;
    const card = page.locator('.react-flow__node[data-id="shelf"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await seedDocument(page, canvas, "Launch plan", "# Launch plan\n\nThe pitch.");
    await card.dblclick();
    await expect(page.getByRole("list", { name: "Artifacts" }).locator("button")).toHaveCount(1, { timeout: 20_000 });

    // A collapsed sidebar is stepped over: content, comments, content.
    await page.locator(".cm-content").click();
    await page.keyboard.press("Meta+Shift+M");
    await page.getByRole("button", { name: "Sidebar" }).first().click();
    await expect(page.locator(".two-pane")).toHaveAttribute("data-sidebar", "collapsed");
    await page.locator(".cm-content").click();
    await page.keyboard.press("Meta+Alt+ArrowRight");
    await expect.poll(() => paneWithFocus(page)).toBe("rail");
    await page.keyboard.press("Meta+Alt+ArrowRight");
    await expect.poll(() => paneWithFocus(page)).toBe("main");
    await page.getByRole("button", { name: "Sidebar" }).first().click();
    await expect(page.locator(".two-pane")).not.toHaveAttribute("data-sidebar", "collapsed");

    // The pad: a letter picks the tool, Escape goes back to select.
    await page.getByRole("button", { name: "New artifact" }).click();
    await page.getByRole("group", { name: "New artifact" }).locator("button").filter({ hasText: "Pad" }).click();
    const svg = page.getByTestId("pad-svg");
    await expect(svg).toBeVisible({ timeout: 15_000 });
    const area = (await svg.boundingBox())!;
    const cx = area.x + area.width / 2;
    const cy = area.y + area.height / 2;
    await svg.click({ position: { x: 20, y: 20 } });
    for (const [key, tool] of [["r", "box"], ["o", "ellipse"], ["a", "connect"], ["v", "select"]] as const) {
      await page.keyboard.press(key);
      await expect(page.getByTestId(`pad-tool-${tool}`)).toHaveAttribute("aria-pressed", "true");
    }
    await page.keyboard.press("r");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("pad-tool-select")).toHaveAttribute("aria-pressed", "true");

    // Draw a box, then duplicate, undo and redo it from the keyboard.
    await page.keyboard.press("r");
    await page.mouse.move(cx - 80, cy - 50);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy + 50, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByTestId("pad-selection")).toBeVisible({ timeout: 10_000 });
    const meta = page.locator(".artifact-head__meta");
    await expect(meta).toHaveText("Pad, version 2", { timeout: 15_000 });
    await page.keyboard.press("Meta+D");
    await expect(meta).toHaveText("Pad, version 3", { timeout: 15_000 });
    await shot(page, "pad-1-duplicated");
    await page.keyboard.press("Meta+Z");
    await expect(meta).toHaveText("Pad, version 4", { timeout: 15_000 });
    await page.keyboard.press("Meta+Shift+Z");
    await expect(meta).toHaveText("Pad, version 5", { timeout: 15_000 });
    await page.locator(".artifact-head").getByRole("button", { name: "Keys", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Artifact keys" })).toContainText("Duplicate the selected shape");
    await shot(page, "pad-2-keys");
  } finally {
    await junto.close();
  }
});
