/**
 * Region folder paths modal — design + a11y capture.
 *
 * Opens the host→cwd editor from a selected region toolbar, screenshots empty
 * and filled states, and checks dialog naming / keyboard close.
 *
 *   bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/region-paths.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { CanvasDoc, GroupNode } from "../../src/shared/canvas";
import { canvasDoc } from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "design-audit");

const regionEmpty: GroupNode = {
  id: "region-paths-1",
  type: "group",
  label: "forge orbit",
  x: 40,
  y: 40,
  width: 640,
  height: 360,
  ether: { region: { hold: true } },
};

const regionFilled: GroupNode = {
  ...regionEmpty,
  id: "region-paths-2",
  label: "beacon orbit",
  ether: {
    region: {
      hold: true,
      defaults: {
        paths: {
          local: "/Users/operator/Projects/vellum",
          "remote-a": "/home/operator/vellum",
        },
      },
    },
  },
};

const installBoard = async (page: Page, doc: CanvasDoc): Promise<void> => {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const runtime = globalThis as unknown as {
            readonly vellum?: { readonly listCanvases: () => Promise<unknown[]> };
          };
          return Boolean(runtime.vellum?.listCanvases);
        }),
      { timeout: 30_000 },
    )
    .toBe(true);

  await page.evaluate(async (document) => {
    const api = (
      globalThis as unknown as {
        readonly vellum: {
          readonly listCanvases: () => Promise<ReadonlyArray<{ name: string }>>;
          readonly createCanvas: (name: string) => Promise<{ name: string }>;
          readonly readCanvas: (name: string) => Promise<{ revision: string }>;
          readonly writeCanvas: (
            name: string,
            doc: unknown,
            expectedRevision?: string,
          ) => Promise<unknown>;
        };
      }
    ).vellum;
    const list = await api.listCanvases();
    const name = list[0]?.name ?? (await api.createCanvas("region-paths")).name;
    const read = await api.readCanvas(name);
    await api.writeCanvas(name, document, read.revision);
  }, doc);
};

const openRegionPaths = async (page: Page, regionLabel: string) => {
  const region = page.locator(".react-flow__node", { hasText: regionLabel }).first();
  await expect(region).toBeVisible({ timeout: 30_000 });
  await region.click({ position: { x: 24, y: 24 } });
  const pathsBtn = page.getByRole("button", { name: "Region folder paths" });
  await expect(pathsBtn).toBeVisible({ timeout: 10_000 });
  await pathsBtn.click();
  const dialog = page.getByRole("dialog", { name: "Region folder paths" });
  await expect(dialog).toBeVisible();
  return dialog;
};

test("region folder paths modal — empty, filled, accessible", async () => {
  await mkdir(SHOTS, { recursive: true });
  const vellum = await launchVellum();

  try {
    const { page } = vellum;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

    // ── empty state ────────────────────────────────────────────────────────
    await installBoard(page, canvasDoc([regionEmpty]));
    await expect(page.getByText("forge orbit")).toBeVisible({ timeout: 30_000 });

    let dialog = await openRegionPaths(page, "forge orbit");
    await expect(dialog.getByText("Folder paths")).toBeVisible();
    await expect(dialog.getByRole("status")).toContainText(/No host paths yet/i);
    await expect(dialog.getByRole("button", { name: /add host/i })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /save/i })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close folder paths" })).toBeVisible();

    await page.screenshot({
      path: join(SHOTS, "21-region-paths-empty.png"),
      fullPage: false,
    });

    // Add a row, fill path, save.
    await dialog.getByRole("button", { name: /add host/i }).click();
    const pathInput = dialog.getByRole("textbox", { name: /Default path/i });
    await expect(pathInput).toBeVisible();
    await pathInput.fill("/Users/operator/Projects/forge");
    await dialog.getByRole("button", { name: /^save$/i }).click();
    await expect(dialog).toHaveCount(0);

    // Re-open — path persisted on the region.
    dialog = await openRegionPaths(page, "forge orbit");
    await expect(
      dialog.getByRole("textbox", { name: /Default path/i }),
    ).toHaveValue("/Users/operator/Projects/forge");
    await page.screenshot({
      path: join(SHOTS, "21-region-paths-saved.png"),
      fullPage: false,
    });

    // Escape closes the dialog (FocusSurface keyboard contract).
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Region folder paths" })).toHaveCount(0);

    // ── multi-host filled seed ─────────────────────────────────────────────
    await installBoard(page, canvasDoc([regionFilled]));
    await expect(page.getByText("beacon orbit")).toBeVisible({ timeout: 30_000 });
    dialog = await openRegionPaths(page, "beacon orbit");
    await expect(dialog.getByRole("list", { name: "Host folder paths" })).toBeVisible();
    await expect(dialog.getByDisplayValue("/Users/operator/Projects/vellum")).toBeVisible();
    await expect(dialog.getByDisplayValue("/home/operator/vellum")).toBeVisible();
    await page.screenshot({
      path: join(SHOTS, "21-region-paths-multi-host.png"),
      fullPage: false,
    });

    // Remove one row keeps the other; save.
    await dialog
      .getByRole("button", { name: /Remove path for remote-a/i })
      .click();
    await expect(dialog.getByDisplayValue("/home/operator/vellum")).toHaveCount(0);
    await dialog.getByRole("button", { name: /^save$/i }).click();
    await expect(dialog).toHaveCount(0);

    dialog = await openRegionPaths(page, "beacon orbit");
    await expect(dialog.getByDisplayValue("/Users/operator/Projects/vellum")).toBeVisible();
    await expect(dialog.getByDisplayValue("/home/operator/vellum")).toHaveCount(0);
  } finally {
    await vellum.close();
  }
});
