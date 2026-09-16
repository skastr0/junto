/**
 * Region window-frame grab.
 *
 * A region is map furniture, not a card: its plate and React Flow wrapper stay
 * pointer-transparent so the interior is pane. The perimeter strips and the
 * full-width title bar are the only chrome that selects and moves it.
 *
 * Run: `bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/region-frame-grab.spec.ts`
 */
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const fixtureDoc = canvasDoc([
  agentTextNode({ id: "seat-a", key: "local:alpha", label: "alpha", x: 320, y: 60 }),
  agentTextNode({ id: "seat-b", key: "local:beta", label: "beta", x: 600, y: 60 }),
  {
    id: "rg-main",
    type: "group",
    label: "main",
    x: 280,
    y: 0,
    width: 600,
    height: 260,
  },
]);

const stableBox = async (
  page: import("@playwright/test").Page,
  locator: import("@playwright/test").Locator,
) => {
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
            readonly junto?: { readonly listCanvases: () => Promise<unknown[]> };
          };
          return Boolean(runtime.junto?.listCanvases);
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  await page.evaluate(async (document) => {
    const api = (
      globalThis as unknown as {
        readonly junto: {
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
    ).junto;
    const list = await api.listCanvases();
    const name = list[0]?.name ?? (await api.createCanvas("frame")).name;
    const read = await api.readCanvas(name);
    await api.writeCanvas(name, document, read.revision);
  }, fixtureDoc);
};

test("clicking the frame selects the region, dragging it moves the region", async ({
  junto,
}) => {
  const { page } = junto;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await installBoard(page);

  const region = page.locator('.react-flow__node[data-id="rg-main"]');
  const alpha = page.locator(".react-flow__node", { hasText: "alpha" }).first();
  await expect(region).toBeVisible({ timeout: 30_000 });
  await expect(alpha).toBeVisible();

  // A card is selected first: the non-Shift frame click must be exclusive.
  await alpha.click();
  await expect(alpha).toHaveClass(/selected/);

  // Click the frame itself (left strip, well below the title bar) — not the name.
  const strip = page.getByTestId("region-frame-left");
  const stripBox = await stableBox(page, strip);
  expect(stripBox).not.toBeNull();
  if (!stripBox) return;
  await page.mouse.move(stripBox.x + stripBox.width / 2, stripBox.y + stripBox.height / 2);
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/region-frame-grab/frame-hover.png" });
  await page.mouse.click(
    stripBox.x + stripBox.width / 2,
    stripBox.y + stripBox.height / 2,
  );
  await expect(region).toHaveClass(/selected/);
  await expect(alpha).not.toHaveClass(/selected/);
  // Selected: the strips step aside so NodeResizer owns the edges.
  await expect(strip).toHaveCount(0);

  await page.screenshot({ path: "test-results/region-frame-grab/selected.png" });

  // The title bar still moves a selected region.
  const before = await stableBox(page, region);
  expect(before).not.toBeNull();
  if (!before) return;
  const alphaBefore = await alpha.boundingBox();
  const barBox = await stableBox(page, page.getByTestId("region-titlebar"));
  expect(barBox).not.toBeNull();
  if (!barBox) return;
  const grabX = barBox.x + barBox.width / 2;
  const grabY = barBox.y + barBox.height / 2;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX + 120, grabY + 60, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const after = await stableBox(page, region);
  expect(after).not.toBeNull();
  if (!after || !alphaBefore) return;
  expect(after.x - before.x).toBeGreaterThan(60);
  expect(after.y - before.y).toBeGreaterThan(20);

  // No hold on this region: members stay where they were.
  const alphaAfter = await alpha.boundingBox();
  expect(alphaAfter).not.toBeNull();
  if (!alphaAfter) return;
  expect(Math.abs(alphaAfter.x - alphaBefore.x)).toBeLessThan(1);
});

test("frame grab works before selection and leaves the interior as pane", async ({
  junto,
}) => {
  const { page } = junto;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await installBoard(page);

  const region = page.locator('.react-flow__node[data-id="rg-main"]');
  await expect(region).toBeVisible({ timeout: 30_000 });
  const box = await stableBox(page, region);
  expect(box).not.toBeNull();
  if (!box) return;

  // Unselected region: drag the bottom strip — it must move without a prior click.
  const bottom = await stableBox(page, page.getByTestId("region-frame-bottom"));
  expect(bottom).not.toBeNull();
  if (!bottom) return;
  const grabX = bottom.x + bottom.width / 2;
  const grabY = bottom.y + bottom.height / 2;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX - 90, grabY + 40, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const moved = await stableBox(page, region);
  expect(moved).not.toBeNull();
  if (!moved) return;
  expect(box.x - moved.x).toBeGreaterThan(40);

  // Interior is still pane: a drag that starts inside must not move the region.
  // Start past the title bar and the left strip (the node box carries React
  // Flow's own 10px group padding, so the plate begins inset).
  const held = await stableBox(page, region);
  if (!held) return;
  await page.mouse.move(held.x + 60, held.y + 70);
  await page.mouse.down();
  await page.mouse.move(held.x + held.width - 60, held.y + held.height - 60, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  const settled = await stableBox(page, region);
  expect(settled).not.toBeNull();
  if (!settled) return;
  expect(Math.abs(settled.x - held.x)).toBeLessThan(1);
  expect(Math.abs(settled.y - held.y)).toBeLessThan(1);
});
