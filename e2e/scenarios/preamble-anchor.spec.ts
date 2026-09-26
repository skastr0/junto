/**
 * Preamble anchor: a seat's bubble stays on its ring whatever is selected.
 *
 * Three seats in a region and one outside it, each wearing a staged preamble.
 * The bubble's offset from its seat's ring is measured with nothing selected,
 * then held to that under a selected region, a shift multi-selection and a
 * rubber-band selection. Only a single selected seat, whose toolbar rises
 * above it, may lift its bubble, and then just clear of the toolbar. Frames
 * land in test-results/preamble-anchor/ (or PREAMBLE_SHOTS), both themes.
 */
import { mkdir } from "node:fs/promises";
import type { Page } from "@playwright/test";
import type { GroupNode } from "../../src/shared/canvas";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = process.env.PREAMBLE_SHOTS ?? "test-results/preamble-anchor";
const CANVAS = "preamble-anchor";

const region: GroupNode = {
  id: "region",
  type: "group",
  label: "build orbit",
  x: 0,
  y: 0,
  width: 980,
  height: 360,
  ether: { region: { hold: true } },
};
const seatIds = ["planner", "builder", "reviewer", "scout"] as const;
const seats = seatIds.map((id, index) =>
  agentTextNode({
    id,
    key: `local:e2e-anchor-${id}`,
    label: id,
    harness: "claude",
    x: index < 3 ? 60 + index * 320 : 1120,
    y: 200,
  }),
);
const doc = canvasDoc([region, ...seats]);

type Anchor = { readonly gap: number; readonly dx: number };

/** Each seat's bubble offset from its ring: vertical gap and horizontal shift. */
const anchors = (page: Page) =>
  page.evaluate((ids) => {
    const out: Record<string, Anchor> = {};
    for (const id of ids) {
      const ring = document.querySelector(`.react-flow__node[data-id="${id}"] .junto-mark[data-mark-size="seat"]`);
      const card = document.querySelector(`[data-testid="node-preamble"][data-node-id="${id}"] .junto-preamble__card`);
      if (!ring || !card) continue;
      const r = ring.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      out[id] = { gap: Math.round(r.top - c.bottom), dx: Math.round(c.left - r.left) };
    }
    return out;
  }, seatIds);

const toolbarTop = (page: Page) =>
  page.evaluate(() => {
    const bar = document.querySelector(".react-flow__node-toolbar");
    return bar ? bar.getBoundingClientRect().top : undefined;
  });

const stage = async (junto: Awaited<ReturnType<typeof launchJunto>>) => {
  const now = Date.now();
  const staged = [
    { nodeId: "planner", text: "splitting the migration into two steps" },
    { nodeId: "builder", text: "blocked: needs the prod DB password", action: "signal", tone: "crimson" },
    { nodeId: "reviewer", text: "done", provenance: "system", action: "state", tone: "green" },
    { nodeId: "scout", text: "thread looks healthy again", provenance: "ai", action: "health", tone: "green" },
  ].map((fields, i) => ({
    preambleId: `anchor-${String(i)}`,
    canvasName: CANVAS,
    expiresAt: now + 120_000,
    provenance: "agent",
    ...fields,
  }));
  await junto.app.evaluate(({ BrowserWindow }, events) => {
    for (const window of BrowserWindow.getAllWindows()) {
      for (const event of events) window.webContents.send("junto:preamble", event);
    }
  }, staged);
  await expect(junto.page.getByTestId("node-preamble")).toHaveCount(staged.length, { timeout: 10_000 });
};

const setTheme = async (page: Page, mode: "dark" | "bright") => {
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
  const choice = page
    .getByRole("radiogroup", { name: "Theme", exact: true })
    .getByRole("radio", { name: mode === "bright" ? "Bright" : "Dark", exact: true });
  await choice.click();
  await expect(choice).toHaveAttribute("aria-checked", "true");
  await page.locator(".settings-panel__close").click();
};

