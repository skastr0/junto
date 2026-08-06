/**
 * RTS shell controls e2e.
 *
 * Layout: region strip (1–9) above the whole bar; left = type/base actions
 * per physics role (pause, flags, region arm/pulse); middle = kind actions
 * (agent chat, herdr terminal, task board, …); right = minimap. Node/region
 * pause toggles live on left / chips.
 *
 * Boards install at runtime via window.vellumCommand (authority-only boot); pattern
 * copied from pause-surface.spec.ts.
 * Run: `bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/rts-controls.spec.ts`
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { agentTextNode, canvasDoc, tasksNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "rts-controls");

const fixtureDoc = canvasDoc([
  tasksNode({ id: "tasks", x: 40, y: 40 }),
  agentTextNode({
    id: "seat",
    key: "local:worker",
    label: "worker",
    x: 340,
    y: 40,
  }),
  // Region with one member (geometric membership) so the hotbar has a chip.
  {
    id: "region-ops",
    type: "group",
    label: "ops",
    x: 640,
    y: 20,
    width: 420,
    height: 260,
  },
  agentTextNode({
    id: "ops-seat",
    key: "local:ops",
    label: "ops worker",
    x: 700,
    y: 80,
  }),
]);

/** Authority-only boot: disk seed is not live. Install via writeCanvas. */
const installBoard = async (page: import("@playwright/test").Page): Promise<string> => {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const runtime = globalThis as unknown as {
            readonly vellumCommand?: { readonly listCanvases: () => Promise<unknown[]> };
          };
          return Boolean(runtime.vellumCommand?.listCanvases);
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  return page.evaluate(async (document) => {
    const api = (
      globalThis as unknown as {
        readonly vellumCommand: {
          readonly listCanvases: () => Promise<ReadonlyArray<{ name: string }>>;
          readonly createCanvas: (name: string) => Promise<{ name: string; revision: string }>;
          readonly readCanvas: (name: string) => Promise<{ name: string; revision: string }>;
          readonly writeCanvas: (
            name: string,
            doc: unknown,
            expectedRevision?: string,
          ) => Promise<unknown>;
        };
      }
    ).vellumCommand;
    let list = await api.listCanvases();
    let name = list[0]?.name;
    if (!name) {
      const created = await api.createCanvas("rts");
      name = created.name;
    }
    const read = await api.readCanvas(name);
    await api.writeCanvas(name, document, read.revision);
    return name;
  }, fixtureDoc);
};

