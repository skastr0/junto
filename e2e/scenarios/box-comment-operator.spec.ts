/**
 * B7: the operator draws a box on a page, sees main's shot in the composer,
 * and posts exactly it; the page box comment row carries that shot and the
 * address without its query. POST /comment refuses a caller with no seat lease.
 *
 * The page's view and the drawing overlay are native views above the
 * window, so a screenshot of the renderer alone would show neither: shots
 * are each view's own capture laid over the window's at its bounds. Set
 * BOX_RUN_SHOTS to a folder to keep them.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { ElectronApplication } from "playwright-core";
import { browserPageNode } from "../harness/browser-automation-fixtures";
import { controlCall, readSandboxControlToken, sandboxControlSocketPath, waitForControlDoctor } from "../harness/browser-control-client";
import { launchJunto } from "../harness/launch";
import { modelFixture } from "../harness/model";

const SHOTS = process.env.BOX_RUN_SHOTS;
const PAGE_URL = "https://example.com/?from=box-run#top";

type Layer = { readonly x: number; readonly y: number; readonly png: string };

/** The window and each native view on it, captured where they sit. */
const layers = (app: ElectronApplication): Promise<ReadonlyArray<Layer>> =>
  app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())!;
    const out: Array<{ x: number; y: number; png: string }> = [{ x: 0, y: 0, png: (await win.webContents.capturePage()).toDataURL() }];
    for (const view of win.contentView.children) {
      const contents = (view as { webContents?: Electron.WebContents }).webContents;
      if (contents === undefined || contents === win.webContents || contents.isDestroyed()) continue;
      const bounds = view.getBounds();
      if (bounds.width === 0 || bounds.height === 0) continue;
      out.push({ x: bounds.x, y: bounds.y, png: (await contents.capturePage()).toDataURL() });
    }
    return out;
  });

const shot = async (app: ElectronApplication, page: Page, name: string): Promise<void> => {
  if (SHOTS === undefined) return;
  await page.waitForTimeout(400);
  const parts = await layers(app);
  const composed = await page.evaluate(async (all) => {
    const images = await Promise.all(all.map((part) => new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = part.png;
    })));
    const canvas = document.createElement("canvas");
    canvas.width = images[0]!.naturalWidth;
    canvas.height = images[0]!.naturalHeight;
    const scale = canvas.width / window.innerWidth;
    const context = canvas.getContext("2d")!;
    images.forEach((image, index) => context.drawImage(image, all[index]!.x * scale, all[index]!.y * scale));
    return canvas.toDataURL("image/png");
  }, parts);
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(composed.split(",")[1]!, "base64"));
};

/** Trusted mouse input on the drawing overlay, as the operator's hand gives it. */
const drag = (app: ElectronApplication, from: { x: number; y: number }, to: { x: number; y: number }, release: boolean) =>
  app.evaluate(async ({ webContents }, input) => {
    const overlay = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith("data:text/html"));
    if (overlay === undefined) throw new Error("no drawing overlay");
    const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
    overlay.sendInputEvent({ type: "mouseDown", x: input.from.x, y: input.from.y, button: "left", clickCount: 1 });
    for (let step = 1; step <= 8; step += 1) {
      await pause();
      overlay.sendInputEvent({
        type: "mouseMove",
        x: Math.round(input.from.x + ((input.to.x - input.from.x) * step) / 8),
        y: Math.round(input.from.y + ((input.to.y - input.from.y) * step) / 8),
        button: "left",
        modifiers: ["leftbuttondown"],
      });
    }
    if (input.release) overlay.sendInputEvent({ type: "mouseUp", x: input.to.x, y: input.to.y, button: "left", clickCount: 1 });
  }, { from, to, release });

test("the operator draws a box on a page, sees the shot, and posts exactly it", async () => {
  test.setTimeout(180_000);
  const nodes = [browserPageNode({ id: "p1", url: PAGE_URL, profile: "personal", x: 0, y: 0 })];
  const junto = await launchJunto({ seedModels: { "box-run": modelFixture(nodes, []) } });
  try {
    const { app, page, sandbox } = junto;
    const card = page.locator('.react-flow__node[data-id="p1"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.click();
    const area = page.locator('[data-testid="browser-comment-area"]');
    await expect(area).toBeVisible({ timeout: 30_000 });
    // The page itself has loaded in its view.
    await expect.poll(
      () => app.evaluate(({ webContents }) =>
        webContents.getAllWebContents().some((contents) => contents.getURL().startsWith("https://example.com/") && !contents.isLoading())),
      { timeout: 60_000 },
    ).toBe(true);
    await shot(app, page, "1-page-open");

    await area.click();
    await expect.poll(
      () => app.evaluate(({ webContents }) => webContents.getAllWebContents().some((contents) => contents.getURL().startsWith("data:text/html"))),
      { timeout: 10_000 },
    ).toBe(true);
    await page.waitForTimeout(300);
    await drag(app, { x: 40, y: 60 }, { x: 420, y: 200 }, false);
    await shot(app, page, "2-drawing");
    await drag(app, { x: 420, y: 200 }, { x: 420, y: 200 }, true);

    const composer = page.locator('[data-testid="box-comment-composer"]');
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await expect(composer.locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/u);
    await expect(composer).toContainText("https://example.com/");
    await expect(composer).not.toContainText("from=box-run");
    await shot(app, page, "3-composer");

    await composer.locator('textarea[aria-label="Comment"]').fill("This heading should name the product, not the domain.");
    await shot(app, page, "4-composer-written");
    await composer.getByRole("button", { name: "Post comment" }).click();
    await expect(composer).toHaveCount(0, { timeout: 20_000 });
    await shot(app, page, "5-posted");

    // The comment row on the page node names the shot and the address without its query.
    const db = join(sandbox.homeDir, ".junto", "state", "junto.db");
    const rows = execFileSync("sqlite3", ["-json", db, "SELECT message_id, metadata_json FROM work_messages WHERE node_id = 'p1'"], { encoding: "utf8" });
    const posted = (JSON.parse(rows || "[]") as Array<{ message_id: string; metadata_json: string }>).map((row) => JSON.parse(row.metadata_json));
    expect(posted).toHaveLength(1);
    expect(posted[0].threadSubject).toMatchObject({ kind: "page", nodeId: "p1", anchor: { kind: "box", url: "https://example.com/" } });
    expect(posted[0].threadSubject.anchor.shot).toMatchObject({ mediaType: "image/png" });

    // A caller with no seat lease is refused by the route (a seat posts only on its own grant).
    const socketPath = sandboxControlSocketPath(sandbox.homeDir);
    const token = await readSandboxControlToken(sandbox.homeDir);
    await waitForControlDoctor(socketPath, token);
    const seat = await controlCall(socketPath, token, "comment", { sessionId: "any", rect: { x: 0, y: 0, w: 40, h: 40 }, text: "x" });
    expect(seat.envelope.ok).toBe(false);
    if (SHOTS !== undefined) {
      writeFileSync(join(SHOTS, "6-seat-route.json"), `${JSON.stringify({ comment: posted[0].threadSubject, seatRoute: seat }, null, 2)}\n`);
    }
  } finally {
    await junto.close();
  }
});