const clearSelection = async (page: Page) => {
  await page.keyboard.press("Escape");
  await page.locator(".react-flow__pane").click({ position: { x: 8, y: 8 } });
  await page.waitForTimeout(250);
};

/** The seat's name line: clear of the bubble and of the ring's own buttons. */
const seatBody = (page: Page, id: string) =>
  page.locator(`.react-flow__node[data-id="${id}"] [data-testid="agent-seat-line"]`);

test("preamble bubbles stay on their rings under every selection", async () => {
  test.setTimeout(180_000);
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: doc } });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.react-flow__node[data-id="scout"]')).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /fit all/i }).first().click();
    await page.waitForTimeout(500);

    for (const mode of ["dark", "bright"] as const) {
      await setTheme(page, mode);
      await clearSelection(page);
      await stage(junto);
      await page.waitForTimeout(400);
      const rest = await anchors(page);
      expect(Object.keys(rest)).toHaveLength(seatIds.length);
      await page.screenshot({ path: `${SHOTS}/${mode}-1-rest.png` });

      // A selected region: its seats are not selected and keep their bubbles.
      await page.locator('[data-testid="rf__node-region"] .region-drag-handle').click();
      await expect(page.locator('.react-flow__node[data-id="region"]')).toHaveClass(/selected/);
      await page.waitForTimeout(300);
      expect(await anchors(page)).toEqual(rest);
      await page.screenshot({ path: `${SHOTS}/${mode}-2-region-selected.png` });
      await clearSelection(page);

      // Shift multi-selection: no toolbar, so nothing to rise over.
      await seatBody(page, "planner").click();
      await seatBody(page, "builder").click({ modifiers: ["Shift"] });
      await seatBody(page, "scout").click({ modifiers: ["Shift"] });
      await expect(page.locator(".react-flow__node.selected")).toHaveCount(3);
      await page.waitForTimeout(300);
      expect(await anchors(page)).toEqual(rest);
      await page.screenshot({ path: `${SHOTS}/${mode}-3-multi-selected.png` });
      await clearSelection(page);

      // Rubber band from the open pane across the region and its seats.
      await page.getByRole("button", { name: /fit all/i }).first().click();
      await page.waitForTimeout(500);
      const box = (await page.locator('[data-testid="rf__node-region"]').boundingBox())!;
      await page.mouse.move(box.x - 24, box.y + box.height + 24);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 8 });
      await page.mouse.move(box.x + box.width + 24, box.y - 24, { steps: 8 });
      await page.mouse.up();
      await expect.poll(async () => page.locator(".react-flow__node.selected").count()).toBeGreaterThan(1);
      await page.waitForTimeout(300);
      expect(await anchors(page)).toEqual(rest);
      await page.screenshot({ path: `${SHOTS}/${mode}-4-marquee-selected.png` });
      await clearSelection(page);

      // One selected seat wears its toolbar: the bubble lifts just clear of it,
      // still on the ring's line; its neighbours do not move.
      await seatBody(page, "builder").click();
      await expect.poll(() => toolbarTop(page)).not.toBeUndefined();
      const top = await toolbarTop(page);
      await page.waitForTimeout(300);
      const single = await anchors(page);
      expect(single.planner).toEqual(rest.planner);
      expect(single.reviewer).toEqual(rest.reviewer);
      expect(single.builder!.dx).toBe(rest.builder!.dx);
      const cardBottom = await page
        .locator('[data-testid="node-preamble"][data-node-id="builder"] .junto-preamble__card')
        .evaluate((el) => el.getBoundingClientRect().bottom);
      expect(cardBottom).toBeLessThanOrEqual(top! - 2);
      expect(top! - cardBottom).toBeLessThan(24);
      await page.screenshot({ path: `${SHOTS}/${mode}-5-single-selected.png` });
      await clearSelection(page);
    }
  } finally {
    await junto.close();
  }
});
