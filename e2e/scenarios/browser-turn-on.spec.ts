/**
 * Browser turn-on, in the real app: a [fake-tui] seat edged to a page acts on
 * it through the real `junto browser` CLI on its own credential, the operator
 * takes the page over and is told seat code may still watch it, Reload clears
 * that, and the seat comments on a box once handed back. A paused canvas
 * refuses the seat's acts and keeps its reads.
 *
 * The page's view is a native view above the window, so shots lay each
 * view's own capture over the window's. Set BOX_RUN_SHOTS to keep them.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { ElectronApplication } from "playwright-core";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness, type CrewCliResult } from "../harness/crew-fixture";
import { launchJunto } from "../harness/launch";
import { modelFixture, modelNode, modelSeat, modelWire } from "../harness/model";

const SHOTS = process.env.BOX_RUN_SHOTS;
const CANVAS = "turn-on";
const PAGE_URL = "https://example.com/";
const REF = `junto://canvas/${CANVAS}?node=p1`;
const NOTICE = "A seat ran code on this page and may still see what you type here. Reload to stop it.";
const PAUSED = "This canvas is paused: a seat acts when the operator plays it.";

const shot = async (app: ElectronApplication, page: Page, name: string): Promise<void> => {
  if (SHOTS === undefined) return;
  await page.waitForTimeout(400);
  const parts = await app.evaluate(async ({ BrowserWindow }) => {
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

/** The CLI's JSON envelope, whatever it printed around it. */
const envelope = (result: CrewCliResult): { ok?: boolean; data?: Record<string, unknown>; error?: { message?: string } } => {
  const text = result.stdout.trim() || result.stderr.trim();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: { message: `${result.stdout}${result.stderr}` } };
  }
};

test("[fake-tui] a seat acts on its page, the operator takes over and is told, and the seat comments once handed back", async () => {
  test.setTimeout(300_000);
  const scout = modelSeat({ id: "scout", key: "local:turn-on-scout", label: "Scout", harness: "codex", cwd: "/tmp", x: 0, y: 0 });
  const pageNode = modelNode({ kind: "page", id: "p1", url: PAGE_URL, profile: "personal", onRemove: "kill-session", x: 360, y: 0, width: 240, height: 80, z: 0 });
  const nodes = [scout, pageNode];
  const junto = await launchJunto({
    seedModels: { [CANVAS]: modelFixture(nodes, [modelWire("w1", "scout", "p1", "navigates", nodes)]) },
    afterSeed: installCrewSeatHarness,
  });
  try {
    const { app, page, sandbox } = junto;
    const seat = crewSeat(sandbox, CANVAS, "scout");
    const browser = async (argv: ReadonlyArray<string>) => {
      const result = await seat.cli(["browser", ...argv]);
      return { result, envelope: envelope(result) };
    };
    const card = page.locator('.react-flow__node[data-id="p1"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    await crewOccupySeat(page, CANVAS, scout, seat);
    expect((await seat.op("onboard", {})).ok, "scout onboards").toBe(true);

    // The operator opens the page; the seat joins it and runs code in it.
    await card.dblclick();
    const chrome = page.locator('[data-testid="browser-chrome"]');
    await expect(chrome).toBeVisible({ timeout: 30_000 });
    await expect.poll(
      () => app.evaluate(({ webContents }, url) =>
        webContents.getAllWebContents().some((contents) =>
          contents.getURL().startsWith(url) && !contents.isLoading() && contents.getTitle() === "Example Domain"), PAGE_URL),
      { timeout: 60_000 },
    ).toBe(true);
    const opened = await browser(["open", REF]);
    expect(opened.envelope.ok, JSON.stringify(opened.result)).toBe(true);
    const sessionId = String(opened.envelope.data?.sessionId);
    const ran = await browser(["eval", sessionId, "document.title"]);
    expect(ran.envelope.ok, JSON.stringify(ran.result)).toBe(true);
    await shot(app, page, "1-seat-ran-code");

    // Taking over says seat code may still watch; Reload is the operator's and clears it.
    await chrome.getByRole("button", { name: "Take over" }).click();
    const notice = page.locator('[data-testid="browser-chrome-seat-code"]');
    await expect(notice).toContainText(NOTICE, { timeout: 10_000 });
    await shot(app, page, "2-takeover-notice");
    const held = await browser(["eval", sessionId, "1"]);
    expect(held.envelope.ok, "the seat is refused while the operator holds").toBe(false);
    await notice.getByRole("button", { name: "Reload" }).click();
    await expect(notice).toHaveCount(0, { timeout: 20_000 });
    // The notice clears when the new document commits; the load runs on after it.
    await expect.poll(
      () => app.evaluate(({ webContents }, url) =>
        webContents.getAllWebContents().some((contents) => contents.getURL().startsWith(url) && !contents.isLoading()), PAGE_URL),
      { timeout: 30_000 },
    ).toBe(true);
    await shot(app, page, "3-reloaded");

    // Handed back, the seat comments on a box of the page as itself.
    await chrome.getByRole("button", { name: "Hand back" }).click();
    const rejoined = await browser(["open", REF]);
    expect(rejoined.envelope.ok, JSON.stringify(rejoined.result)).toBe(true);
    const live = String(rejoined.envelope.data?.sessionId);
    const commented = await browser(["comment", live, "--box", "40,60,380,140", "--text", "The heading names the domain, not the product."]);
    expect(commented.envelope.ok, JSON.stringify(commented.result)).toBe(true);
    await shot(app, page, "4-seat-commented");
    const db = join(sandbox.homeDir, ".junto", "state", "junto.db");
    const rows = execFileSync("sqlite3", ["-json", db, "SELECT actor_seat_id, metadata_json FROM work_messages WHERE node_id = 'p1'"], { encoding: "utf8" });
    const posted = JSON.parse(rows || "[]") as Array<{ actor_seat_id: string | null; metadata_json: string }>;
    expect(posted).toHaveLength(1);
    // Posted as the seat, not the operator.
    expect(posted[0]!.actor_seat_id).toBeTruthy();
    expect(JSON.parse(posted[0]!.metadata_json).threadSubject).toMatchObject({ kind: "page", nodeId: "p1", anchor: { kind: "box" } });

    // Paused: the seat still reads, and does not act.
    await page.getByTestId("factory-pause").click();
    await expect(page.getByTestId("factory-pause")).not.toHaveAttribute("data-pause-state", "playing", { timeout: 10_000 });
    const pausedEval = await browser(["eval", live, "1"]);
    expect(pausedEval.envelope.ok).toBe(false);
    expect(JSON.stringify(pausedEval.envelope)).toContain(PAUSED);
    const pages = await browser(["pages"]);
    expect(pages.envelope.ok, JSON.stringify(pages.result)).toBe(true);
    await shot(app, page, "5-paused");
    if (SHOTS !== undefined) {
      writeFileSync(join(SHOTS, "6-seat-calls.json"), `${JSON.stringify({ opened, ran, held, commented, pausedEval, pages, posted }, null, 2)}\n`);
    }
  } finally {
    await junto.close();
  }
});
