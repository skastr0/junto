/**
 * Design-audit capture, BRIGHT mode — companion to design-audit.spec.ts.
 * Same harness, same seeded fixtures, but the app runs with
 * settings appearance.theme = bright (flipped through Settings →
 * Appearance, the real product path, so themeMode$ and the canvas paint
 * follow — a bare html[data-theme] override leaves canvas-2D layers dark).
 * Frames land in test-results/design-audit-bright/.
 *   bun run test:e2e:audit:bright
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  agentTextNode,
  canvasDoc,
  verbEdge,
} from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";
import type { CanvasEdge, CanvasNode, GroupNode } from "../../src/shared/canvas";

const SHOTS = join(process.cwd(), "test-results", "design-audit-bright");

const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
};

const noteNode: CanvasNode = {
  id: "note1",
  type: "text",
  text: "# Field notes\n\nThe **digest** stays deterministic.\n\n– relates edges are quiet\n– blockers paint crimson\n\n> the file is the agent API\n\n`bun run digest`",
  x: 0,
  y: 0,
  width: 280,
  height: 230,
};

const flaggedNote: CanvasNode = {
  id: "note2",
  type: "text",
  text: "release checklist",
  x: 340,
  y: 0,
  width: 220,
  height: 90,
  color: "1",
};

const attentionNote: CanvasNode = {
  id: "note3",
  type: "text",
  text: "copy review pending",
  x: 340,
  y: 140,
  width: 220,
  height: 90,
};

const regionNode: GroupNode = {
  id: "region1",
  type: "group",
  label: "forge orbit",
  x: -40,
  y: -60,
  width: 940,
  height: 400,
  ether: { region: { hold: true } },
};

const nodes: CanvasNode[] = [
  regionNode,
  noteNode,
  flaggedNote,
  attentionNote,
  agentTextNode({ id: "agent1", key: "local:default", label: "builder", x: 520, y: 400 }),
  agentTextNode({ id: "agent2", key: "local:reviewer", label: "reviewer", x: 520, y: 560 }),
];

const edges: CanvasEdge[] = [
  verbEdge("e1", "agent1", "agent2", "messages", nodes),
];

test("capture key surfaces in bright mode", async () => {
  const junto = await launchJunto({
    seedCanvases: { "design-audit-bright": canvasDoc(nodes, edges) },
  });
  try {
    const { page } = junto;
    await mkdir(SHOTS, { recursive: true });

    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

    // Flip to bright through the real settings path so every projection
    // (CSS attribute, themeMode$, canvas paint) follows.
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
    const brightChoice = page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: /Bright/ });
    await brightChoice.click();
    await expect(brightChoice).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
    await page.locator(".settings-panel__close").click();
    await page.waitForTimeout(400);

    // 1. Main canvas with seeded nodes.
    await expect(page.locator(".react-flow__node").first()).toBeVisible({
      timeout: 30_000,
    });
    const fit = page.getByRole("button", { name: /fit all/i });
    await expect(fit, "design audit: the Fit all nodes control is missing").toBeVisible({ timeout: 10_000 });
    await fit.click();
    await page.waitForTimeout(800);
    await shot(page, "01-canvas-full");

    // 2. Selected node → selection toolbar / RTS command area.
    await page
      .locator(".react-flow__node", { hasText: "Field notes" })
      .first()
      .click();
    await shot(page, "02-node-selected-toolbar");

    // 3. Note editor focus surface (document measure).
    await page.getByRole("button", { name: "Expand note editor" }).click();
    const noteEditor = page.getByRole("dialog", { name: "Edit note" });
    await expect(noteEditor).toBeVisible({ timeout: 10_000 });
    await shot(page, "03-note-edit-focus");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // 4. Settings panel (Appearance with Bright active).
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
    await shot(page, "05-settings");
    await page.locator(".settings-panel__close").click();
    await page.waitForTimeout(300);
  } finally {
    await junto.close();
  }
});
