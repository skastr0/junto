/**
 * Settings, Appearance — Interface size makes the whole window larger or
 * smaller together, holds across a reload, and always leaves a way back.
 * Frames land in test-results/interface-size/ (disposable, never committed).
 *
 *   scripts/run-e2e.sh e2e/scenarios/interface-size.spec.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "interface-size");

test("interface size scales the whole window and the way back stays in reach", async () => {
  test.setTimeout(180_000);
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({ windowContentSize: { width: 1280, height: 800 } });
  try {
    const { app, page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 60_000 });
    const zoomFactor = (): Promise<number> =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor() ?? 0);
    // The window's own capture: a page screenshot crops a zoomed window to its top left.
    const frame = async (name: string): Promise<void> => {
      await page.waitForTimeout(300);
      const png = await app.evaluate(async ({ BrowserWindow }) => {
        const image = await BrowserWindow.getAllWindows()[0]?.webContents.capturePage();
        return image?.toPNG().toString("base64") ?? "";
      });
      await writeFile(join(SHOTS, `${name}.png`), Buffer.from(png, "base64"));
    };
    const group = page.getByRole("radiogroup", { name: "Interface size", exact: true });
    const size = (percent: number) => group.getByTestId(`interface-size-${String(percent)}`);
    const openAppearance = async (): Promise<void> => {
      await page.getByRole("button", { name: "Open settings" }).click();
      await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
      await expect(group).toBeVisible();
    };

    await openAppearance();
    await expect(size(100)).toHaveAttribute("aria-checked", "true");
    await expect(size(100)).toHaveAccessibleName("100 percent, standard");
    expect(await zoomFactor()).toBeCloseTo(1, 2);
    await frame("settings-100");

    for (const percent of [150, 200] as const) {
      await size(percent).click();
      await expect(size(percent)).toHaveAttribute("aria-checked", "true");
      await expect.poll(zoomFactor).toBeCloseTo(percent / 100, 2);
      // The row that undoes the choice is still on screen and still pressable.
      await size(100).scrollIntoViewIfNeeded();
      await expect(size(100)).toBeInViewport();
    await frame(`settings-${String(percent)}`);
    }

    // Tight window at the largest size: the size is held to what the window
    // can show, so the way into Settings stays inside it, and the way back works.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(960, 680));
    await expect.poll(zoomFactor).toBeCloseTo(1.5, 2);
    await expect(size(200)).toHaveAttribute("aria-checked", "true");
    const settingsEdge = await page.evaluate(() => {
      const box = document.querySelector('button[aria-label="Open settings"]')?.getBoundingClientRect();
      return { right: box?.right ?? Number.POSITIVE_INFINITY, inner: window.innerWidth };
    });
    expect(settingsEdge.right).toBeLessThanOrEqual(settingsEdge.inner);
    await size(100).scrollIntoViewIfNeeded();
    await expect(size(100)).toBeInViewport();
    await page.waitForTimeout(300);
    await frame("settings-200-small-window");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800));
    await expect.poll(zoomFactor).toBeCloseTo(2, 2);

    await size(150).click();
    await expect.poll(zoomFactor).toBeCloseTo(1.5, 2);
    await page.locator(".settings-panel__close").click();
    await page.waitForTimeout(300);
    await frame("canvas-150");

    // The size is stored, not held by the page.
    await page.reload();
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 60_000 });
    await expect.poll(zoomFactor).toBeCloseTo(1.5, 2);

    await openAppearance();
    await size(100).click();
    await expect.poll(zoomFactor).toBeCloseTo(1, 2);
    await page.locator(".settings-panel__close").click();
    await page.waitForTimeout(300);
    await frame("canvas-100");
  } finally {
    await junto.close();
  }
});
