/**
 * Settings > Terminal > Seats > "Seat opens on": a fresh machine shows
 * Terminal, picking Threads survives a quit and relaunch, and the setting
 * search finds the row by "threads" and by "seat opens".
 *
 * Frames land in JUNTO_E2E_FRAMES_DIR (default test-results/seat-opens-on).
 *   bun run test:e2e:fast e2e/scenarios/seat-opens-on-setting.spec.ts
 */
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { modelFixture } from "../harness/model";
import { canvasReady } from "../harness/canvas";
import { destroySandbox } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "seatopens";
const FRAMES = process.env.JUNTO_E2E_FRAMES_DIR ?? join("test-results", "seat-opens-on");

const frame = async (page: Page, name: string): Promise<void> => {
  await page.screenshot({ path: join(FRAMES, `${name}.png`) });
};

const openTerminalPage = async (page: Page) => {
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Terminal" }).click();
  const trigger = dialog.locator('button[aria-label="Seat opens on"]');
  await expect(trigger).toBeVisible();
  return { dialog, trigger };
};

test("Seat opens on defaults to Terminal, keeps Threads across a restart, and search finds it", async () => {
  test.setTimeout(180_000);
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([]) } });
  const child = junto.app.process();
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  try {
    await canvasReady(junto.page, { timeout: 30_000 });

    // A fresh machine: the row reads Terminal.
    const { dialog, trigger } = await openTerminalPage(junto.page);
    await expect(trigger).toHaveText("Terminal");
    await frame(junto.page, "1-default-terminal");

    // Pick Threads.
    await trigger.click();
    // The list is portaled to the document body, outside the dialog.
    await junto.page.getByRole("listbox", { name: "Seat opens on" }).getByRole("option", { name: "Threads" }).click();
    await expect(trigger).toHaveText("Threads");
    await frame(junto.page, "2-picked-threads");

    // Search finds the row by either phrase.
    const search = dialog.getByRole("combobox", { name: "Search settings" });
    for (const [query, name] of [
      ["threads", "3-search-threads"],
      ["seat opens", "4-search-seat-opens"],
    ] as const) {
      await search.fill(query);
      const found = dialog.getByRole("listbox", { name: "Settings found" });
      await expect(found.getByRole("option").filter({ hasText: "Seat opens on" })).toBeVisible();
      await frame(junto.page, name);
    }

    // Quit, then relaunch on the same machine state.
    await junto.app.evaluate(({ app }) => {
      app.quit();
    });
    await Promise.race([
      exited,
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("the app did not quit within 30s")), 30_000)),
    ]);

    const again = await launchJunto({ sandbox: junto.sandbox });
    try {
      await canvasReady(again.page, { timeout: 30_000 });
      const reopened = await openTerminalPage(again.page);
      await expect(reopened.trigger).toHaveText("Threads");
      await frame(again.page, "5-after-restart-threads");
    } finally {
      await again.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await junto.close().catch(() => undefined);
    await destroySandbox(junto.sandbox).catch(() => undefined);
  }
});