test("rts shell: role left, kind middle, region strip, pause everywhere", async ({
  vellumCommand,
}) => {
  const { page } = vellumCommand;
  await mkdir(SHOTS, { recursive: true });

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await installBoard(page);
  const seat = page.locator(".react-flow__node", { hasText: "worker" }).first();
  await expect(seat).toBeVisible({ timeout: 30_000 });

  // Select the actor seat.
  await seat.click();

  // Left bar: role-derived command card with the node pause toggle (actor).
  const leftPause = page.getByTestId("rts-pause-node");
  await expect(leftPause).toBeVisible();
  await expect(leftPause).toHaveAttribute("data-paused", "false");
  await expect(page.locator(".rts-panel--cmd .rts-panel__label")).toContainText("actor");

  // Middle bar: kind surface (identity/actions + fields key).
  // ACP chat is hard-hidden (LEGACY_SURFACES_HIDDEN) — strip still labels the kind.
  const kindSurface = page.locator(".rts-kind-surface");
  await expect(kindSurface).toBeVisible();
  const kindStrip = kindSurface.locator(".rts-kind-strip");
  await expect(kindStrip).toBeVisible();
  await expect(kindStrip).toContainText("agent");
  await expect(kindStrip.getByRole("button", { name: "Open chat" })).toHaveCount(0);
  await expect(kindStrip.getByRole("button", { name: "Open fields" })).toBeVisible();

  // Hotbar strip above command+kind — empty until operator assigns a slot.
  const regionStrip = page.locator(".rts-region-strip");
  await expect(regionStrip).toBeVisible();
  await expect(regionStrip.locator(".rts-region-strip__empty")).toBeVisible();

  // Floating node toolbar carries the same pause toggle.
  const toolbarPause = page.getByTestId("node-toolbar-pause");
  await expect(toolbarPause).toBeVisible();
  await expect(toolbarPause).toHaveAttribute("data-paused", "false");

  await page.screenshot({ path: join(SHOTS, "01-actor-selected.png"), fullPage: false });

  // Pause the node from the left bar; both toggles flip from the write result.
  await leftPause.click();
  await expect(leftPause).toHaveAttribute("data-paused", "true");
  await expect(toolbarPause).toHaveAttribute("data-paused", "true");
  await page.screenshot({ path: join(SHOTS, "02-node-paused.png"), fullPage: false });

  // Resume from the floating toolbar — the left bar follows.
  await toolbarPause.click();
  await expect(leftPause).toHaveAttribute("data-paused", "false");
  await expect(toolbarPause).toHaveAttribute("data-paused", "false");

  // Task sink: left gains open-detail, middle gains board + add-task keys.
  await page.locator(".react-flow__node", { hasText: "tasks" }).first().click();
  await expect(page.locator(".rts-panel--cmd .rts-panel__label")).toContainText("sink");
  await expect(
    page.locator(".rts-panel--cmd").getByRole("button", { name: "Open detail" }),
  ).toBeVisible();
  await expect(kindStrip.getByRole("button", { name: "Open task board" })).toBeVisible();
  await expect(kindStrip.getByRole("button", { name: "Add task" })).toBeVisible();
  const taskToolbarEnqueue = page.getByTestId("node-toolbar-task-enqueue");
  await expect(taskToolbarEnqueue).toBeVisible();
  await taskToolbarEnqueue.click();
  const quickEnqueue = page.getByTestId("task-enqueue-surface");
  await expect(quickEnqueue).toBeVisible();
  await quickEnqueue.getByRole("button", { name: "Close task enqueue" }).click();
  await expect(quickEnqueue).toBeHidden();
  await page.screenshot({ path: join(SHOTS, "03-task-sink.png"), fullPage: false });

  // Add-task pop: submits through the work service; the sink card shows it.
  await kindStrip.getByRole("button", { name: "Add task" }).click();
  const brief = page.getByLabel("New task brief");
  await expect(brief).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "03b-add-task-pop.png"), fullPage: false });
  await brief.fill("wire the loop");
  await brief.press("Enter");
  await expect(brief).not.toBeVisible();
  await expect(
    page.locator(".react-flow__node", { hasText: "wire the loop" }).first(),
  ).toBeVisible();

  // Assign region to slot 1 (⌘/Ctrl+1), then pause via command card.
  await page.locator(".react-flow__node", { hasText: "ops" }).first().click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+1" : "Control+1");
  const regionChip = regionStrip.locator(".rts-chip--strip").first();
  await expect(regionChip).toBeVisible();
  await expect(regionChip).toContainText("ops");
  await regionChip.click();
  const regionPause = page.getByTestId("rts-pause-region");
  await expect(regionPause).toBeVisible();
  await expect(regionPause).toHaveAttribute("data-paused", "false");
  await regionPause.click();
  await expect(regionPause).toHaveAttribute("data-paused", "true");
  await expect(regionChip).toHaveAttribute("data-severity", "paused");
  await page.screenshot({ path: join(SHOTS, "04-region-paused.png"), fullPage: false });
  await regionPause.click();
  await expect(regionPause).toHaveAttribute("data-paused", "false");

  // Any node: assign the tasks sink to slot 2.
  await page.locator(".react-flow__node", { hasText: "tasks" }).first().click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+2" : "Control+2");
  const tasksChip = regionStrip.locator('.rts-chip--strip[data-node-id="tasks"]');
  await expect(tasksChip).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "05-tasks-slotted.png"), fullPage: false });
});
