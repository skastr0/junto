/**
 * Design-audit capture, BRIGHT mode — companion to design-audit.spec.ts.
 * Same harness, same seeded fixtures, but the app runs with
 * settings appearance.theme = bright (flipped through Settings →
 * Appearance, the real product path, so themeMode$ and the canvas paint
 * follow — a bare html[data-theme] override leaves canvas-2D layers dark).
 * Frames land in test-results/design-audit-bright/.
 *   bun run test:e2e:fast e2e/scenarios/design-audit-bright.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  agentTextNode,
  canvasDoc,
  projectNode,
  tasksCriteriaEdge,
  tasksNode,
  taskItem,
} from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";
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
  ether: { flags: ["blocker"] },
};

const attentionNote: CanvasNode = {
  id: "note3",
  type: "text",
  text: "copy review pending",
  x: 340,
  y: 140,
  width: 220,
  height: 90,
  ether: { flags: ["attention"] },
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
  projectNode({ id: "proj1", name: "prism", x: 0, y: 400 }),
  projectNode({ id: "proj2", name: "vellum", x: 260, y: 400 }),
  agentTextNode({ id: "agent1", key: "local:default", label: "builder", x: 520, y: 400 }),
  tasksNode({
    id: "tasks1",
    x: 0,
    y: 560,
    items: [
      taskItem("t-1", "Ship browser containment probe", "submitted"),
      taskItem("t-2", "Fix stale host badge", "submitted"),
      taskItem("t-3", "Clarify claim tick rules", "input-required"),
      taskItem("t-5", "Rotate service key material", "completed"),
    ],
  }),
];

const edges: CanvasEdge[] = [
  tasksCriteriaEdge("e1", "tasks1", "agent1"),
  {
    id: "e2",
    fromNode: "proj1",
    toNode: "proj2",
    fromSide: "right",
    toSide: "left",
  },
  {
    id: "e3",
    fromNode: "note2",
    toNode: "proj2",
    fromSide: "right",
    toSide: "left",
    ether: { kind: "blocks" },
  },
];

test("capture key surfaces in bright mode", async () => {
  const vellum = await launchVellum({
    seedCanvases: { "design-audit-bright": canvasDoc(nodes, edges) },
  });
  try {
    const { page } = vellum;
    await mkdir(SHOTS, { recursive: true });

    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

    // Flip to bright through the real settings path so every projection
    // (CSS attribute, themeMode$, canvas paint) follows.
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
    const brightChoice = page
      .getByRole("radiogroup", { name: "Theme mode" })
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
    if (await fit.isVisible().catch(() => false)) await fit.click();
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

    // 4. Task flow overlay (kanban work surface).
    const tasksNodeCard = page.locator('.react-flow__node[data-id="tasks1"]');
    await expect(tasksNodeCard).toBeVisible({ timeout: 15_000 });
    await tasksNodeCard.getByTestId("tasks-card").dispatchEvent("dblclick");
    const taskFlow = page.getByRole("dialog", { name: "Task flow" });
    await expect(taskFlow).toBeVisible({ timeout: 10_000 });
    await expect(taskFlow.getByTestId("task-board")).toBeVisible();
    await shot(page, "04-task-flow-kanban");
    await taskFlow.locator('button[title="Close"]').click();
    await expect(taskFlow).toBeHidden();

    // 5. Settings panel (Appearance with Bright active).
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
    await shot(page, "05-settings");
    await page.locator(".settings-panel__close").click();
    await page.waitForTimeout(300);
  } finally {
    await vellum.close();
  }
});
