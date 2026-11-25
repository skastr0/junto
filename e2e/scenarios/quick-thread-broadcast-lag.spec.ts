/**
 * [fake-tui] Quick thread with a region of 60 seats chosen as the recipient
 * (ec46c767e, a46c3c6b7): the keystroke lag in the message field, against the
 * same typing with one seat chosen, and the confirm for 60 seats. Lag is the
 * time from a key going down to the next painted frame, taken in the page. The
 * VM has no GPU and its numbers say how much slower the broadcast is on the
 * same machine, not how slow it is on a Mac. Results land in results.json under
 * JUNTO_E2E_FRAMES_DIR.
 *   scripts/run-e2e.sh e2e/scenarios/quick-thread-broadcast-lag.spec.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { canvasReady, cameraSettled } from "../harness/canvas";
import { mod } from "../harness/keys";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "broadcastlag";
const FRAMES = process.env.JUNTO_E2E_FRAMES_DIR ?? join("test-results", "quick-thread-broadcast-lag");
const SEATS = 60;
const seats = Array.from({ length: SEATS }, (_, i) => modelSeat({ id: `seat-s${String(i)}`, label: `Seat ${String(i).padStart(2, "0")}`, x: 60 + (i % 10) * 300, y: 80 + Math.floor(i / 10) * 160 }));
const lone = modelSeat({ id: "seat-lone", label: "Loner", x: 60, y: 1300 });
const doc = modelFixture([modelRegion({ id: "region-big", label: "Big", x: 0, y: 0, width: 3200, height: 1100 }), ...seats, lone]);

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return { n: s.length, p50: Math.round(at(0.5) * 10) / 10, p95: Math.round(at(0.95) * 10) / 10, max: Math.round(s[s.length - 1]! * 10) / 10 };
};

test("[fake-tui] Quick thread with a region of 60 seats chosen", async () => {
  test.setTimeout(300_000);
  await mkdir(FRAMES, { recursive: true });
  const junto = await launchJunto({ seedModels: { [CANVAS]: doc } });
  const page: Page = junto.page;
  const frame = (): Locator => page.getByTestId("quick-thread");
  const field = (): Locator => frame().getByRole("combobox", { name: "Seat or region" });
  const message = (): Locator => frame().getByTestId("thread-composer-input");
  const result: Record<string, unknown> = {};
  const typeAndMeasure = async (label: string): Promise<void> => {
    await message().click();
    await page.evaluate(() => {
      const w = window as unknown as { __lag: number[] };
      w.__lag = [];
      window.addEventListener("keydown", () => {
        const t0 = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => w.__lag.push(performance.now() - t0)));
      }, true);
    });
    const text = "The release is ready for every one of you, please confirm.";
    for (const ch of text) {
      await page.keyboard.type(ch);
      await settle(40);
    }
    await settle(500);
    const lag = await page.evaluate(() => (window as unknown as { __lag: number[] }).__lag);
    result[label] = stats(lag);
    await page.screenshot({ path: join(FRAMES, `${label}.png`) });
  };
  try {
    await canvasReady(page, { timeout: 30_000 });
    await page.getByRole("button", { name: "Fit all nodes" }).click();
    await cameraSettled(page);
    await page.mouse.click(10, 500);

    // One seat chosen: the baseline.
    await page.keyboard.press(mod("Shift+U"));
    await expect(frame()).toBeVisible({ timeout: 10_000 });
    await field().fill("Loner");
    await page.keyboard.press("Enter");
    await expect(message()).toBeFocused({ timeout: 10_000 });
    await typeAndMeasure("one-seat");
    await message().fill("");
    await page.keyboard.press("Escape");
    await expect(frame()).toHaveCount(0, { timeout: 5_000 });

    // The region of 60 seats chosen as the recipient.
    await page.keyboard.press(mod("Shift+U"));
    await expect(frame()).toBeVisible({ timeout: 10_000 });
    const openStart = Date.now();
    await field().fill("Big");
    await page.keyboard.press("Enter");
    await expect(message()).toBeFocused({ timeout: 15_000 });
    result.regionChosenInMs = Date.now() - openStart;
    await typeAndMeasure("region-60");

    // The confirm for 60 seats.
    const sendStart = Date.now();
    await frame().getByTestId("thread-composer-send").click();
    const confirm = page.getByTestId("quick-thread-confirm");
    await expect(confirm).toBeVisible({ timeout: 15_000 });
    result.confirmShownInMs = Date.now() - sendStart;
    result.confirmText = ((await confirm.textContent()) ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    result.confirmFocus = await page.evaluate(() => `${document.activeElement?.tagName ?? ""}${document.activeElement?.getAttribute("data-testid") ? `[${document.activeElement.getAttribute("data-testid")}]` : ""}${document.activeElement?.getAttribute("aria-label") ? ` "${document.activeElement.getAttribute("aria-label")}"` : ""}`);
    await page.screenshot({ path: join(FRAMES, "confirm-60.png") });
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await page.keyboard.press("Escape");
  } finally {
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify(result, null, 2)}\n`).catch(() => undefined);
    console.log(`BROADCAST60 ${JSON.stringify(result)}`);
    await junto.close();
  }
});
