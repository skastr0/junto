/**
 * Multi-select → RTS chrome glue.
 *
 * Units cover classify / bulk color / multi-prompt fan-out. This only asserts
 * Shift-add selection surfaces the multi command card + multi-prompt input.
 * Run: `bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/multi-select-rts.spec.ts`
 */
import { agentTextNode, canvasDoc, tasksNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const fixtureDoc = canvasDoc([
  tasksNode({ id: "tasks", x: 40, y: 40 }),
  agentTextNode({
    id: "seat-a",
    key: "local:alpha",
    label: "alpha",
    x: 320,
    y: 40,
  }),
  agentTextNode({
    id: "seat-b",
    key: "local:beta",
    label: "beta",
    x: 560,
    y: 40,
  }),
  {
    id: "rg-main",
    type: "group",
    label: "main",
    x: 280,
    y: 0,
    width: 560,
    height: 200,
    ether: { region: { hold: true } },
  },
]);

const stableBox = async (page: import("@playwright/test").Page, locator: import("@playwright/test").Locator) => {
  let previous: { x: number; y: number; width: number; height: number } | undefined;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const box = await locator.boundingBox();
    if (
      box !== null &&
      previous !== undefined &&
      Math.abs(box.x - previous.x) < 0.5 &&
      Math.abs(box.y - previous.y) < 0.5
    ) {
      return box;
    }
    previous = box ?? undefined;
    await page.waitForTimeout(250);
  }
  return previous;
};

const installBoard = async (page: import("@playwright/test").Page): Promise<void> => {
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
  await page.evaluate(async (document) => {
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
      const created = await api.createCanvas("multi");
      name = created.name;
    }
    const read = await api.readCanvas(name);
    await api.writeCanvas(name, document, read.revision);
  }, fixtureDoc);
};

test("multi-select: RTS multi command + multi-prompt", async ({ vellumCommand }) => {
  const { page } = vellumCommand;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await installBoard(page);

  const alpha = page.locator(".react-flow__node", { hasText: "alpha" }).first();
  const beta = page.locator(".react-flow__node", { hasText: "beta" }).first();
  const tasks = page.locator(".react-flow__node", { hasText: "tasks" }).first();
  await expect(alpha).toBeVisible({ timeout: 30_000 });
  await expect(beta).toBeVisible({ timeout: 30_000 });
  await expect(tasks).toBeVisible({ timeout: 30_000 });

    // Shift+click is product law for additive multi-select (dominance handler
  // at window capture, so React Flow's pane marquee never sees the event).
  const shiftClick = async (locator: import("@playwright/test").Locator) => {
    await locator.click({ modifiers: ["Shift"] });
  };
  await shiftClick(alpha);
  await shiftClick(beta);
  await expect(alpha).toHaveClass(/selected/);
  await expect(beta).toHaveClass(/selected/);
  await expect(tasks).not.toHaveClass(/selected/);

  const multiCmd = page.getByTestId("rts-multi-command");
  await expect(multiCmd).toBeVisible();
  await expect(multiCmd.locator(".rts-cmd__title")).toContainText("shared settings");
  await expect(multiCmd.locator(".rts-cmd__live")).toContainText("2 - agents");

  const multiPrompt = page.getByTestId("rts-multi-prompt");
  await expect(multiPrompt).toBeVisible();
  await expect(
    multiPrompt.getByRole("textbox", { name: "Prompt all selected agents" }),
  ).toBeVisible();

  // Mixed selection drops kind multi-prompt, keeps generic multi command.
  await shiftClick(tasks);
  await expect(page.getByTestId("rts-multi-command")).toBeVisible();
  await expect(page.getByTestId("rts-multi-prompt")).toHaveCount(0);
  await expect(page.locator(".rts-kind-surface .rts-quiet")).toContainText("mixed");
});

test("rubber-band marquee selects inside a region's interior", async ({ vellumCommand }) => {
  // Regions are inert background: the plate and wrapper are pointer-
  // transparent, so a drag that starts inside a region must rubber-band
  // select the contained nodes instead of moving the region.
  const { page } = vellumCommand;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await installBoard(page);

  const region = page.locator('.react-flow__node[data-id="rg-main"]');
  const alpha = page.locator(".react-flow__node", { hasText: "alpha" }).first();
  const beta = page.locator(".react-flow__node", { hasText: "beta" }).first();
  await expect(region).toBeVisible({ timeout: 30_000 });
  await expect(alpha).toBeVisible();
  await expect(beta).toBeVisible();

  // Drag from the region's top-left interior to its bottom-right — the
  // marquee must select the two agent seats inside it.
  const regionBox = await stableBox(page, region);
  expect(regionBox).not.toBeNull();
  if (!regionBox) return;
  await page.mouse.move(regionBox.x + 12, regionBox.y + 40);
  await page.mouse.down();
  await page.waitForTimeout(200);
  await page.mouse.move(regionBox.x + regionBox.width - 12, regionBox.y + regionBox.height - 12, {
    steps: 12,
  });
  await page.waitForTimeout(200);
  await page.mouse.up();

  await expect(alpha).toHaveClass(/selected/);
  await expect(beta).toHaveClass(/selected/);
  await expect(page.getByTestId("rts-multi-command")).toBeVisible();

  // The region itself moves only through its label handle: dragging the
  // interior never changes its position.
  const after = await region.boundingBox();
  expect(after).not.toBeNull();
  if (after && regionBox) {
    expect(Math.abs(after.x - regionBox.x)).toBeLessThan(0.5);
    expect(Math.abs(after.y - regionBox.y)).toBeLessThan(0.5);
  }
});
