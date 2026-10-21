/**
 * Real-app verify of 62d3b5178: a modal panel remembers only the width the
 * operator dragged on the resize grip; a squeezed window never sticks; a
 * double click on the grip forgets; the browser opening does not change it.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { ElectronApplication } from "playwright-core";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode, modelSeat, modelTerminal, modelMessagesWire } from "../harness/model";

const CANVAS = "verify-resize";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/modal-size-memory";
const PANEL = ".focus-surface__panel.work-focus-shell__panel";

const shot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

const setContentWidth = (app: ElectronApplication, width: number): Promise<void> =>
  app.evaluate(({ BrowserWindow }, w) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    win.setContentSize(w, win.getContentSize()[1]!);
  }, width);

test("62d3b5178: size memory is the operator's drag; squeezed windows and the browser do not stick", async () => {
  test.setTimeout(420_000);
  const a = modelSeat({ id: "seat-a", label: "alpha", x: 40, y: 40 });
  const b = modelSeat({ id: "seat-b", label: "beta", x: 340, y: 40 });
  const term = modelTerminal({ id: "term-1", bindingId: "local:resize-term", label: "shell", x: 40, y: 260 });
  const pageNode = modelNode({ kind: "page", id: "p1", url: "https://example.com/", profile: "personal", onRemove: "kill-session", x: 340, y: 260, width: 240, height: 80, z: 0 });
  const nodes = [a, b, term, pageNode];
  const junto = await launchJunto({
    windowContentSize: { width: 1700, height: 900 },
    seedModels: { [CANVAS]: modelFixture(nodes, [modelMessagesWire("w1", "seat-a", "seat-b", nodes)]) },
  });
  const report: string[] = [];
  try {
    const { app, page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Fit all" }).click();
    await page.waitForTimeout(600);
    const panel = page.locator(PANEL).last();
    const width = (): Promise<number> => panel.evaluate((el) => (el as HTMLElement).offsetWidth);
    const frameWidth = (): Promise<number> => panel.evaluate((el) => el.parentElement!.clientWidth);
    const open = async (id: string): Promise<void> => {
      const box = (await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox())!;
      await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
      await expect(page.locator(PANEL)).toHaveCount(1, { timeout: 20_000 });
      await page.waitForTimeout(900); // the enter animation and the restore frame
    };
    const close = async (): Promise<void> => {
      await page.keyboard.press("Meta+w");
      await expect(page.locator(PANEL)).toHaveCount(0, { timeout: 10_000 });
    };
    const grip = async (): Promise<[number, number]> => {
      const box = (await panel.boundingBox())!;
      return [box.x + box.width - 8, box.y + box.height - 8];
    };
    const dragNarrower = async (by: number): Promise<void> => {
      const [x, y] = await grip();
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - by / 2, y, { steps: 8 });
      await page.mouse.move(x - by, y, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(300);
    };
    const near = (got: number, want: number, tol = 3): void => expect(Math.abs(got - want), `${got} should be within ${tol} of ${want}`).toBeLessThanOrEqual(tol);

    for (const target of [
      { id: "term-1", name: "plain terminal" },
      { id: "seat-a", name: "actor terminal with the connected-agents rail" },
    ]) {
      await open(target.id);
      const railed = await page.locator(`${PANEL} [aria-label*="onnected"], ${PANEL} aside`).count();
      const w0 = await width();
      report.push(`${target.name} | default width ${w0} (frame ${await frameWidth()}), aside/rail elements: ${railed}`);

      // (1) drag the grip narrower, close, reopen: the dragged width comes back.
      await dragNarrower(420);
      const w1 = await width();
      report.push(`${target.name} | after grip drag ${w1}`);
      expect(w1, "the grip drag changes the width (Chromium delivers the native grip drag)").toBeLessThan(w0 - 100);
      await shot(page, `${target.id}-1-dragged`);
      await close();
      await open(target.id);
      near(await width(), w1);
      report.push(`${target.name} | (1) reopened at ${await width()}`);

      // (2) squeeze the window below the panel width, reopen; widen, reopen: the dragged width returns.
      await close();
      await setContentWidth(app, 800);
      await page.waitForTimeout(600);
      await open(target.id);
      const squeezed = await width();
      const squeezedFrame = await frameWidth();
      report.push(`${target.name} | (2) window 800: panel ${squeezed} in frame ${squeezedFrame}`);
      expect(squeezed).toBeLessThanOrEqual(squeezedFrame);
      await shot(page, `${target.id}-2-squeezed`);
      await close();
      await setContentWidth(app, 1700);
      await page.waitForTimeout(600);
      await open(target.id);
      const widened = await width();
      report.push(`${target.name} | (2) window 1700 again: panel ${widened} (dragged ${w1})`);
      near(widened, w1);
      await shot(page, `${target.id}-2-widened`);

      // (3) the browser opens and closes; the terminal's width is unchanged.
      await close();
      await open("p1");
      await expect(page.getByTestId("browser-chrome")).toBeVisible({ timeout: 30_000 });
      await page.getByRole("region", { name: "Browser page surface" }).getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.locator(PANEL)).toHaveCount(0, { timeout: 10_000 });
      await open(target.id);
      near(await width(), w1);
      report.push(`${target.name} | (3) after browser open and close: ${await width()}`);

      // (4) double-click the grip: the default measure returns.
      const [gx, gy] = await grip();
      await page.mouse.dblclick(gx, gy);
      await page.waitForTimeout(500);
      const reset = await width();
      report.push(`${target.name} | (4) after grip double-click ${reset} (default ${w0})`);
      near(reset, w0);
      await close();
      await open(target.id);
      near(await width(), w0);
      report.push(`${target.name} | (4) reopened at default ${await width()}`);
      await shot(page, `${target.id}-4-default`);
      await close();
    }
    console.log("REPORT\n" + report.join("\n"));
  } finally {
    console.log("PARTIAL REPORT\n" + report.join("\n"));
    await junto.close();
  }
});
