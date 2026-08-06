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
import { expect, test } from "../harness/launch";

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
  id: "region-paths-2",
  type: "group",
  label: "beacon orbit",
  x: 40,
  y: 40,
  width: 640,
  height: 360,
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
            readonly vellumCommand?: { readonly listCanvases: () => Promise<unknown[]> };
          };
          return Boolean(runtime.vellumCommand?.listCanvases);
        }),
      { timeout: 30_000 },
    )
    .toBe(true);

  await page.evaluate(async (document) => {
    const api = (
      globalThis as unknown as {
        readonly vellumCommand: {
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
    ).vellumCommand;
    const list = await api.listCanvases();
    const name = list[0]?.name ?? (await api.createCanvas("region-paths")).name;
    // Retry once on revision conflict (autosave / concurrent stamp).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const read = await api.readCanvas(name);
      try {
        await api.writeCanvas(name, document, read.revision);
        return;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
  }, doc);
};

const openRegionPaths = async (page: Page, regionNodeId: string) => {
  const region = page.getByTestId(`rf__node-${regionNodeId}`);
  await expect(region).toBeVisible({ timeout: 30_000 });
  // Region interiors are inert background (rubber-band surface) — select the
  // region through its label drag handle, the only movable chrome.
  await region.locator(".region-drag-handle").click();
  const pathsBtn = page.getByRole("button", { name: /Region folder paths/i });
  await expect(pathsBtn).toBeVisible({ timeout: 10_000 });
  await pathsBtn.click();
  const dialog = page.getByRole("dialog", { name: "Region folder paths" });
  await expect(dialog).toBeVisible();
  return dialog;
};

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
});

test("region folder paths — empty, save, escape", async ({ vellumCommand }) => {
  const { page } = vellumCommand;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await installBoard(page, canvasDoc([regionEmpty]));
  await expect(page.getByTestId(`rf__node-${regionEmpty.id}`)).toBeVisible({
    timeout: 30_000,
  });

  let dialog = await openRegionPaths(page, regionEmpty.id);
  await expect(dialog.getByText("Folder paths", { exact: true })).toBeVisible();
  // Empty bag seeds one local host row + host directory picker (not a bare text field).
  await expect(dialog.getByRole("listbox", { name: "Hosts with paths" })).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: /Working directory for /i })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /use this folder/i })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /add host/i })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /save/i })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close folder paths" })).toBeVisible();

  await page.screenshot({
    path: join(SHOTS, "21-region-paths-empty.png"),
    fullPage: false,
  });

  const pathInput = dialog.getByRole("textbox", { name: /Working directory for /i });
  await pathInput.fill("/Users/operator/Projects/forge");
  await dialog.getByRole("button", { name: /^save$/i }).click();
  await expect(dialog).toHaveCount(0);

  dialog = await openRegionPaths(page, regionEmpty.id);
  await expect(
    dialog.getByRole("textbox", { name: /Working directory for /i }),
  ).toHaveValue("/Users/operator/Projects/forge");
  await page.screenshot({
    path: join(SHOTS, "21-region-paths-saved.png"),
    fullPage: false,
  });

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Region folder paths" })).toHaveCount(0);
});

test("region folder paths — multi-host seed + remove", async ({ vellumCommand }) => {
  const { page } = vellumCommand;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await installBoard(page, canvasDoc([regionFilled]));
  await expect(page.getByTestId(`rf__node-${regionFilled.id}`)).toBeVisible({
    timeout: 30_000,
  });

  let dialog = await openRegionPaths(page, regionFilled.id);
  await expect(dialog.getByRole("listbox", { name: "Hosts with paths" })).toBeVisible();
  // The picker shows the selected host only — local is the first stored key.
  await expect(
    dialog.getByRole("textbox", { name: /Working directory for /i }),
  ).toHaveValue("/Users/operator/Projects/vellum");
  await dialog.getByRole("option", { name: /remote-a/i }).click();
  await expect(
    dialog.getByRole("textbox", { name: /Working directory for remote-a/i }),
  ).toHaveValue("/home/operator/vellum");
  await expect(dialog.getByRole("button", { name: /use this folder/i }).first()).toBeVisible();
  await page.screenshot({
    path: join(SHOTS, "21-region-paths-multi-host.png"),
    fullPage: false,
  });

  await dialog.getByRole("button", { name: /Remove remote-a/i }).click();
  await expect(dialog.getByRole("option", { name: /remote-a/i })).toHaveCount(0);
  await dialog.getByRole("button", { name: /^save$/i }).click();
  await expect(dialog).toHaveCount(0);

  dialog = await openRegionPaths(page, regionFilled.id);
  await expect(
    dialog.getByRole("textbox", { name: /Working directory for /i }),
  ).toHaveValue("/Users/operator/Projects/vellum");
  await expect(dialog.getByRole("option", { name: /remote-a/i })).toHaveCount(0);
});
