/**
 * Sheet scale + canvas isolation. Seeds the 500-row / 8-column ceiling, opens
 * the editor, types, scrolls, and pan/zooms the canvas underneath. Virtualization
 * must keep mounted inputs well below the full grid, and the canvas must still
 * pan after close.
 *
 * Playwright recordVideo wedges Electron boot on this launch path — CDP
 * screencast after boot is the proven capture (see demo-growth-capture).
 *
 * Run: `bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/sheet-scale.spec.ts`
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CanvasNode } from "../../src/shared/canvas";
import { SHEET_MAX_ROWS } from "../../src/shared/sheet";
import { agentTextNode, canvasDoc, verbEdge } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const SHOTS = process.env.JUNTO_SHEET_SHOTS ?? join(process.cwd(), ".amp/in/artifacts");
const COLUMNS = 8;
const ROWS = SHEET_MAX_ROWS;
const FRAME = { width: 1600, height: 1000 };

const columns = Array.from({ length: COLUMNS }, (_, i) => ({
  id: `c${i + 1}`,
  name: i === 0 ? "Host" : i === 1 ? "Cost" : `Col ${i + 1}`,
}));

const rows = Array.from({ length: ROWS }, (_, i) => ({
  id: `r${i + 1}`,
  cells: {
    c1: `host-${String(i + 1).padStart(3, "0")}`,
    c2: String((i + 1) * 17),
  },
}));

const sheetNode: CanvasNode = {
  id: "sheet1",
  type: "text",
  text: "fleet ledger",
  x: 80,
  y: 80,
  width: 280,
  height: 140,
  ether: {
    entity: { kind: "sheet" },
    sheet: { columns, rows },
  },
};

const neighbour = agentTextNode({
  id: "agent1",
  key: "local:sheet-scale",
  label: "ledger reader",
  x: 460,
  y: 80,
});

const note: CanvasNode = {
  id: "note1",
  type: "text",
  text: "keep the canvas alive",
  x: 80,
  y: 280,
  width: 220,
  height: 84,
};

test.use({
  vellumOptions: {
    extraEnv: { JUNTO_E2E_SHOW: "1" },
    seedCanvases: {
      sheets: canvasDoc(
        [sheetNode, neighbour, note],
        [verbEdge("e-read", "agent1", "sheet1", "reads", [sheetNode, neighbour, note])],
      ),
    },
  },
});

test("a 500-row sheet stays virtualized, editable, and leaves the canvas intact", async ({
  vellumCommand,
}) => {
  test.setTimeout(180_000);
  const { app, page } = vellumCommand;
  mkdirSync(SHOTS, { recursive: true });
  const framesDir = join(SHOTS, "sheet-scale-frames");
  mkdirSync(framesDir, { recursive: true });

  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.setSize(size.width, size.height);
      win.center();
      win.show();
      win.focus();
    }
  }, FRAME);

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  const card = page.locator('.react-flow__node[data-id="sheet1"]');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("500 rows, 8 columns");
  await expect(card).toContainText("host-001");
  await expect(page.locator('[data-testid^="rf__node-"]')).toHaveCount(3);

  const cdp = await app.context().newCDPSession(page);
  const frames: string[] = [];
  cdp.on(
    "Page.screencastFrame",
    (f: { data: string; sessionId: number }) => {
      const file = `f${String(frames.length).padStart(4, "0")}.jpg`;
      writeFileSync(join(framesDir, file), Buffer.from(f.data, "base64"));
      frames.push(file);
      void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
    },
  );
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 80,
    maxWidth: FRAME.width,
    maxHeight: FRAME.height,
    everyNthFrame: 1,
  });

  await card.dblclick();
  const detail = page.getByTestId("sheet-detail");
  await expect(detail).toBeVisible({ timeout: 15_000 });
  await expect(detail).toContainText("500 × 8");

  const grid = page.getByTestId("sheet-grid");
  await expect(grid).toBeVisible();
  const firstCell = detail.getByRole("textbox", { name: "Host row 1", exact: true });
  await expect(firstCell).toBeVisible({ timeout: 10_000 });

  const mountedBefore = await grid.locator("tbody tr:not(.vellum-sheet__spacer)").count();
  expect(mountedBefore, `mounted rows at top=${mountedBefore}`).toBeLessThan(80);
  expect(mountedBefore).toBeGreaterThan(5);

  const typeT0 = Date.now();
  await firstCell.click();
  await firstCell.fill("mac-studio-01");
  const typeMs = Date.now() - typeT0;
  expect(typeMs, `fill wall ms=${typeMs}`).toBeLessThan(2_000);
  await expect(firstCell).toHaveValue("mac-studio-01");

  await grid.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect
    .poll(async () => Number(await grid.getAttribute("data-row-end")), { timeout: 10_000 })
    .toBe(ROWS);
  const lastCell = detail.getByRole("textbox", { name: `Host row ${String(ROWS)}`, exact: true });
  await expect(lastCell).toBeVisible({ timeout: 10_000 });
  await lastCell.fill("host-500-edited");
  const mountedBottom = await grid.locator("tbody tr:not(.vellum-sheet__spacer)").count();
  expect(mountedBottom, `mounted rows at bottom=${mountedBottom}`).toBeLessThan(80);
  await expect(lastCell).toHaveValue("host-500-edited");

  await grid.evaluate((el) => {
    el.scrollTop = Math.floor(el.scrollHeight / 2);
  });
  await expect
    .poll(async () => Number(await grid.getAttribute("data-row-start")), { timeout: 10_000 })
    .toBeGreaterThan(50);
  const midTyped = await grid.evaluate((el) => {
    const input = el.querySelector("tbody tr:not(.vellum-sheet__spacer) input");
    if (!(input instanceof HTMLInputElement)) return "";
    input.focus();
    input.value = "mid-host";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input.getAttribute("aria-label") ?? "";
  });
  expect(midTyped).toMatch(/Host row \d+/);

  await page.waitForTimeout(200);
  await detail.getByRole("button", { name: "Close sheet" }).click();
  await expect(detail).toHaveCount(0);
  await expect(card).toContainText("500 rows, 8 columns");
  await expect(card).toContainText("mac-studio-01");

  const readSheet = async () =>
    page.evaluate(async () => {
      const api = (
        globalThis as unknown as {
          readonly vellumCommand: {
            readonly readCanvas: (name: string) => Promise<{ doc: { nodes: unknown[] } }>;
          };
        }
      ).vellumCommand;
      const read = await api.readCanvas("sheets");
      const node = read.doc.nodes.find(
        (candidate) => (candidate as { id?: string }).id === "sheet1",
      ) as {
        ether?: {
          sheet?: { columns: unknown[]; rows: { cells: Record<string, string> }[] };
        };
      };
      return node.ether?.sheet;
    });
  await expect
    .poll(async () => (await readSheet())?.rows[0]?.cells.c1, { timeout: 10_000 })
    .toBe("mac-studio-01");
  const stored = await readSheet();
  expect(stored?.columns).toHaveLength(COLUMNS);
  expect(stored?.rows).toHaveLength(ROWS);
  expect(stored?.rows[ROWS - 1]?.cells.c1).toBe("host-500-edited");

  const pane = page.locator(".react-flow__pane");
  const agent = page.locator('.react-flow__node[data-id="agent1"]');
  await expect(agent).toBeVisible();
  const before = await agent.boundingBox();
  expect(before).toBeTruthy();
  if (before) {
    const box = await pane.boundingBox();
    expect(box).toBeTruthy();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 240);
      await page.waitForTimeout(200);
    }
    const after = await agent.boundingBox();
    expect(after).toBeTruthy();
    if (after) {
      expect(
        Math.abs((after.x ?? 0) - (before.x ?? 0)) + Math.abs((after.y ?? 0) - (before.y ?? 0)),
      ).toBeGreaterThan(8);
    }
  }
  await expect(page.locator(".react-flow")).toBeVisible();
  await expect(page.locator('[data-testid^="rf__node-"]')).toHaveCount(3);
  await expect(page.locator('.react-flow__node[data-id="sheet1"]')).toBeVisible();
  await page.waitForTimeout(800);

  await cdp.send("Page.stopScreencast").catch(() => undefined);
  expect(frames.length, `screencast frames=${frames.length}`).toBeGreaterThan(8);

  const video = join(SHOTS, "sheet-scale.webm");
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-framerate",
      "12",
      "-i",
      join(framesDir, "f%04d.jpg"),
      "-c:v",
      "libvpx-vp9",
      "-pix_fmt",
      "yuv420p",
      "-b:v",
      "1M",
      video,
    ],
    { stdio: "pipe" },
  );
  console.log(`SHEET-SCALE frames=${frames.length} video=${video} typeMs=${typeMs}`);
});
