/**
 * RTS two-bar controls e2e.
 *
 * The operator's ruling: left bar = type/base node actions per physics role
 * (pause, flags, region arm/pulse); middle bar = the selected node's
 * kind-specific actions (agent chat, herdr terminal, task board, …) above the
 * always-on region hotbar. Node/region pause toggles live here too.
 *
 * Boards install at runtime via window.vellum (authority-only boot); pattern
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
            readonly vellum?: { readonly listCanvases: () => Promise<unknown[]> };
          };
          return Boolean(runtime.vellum?.listCanvases);
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  return page.evaluate(async (document) => {
    const api = (
      globalThis as unknown as {
        readonly vellum: {
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
    ).vellum;
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

test("rts two-bar controls: role actions left, kind actions middle, pause everywhere", async ({
  vellum,
}) => {
  const { page } = vellum;
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

  // Middle bar: agent kind strip above the region hotbar.
  // ACP chat is hard-hidden (LEGACY_SURFACES_HIDDEN) — strip still labels the kind.
  const kindStrip = page.locator(".rts-kind-strip");
  await expect(kindStrip).toBeVisible();
  await expect(kindStrip).toContainText("agent");
  await expect(kindStrip.getByRole("button", { name: "Open chat" })).toHaveCount(0);

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

  // Region hotbar: the ops chip carries a pause dot; clicking pauses the region.
  const regionDot = page.locator(".rts-chip__pause").first();
  await expect(regionDot).toBeVisible();
  await expect(regionDot).toHaveAttribute("data-paused", "false");
  await regionDot.click();
  await expect(regionDot).toHaveAttribute("data-paused", "true");
  await page.screenshot({ path: join(SHOTS, "04-region-paused.png"), fullPage: false });
  await regionDot.click();
  await expect(regionDot).toHaveAttribute("data-paused", "false");
});
