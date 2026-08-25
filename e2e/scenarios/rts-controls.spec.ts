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

  // Left bar: command card with the node pause toggle; the kind label
  // ("agent") lives in the middle kind strip now (no .rts-panel__label).
  const leftPause = page.getByTestId("rts-pause-node");
  await expect(leftPause).toBeVisible();
  await expect(leftPause).toHaveAttribute("data-paused", "false");
  await expect(page.locator(".rts-kind-kind-label")).toContainText("agent");

  // Middle bar: kind surface (identity + kind actions).
  // ACP chat is hard-hidden (LEGACY_SURFACES_HIDDEN) — strip still labels the kind.
  const kindSurface = page.locator(".rts-kind-surface");
  await expect(kindSurface).toBeVisible();
  const kindStrip = kindSurface.locator(".rts-kind-strip");
  await expect(kindStrip).toBeVisible();
  // Kind label lives beside the strip (span.rts-kind-kind-label), not inside it.
  await expect(kindSurface.locator(".rts-kind-kind-label")).toContainText("agent");
  await expect(kindStrip.getByRole("button", { name: "Open chat" })).toHaveCount(0);
  await expect(kindStrip.getByRole("button", { name: "Open fields" })).toHaveCount(0);
  await expect(kindStrip.getByRole("button", { name: "Rename" })).toHaveCount(1);
  await expect(page.locator(".rts-panel--cmd").getByRole("button", { name: "Edit" })).toHaveCount(0);

  await kindStrip.getByRole("button", { name: "Rename" }).click();
  const renameInput = page.getByRole("textbox", { name: "Rename agent node" });
  await expect(renameInput).toBeVisible();
  await renameInput.fill("renamed worker");
  await renameInput.press("Enter");
  await expect(renameInput).toBeHidden();
  await expect(page.locator(".react-flow__node", { hasText: "renamed worker" }).first()).toBeVisible();

  // Hotbar strip above command+kind — nine slots, with recent nodes leased
  // opportunistically and fixed assignments owned by the operator.
  const regionStrip = page.locator(".rts-region-strip");
  await expect(regionStrip).toBeVisible();
  await expect(regionStrip.locator('[data-testid^="hotbar-slot-"]')).toHaveCount(9);

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

  // Task sink: left gains open-detail, middle kind strip labels the sink
  // kind and gains board + add-task keys.
  await page.locator(".react-flow__node", { hasText: "tasks" }).first().click();
  await expect(page.locator(".rts-kind-kind-label")).toContainText("task");
  await expect(
    page.locator(".rts-panel--cmd").getByRole("button", { name: "Open detail" }),
  ).toBeVisible();
  await expect(kindStrip.getByRole("button", { name: "Open task board" })).toBeVisible();
  await expect(kindStrip.getByRole("button", { name: "Add task" })).toBeVisible();
  await expect(kindStrip.getByRole("button", { name: "Sink contract" })).toHaveCount(0);

  const admissionKey = kindStrip.getByRole("button", { name: "Admission" });
  const bakeKey = kindStrip.getByRole("button", { name: "Bake" });
  await expect(admissionKey).toHaveAttribute("data-vellum-tooltip", "Admission: auto");
  await expect(bakeKey).toHaveAttribute("data-vellum-tooltip", "Bake: none");

  await admissionKey.click();
  const admissionQuickSelect = page.getByLabel("Admission quick select");
  await expect(admissionQuickSelect).toBeVisible();
  await admissionQuickSelect.getByRole("button", { name: "Gated" }).click();
  await expect(admissionKey).toHaveAttribute(
    "data-vellum-tooltip",
    "Admission: operator gated",
  );

  await bakeKey.click();
  const bakeQuickSet = page.getByLabel("Bake quick set");
  await expect(bakeQuickSet).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "03-task-sink-bake-key.png"), fullPage: false });
  await bakeQuickSet.getByRole("button", { name: "1h" }).click();
  await expect(bakeKey).toHaveAttribute("data-vellum-tooltip", "Bake: 1h");
  // The install-time fit centers the region, so the tasks sink sits outside
  // the viewport and its floating toolbar (fixed-position) cannot be clicked.
  // Frame the selected node through the command card first.
  await page.locator(".rts-panel--cmd").getByRole("button", { name: "Focus" }).click();
  const taskToolbarEnqueue = page.getByTestId("node-toolbar-task-enqueue");
  await expect(taskToolbarEnqueue).toBeVisible();
  await taskToolbarEnqueue.click();
  const quickEnqueue = page.getByTestId("task-enqueue-surface");
  await expect(quickEnqueue).toBeVisible();
  await quickEnqueue.getByRole("button", { name: "Close task enqueue" }).click();
  await expect(quickEnqueue).toBeHidden();
  await page.screenshot({ path: join(SHOTS, "03-task-sink.png"), fullPage: false });

  // Add-task pop: submits through the work service; the sink card shows it.
  // The workbench enqueue stays open after create (form clears for the next).
  await kindStrip.getByRole("button", { name: "Add task" }).click();
  const pinnedEnqueue = page.getByTestId("task-enqueue-surface");
  await pinnedEnqueue.getByRole("button", { name: "Pin task enqueue" }).click();
  await expect(
    pinnedEnqueue.getByRole("button", { name: "Unpin task enqueue" }),
  ).toBeVisible();
  const brief = pinnedEnqueue.getByPlaceholder("What needs doing?");
  await expect(brief).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "03b-add-task-pop.png"), fullPage: false });
  await brief.fill("wire");

  // Work-plane projection updates must not blur or remount a pinned interactive
  // surface. Preserve both the active element and its in-progress draft.
  await page.evaluate(async () => {
    const api = window.vellumCommand!;
    const canvas = (await api.listCanvases())[0];
    if (!canvas) throw new Error("No canvas available for focus regression");
    const result = await api.workTaskCreate(
      canvas.name,
      "tasks",
      "Background pinned projection update",
      { details: "Background pinned projection update" },
    );
    if (!result.ok) throw new Error(result.message);
  });
  await expect(
    page
      .locator(".react-flow__node", { hasText: "Background pinned projection update" })
      .first(),
  ).toBeVisible();
  await expect(brief).toBeFocused();
  await expect(brief).toHaveValue("wire");

  await brief.fill("wire the loop");
  await pinnedEnqueue
    .getByPlaceholder(/Context, constraints/)
    .fill("wire the loop end to end");
  await brief.press("Enter");
  await expect(brief).toHaveValue("");
  await expect(
    page.locator(".react-flow__node", { hasText: "wire the loop" }).first(),
  ).toBeVisible();
  await pinnedEnqueue.getByRole("button", { name: "Close task enqueue" }).click();
  await expect(page.getByTestId("task-enqueue-surface")).toBeHidden();

  // The canvas is still framed on the tasks sink. The background projection
  // reload does not promise to retain selection, so make the hotkey target
  // explicit before assigning it to slot 2.
  await page.locator('.react-flow__node[data-id="tasks"]').click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+2" : "Control+2");
  const tasksChip = regionStrip.locator('.rts-chip--strip[data-node-id="tasks"]');
  await expect(tasksChip).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "05-tasks-slotted.png"), fullPage: false });

  // Reframe to the readable field (region-centered), then assign region to
  // slot 1 (⌘/Ctrl+1) and pause via command card. Region interiors are inert
  // background (rubber-band surface), so select the region through its label
  // drag handle — the only movable chrome.
  await page.getByRole("button", { name: "Fit readable view" }).click();
  await page.locator(".region-drag-handle", { hasText: "ops" }).first().click();
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
});
