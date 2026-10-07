/**
 * The top bar's actions are never pushed out of the window.
 *   scripts/run-e2e.sh e2e/scenarios/top-bar-actions-stay.spec.ts
 *
 * The interface size is held to 640 of the bar's own pixels, which fits the
 * bar in a quiet moment. Three things on the right appear only sometimes:
 * the update chip, the pause error and the Logs explorer button. With all
 * three showing at 150 percent in the smallest window, Settings and the
 * needs-you inbox are still inside the window and take a press. With none
 * showing, the bar is laid out exactly as it was without the backstop.
 * Set TOP_BAR_SHOTS to a folder to keep a frame of the worst case.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = process.env.TOP_BAR_SHOTS;
// The bar as it was laid out before the backstop: its left children sit
// straight in the bar and the actions may shrink.
const WITHOUT = ".station-left { display: contents !important; } .station-actions { flex-shrink: 1 !important; }";

test("the top bar's actions stay in the window with the sometimes-there controls showing", async () => {
  test.setTimeout(180_000);
  if (SHOTS) await mkdir(SHOTS, { recursive: true });
  const nodes = [
    agentTextNode({ id: "one", key: "local:tb-one", label: "one", x: 40, y: 40 }),
    agentTextNode({ id: "two", key: "local:tb-two", label: "two", x: 360, y: 40 }),
  ];
  const junto = await launchJunto({
    windowContentSize: { width: 960, height: 680 },
    seedCanvases: { "a-long-canvas-name": canvasDoc(nodes, []) },
  });
  try {
    const { app, page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 60_000 });
    const bar = page.locator(".station-bar");
    const settings = bar.getByRole("button", { name: "Open settings" });
    const inbox = bar.getByTestId("operator-feed-trigger");
    const zoom = (): Promise<number> =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor() ?? 0);
    const setSize = async (percent: 100 | 125 | 150): Promise<void> => {
      await page.evaluate((scale) => window.junto!.settingsPatch({ appearance: { interfaceScale: scale } }), percent);
      await expect.poll(zoom).toBeCloseTo(percent / 100, 2);
      await page.waitForTimeout(300);
    };
    // Where every control in the bar sits, the left wrapper itself left out.
    const rects = (): Promise<string> =>
      bar.evaluate((el) =>
        JSON.stringify(
          [...el.querySelectorAll("button, [role='toolbar'], .station-save, .station-actions")].map((node) => {
            const r = node.getBoundingClientRect();
            return [node.className.toString().slice(0, 40), r.x, r.y, r.width, r.height];
          }),
        ),
      );

    const frame = async (name: string): Promise<void> => {
      if (!SHOTS) return;
      const png = await app.evaluate(async ({ BrowserWindow }) => {
        const image = await BrowserWindow.getAllWindows()[0]?.webContents.capturePage();
        return image?.toPNG().toString("base64") ?? "";
      });
      await writeFile(join(SHOTS, `${name}.png`), Buffer.from(png, "base64"));
    };
    const settingsEnd = async (): Promise<number> => {
      const box = (await settings.boundingBox())!;
      return box.x + box.width;
    };

    // Nothing extra showing: 960, 768 and 640 of the bar's own pixels. Where
    // the bar fitted without the backstop, nothing has moved. Where it did
    // not (a long canvas name at 640), Settings is now inside the window.
    for (const percent of [100, 125, 150] as const) {
      await setSize(percent);
      const width = await page.evaluate(() => window.innerWidth);
      const now = await rects();
      const nowEnd = await settingsEnd();
      const style = await page.addStyleTag({ content: WITHOUT });
      const before = await rects();
      const beforeEnd = await settingsEnd();
      await frame(`quiet-${String(percent)}-without`);
      await style.evaluate((node) => node.remove());
      await frame(`quiet-${String(percent)}-with`);
      if (beforeEnd <= width) {
        expect(now, `the bar is laid out as before at ${String(percent)} percent`).toBe(before);
      } else {
        expect(nowEnd, `Settings is inside the window at ${String(percent)} percent`).toBeLessThanOrEqual(width);
      }
    }

    // The worst case, at 150 percent: all three sometimes-there controls.
    await page.evaluate(() => window.junto!.settingsPatch({ advanced: { logsExplorer: true } }));
    await expect(bar.getByTestId("observability-logs")).toBeVisible();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.send("junto:update-state-changed", {
        phase: "ready",
        available: { version: "9.9.9" },
      }),
    );
    await expect(bar.getByRole("button", { name: /restart/i })).toBeVisible();
    await app.evaluate(({ ipcMain }) => ipcMain.removeHandler("junto:factory-pause-set"));
    await bar.getByTestId("factory-pause").click();
    await expect(bar.getByRole("alert")).toBeVisible();

    const width = await page.evaluate(() => window.innerWidth);
    expect(width, "the bar's own width at 150 percent in a 960 window").toBe(640);
    for (const [name, control] of [["Settings", settings], ["the needs-you inbox", inbox]] as const) {
      const box = (await control.boundingBox())!;
      expect(box.x, `${name} starts inside the window`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${name} ends inside the window`).toBeLessThanOrEqual(width);
      const hit = await control.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return at !== null && el.contains(at);
      });
      expect(hit, `${name} takes a press`).toBe(true);
    }
    await frame("worst-case-150");
    await settings.click();
    await expect(page.locator(".settings-panel__close")).toBeVisible();
  } finally {
    await junto.close();
  }
});
