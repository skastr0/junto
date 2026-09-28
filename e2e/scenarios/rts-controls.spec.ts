/**
 * RTS shell controls e2e.
 *
 * Layout: region strip (1–9) above the whole bar; left = type/base actions
 * per physics role; middle = kind actions (agent chat, terminal, …);
 * right = minimap. Pause is canvas-wide only (top bar): no node
 * or region pause key anywhere.
 *
 * Boards install at runtime via window.junto (authority-only boot); pattern
 * copied from pause-surface.spec.ts.
 * Run: `bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/rts-controls.spec.ts`
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "rts-controls");

const fixtureDoc = canvasDoc([
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
            readonly junto?: { readonly listCanvases: () => Promise<unknown[]> };
          };
          return Boolean(runtime.junto?.listCanvases);
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  return page.evaluate(async (document) => {
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
  junto,
}) => {
  const { page } = junto;
  await mkdir(SHOTS, { recursive: true });

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await installBoard(page);
  const seat = page.locator(".react-flow__node", { hasText: "worker" }).first();
  await expect(seat).toBeVisible({ timeout: 30_000 });

  // Select the actor seat.
  await seat.click();

  // Left bar: command card, no node pause (pause is canvas-wide only); the
  // kind label ("agent") lives in the middle kind strip.
  await expect(page.locator(".rts-panel--cmd")).toBeVisible();
  await expect(page.getByTestId("rts-pause-node")).toHaveCount(0);
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

  // Command groups in the top bar: nine hotkey slots, with busy seats placed
  // automatically and fixed assignments owned by the operator.
  const regionStrip = page.getByRole("toolbar", { name: "Command groups" });
  await expect(regionStrip).toBeVisible();
  await expect(regionStrip.locator('[data-testid^="hotbar-slot-"]')).toHaveCount(9);

  // Floating node toolbar: no pause, no flag; Stop names the process.
  await expect(page.getByTestId("node-toolbar-pause")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Flag blocker" })).toHaveCount(0);

  await page.screenshot({ path: join(SHOTS, "01-actor-selected.png"), fullPage: false });

  // An operator-owned slot: the selected seat goes to slot 2 (⌘/Ctrl+2).
  await page.locator('.react-flow__node[data-id="seat"]').click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+2" : "Control+2");
  const seatChip = regionStrip.locator('.group-chip[data-node-id="seat"]');
  await expect(seatChip).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "05-seat-slotted.png"), fullPage: false });

  // Reframe to the readable field (region-centered), then assign region to
  // slot 1 (⌘/Ctrl+1); its command card carries no pause. Region interiors are inert
  // background (rubber-band surface), so select the region through its label
  // drag handle — the only movable chrome.
  await page.getByRole("button", { name: "Fit readable view" }).click();
  await page.locator(".region-drag-handle", { hasText: "ops" }).first().click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+1" : "Control+1");
  const regionChip = regionStrip.locator('[data-testid="hotbar-slot-1"]');
  await expect(regionChip).toBeVisible();
  await expect(regionChip).toContainText("ops");
  await regionChip.click();
  await expect(page.getByTestId("rts-pause-region")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pause region" })).toHaveCount(0);
  await page.screenshot({ path: join(SHOTS, "04-region-selected.png"), fullPage: false });
});
