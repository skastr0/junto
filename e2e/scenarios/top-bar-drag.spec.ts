/**
 * The top bar and its window drag region. app-region is a darwin behaviour
 * (the bar is `-webkit-app-region: drag` there, and a drag region ignores
 * z-index), so the Linux display cannot prove that a window really stops
 * dragging. What it can prove is the cascade: Chromium computes the same
 * `-webkit-app-region` here, so with the darwin marker set on <html> the bar
 * reads `drag` at rest and `no-drag` while any overlay is open, and `drag`
 * again once it is closed. An always-open dialog or menu in the page would
 * make the bar undraggable for good; the rest line catches that.
 *   bun run test:e2e:fast e2e/scenarios/top-bar-drag.spec.ts
 */
import type { Page } from "@playwright/test";
import { canvasReady } from "../harness/canvas";
import { mod } from "../harness/keys";
import { expect, test } from "../harness/launch";

const appRegion = (page: Page): Promise<string> =>
  page.evaluate(() => getComputedStyle(document.querySelector(".station-bar")!).getPropertyValue("-webkit-app-region").trim());

test("the bar is a drag region at rest and none while an overlay is open", async ({ junto: { page } }) => {
  await canvasReady(page, { timeout: 30_000 });
  // The window sets this from main's platform; the Linux display stands in for the Mac.
  await page.evaluate(() => {
    document.documentElement.dataset.juntoPlatform = "darwin";
  });
  await expect.poll(() => appRegion(page), { message: "the bar at rest" }).toBe("drag");

  // A dialog that crosses the bar: the command bar.
  await page.getByRole("button", { name: /^Search / }).click();
  await expect(page.getByRole("dialog").first()).toBeVisible();
  await expect.poll(() => appRegion(page), { message: "the bar with the command bar open" }).toBe("no-drag");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => appRegion(page), { message: "the bar after it closed" }).toBe("drag");

  // Quick thread, which sits in the bar's band.
  await page.keyboard.press(mod("Shift+U"));
  await expect(page.getByTestId("quick-thread")).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => appRegion(page), { message: "the bar with Quick thread open" }).toBe("no-drag");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("quick-thread")).toHaveCount(0);
  await expect.poll(() => appRegion(page), { message: "the bar after Quick thread closed" }).toBe("drag");

  // A listbox that is not the bar's own: the canvas switcher's list.
  await page.getByRole("combobox", { name: "Active canvas" }).or(page.getByLabel("Active canvas")).first().click();
  await expect(page.getByRole("listbox").first()).toBeVisible();
  await expect.poll(() => appRegion(page), { message: "the bar with the canvas list open" }).toBe("no-drag");
  await page.keyboard.press("Escape");
  await expect.poll(() => appRegion(page), { message: "the bar after the list closed" }).toBe("drag");
});
