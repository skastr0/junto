/**
 * What the canvas offers around and over its own drawing, on the GPU canvas:
 * the creation wizards, the squad dialog, images dropped and pasted onto the
 * field, and the impact/focus chip with the wire mode that follows the
 * gesture.
 *
 * Each of these belongs to the canvas, not to one canvas implementation.
 * They were mounted inside the old canvas's tree, so switching the GPU canvas
 * on left +Add Item → Terminal / Git / Files and Save as Squad silently dead,
 * and images could not land on the field at all. These tests hold the parity:
 * the same act, the same result, and the pixels of the proof.
 */
import type { Page } from "@playwright/test";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { card, cardCount, canvasReady, handle as cardHandle, pane } from "../harness/canvas";
import { expect, test } from "../harness/launch";
import { modelFixture, modelSeat, modelWire } from "../harness/model";

interface PngImage {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}
const { PNG } = createRequire(import.meta.url)("pngjs") as {
  readonly PNG: { readonly sync: { read(buf: Buffer): PngImage } };
};

/** Cyan pixels in the band around a card's edge: the keyboard focus ring. */
const focusRingPixels = (image: PngImage, rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): number => {
  let count = 0;
  for (let y = Math.max(0, Math.floor(rect.y - 8)); y <= Math.min(image.height - 1, Math.ceil(rect.y + rect.height + 8)); y += 1) {
    for (let x = Math.max(0, Math.floor(rect.x - 8)); x <= Math.min(image.width - 1, Math.ceil(rect.x + rect.width + 8)); x += 1) {
      // Only the edge: the card's own portrait may be blue.
      if (x > rect.x + 1 && x < rect.x + rect.width - 1 && y > rect.y + 1 && y < rect.y + rect.height - 1) continue;
      const at = (y * image.width + x) * 4;
      const [r, g, b] = [image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0];
      if (b > 140 && g > 120 && b > r * 1.25 && g > r * 1.1) count += 1;
    }
  }
  return count;
};

const CANVAS = "gpu-shell-parity";

const seats = [
  modelSeat({ id: "a", key: "local:parity-alpha", label: "Alpha", x: -420, y: -40 }),
  modelSeat({ id: "b", key: "local:parity-bravo", label: "Bravo", x: -40, y: -40 }),
  modelSeat({ id: "c", key: "local:parity-charlie", label: "Charlie", x: 340, y: -40 }),
];
const fixture = modelFixture(seats, [modelWire("a-b", "a", "b", "messages", seats)]);

test.use({
  juntoOptions: {
    seedModels: { [CANVAS]: fixture },
    seedExperimentalFeatures: ["gpuCanvas"],
  },
});

/** The wire mode the shell pushed for this canvas (shell/wire-mode.ts). */
const wireMode = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const hook = (window as unknown as { __juntoCanvas?: { wireMode?: () => string } }).__juntoCanvas;
    return hook?.wireMode?.() ?? "";
  });

const shot = async (page: Page, testInfo: import("@playwright/test").TestInfo, name: string): Promise<void> => {
  const box = await pane(page).box();
  expect(box).not.toBeNull();
  await page.screenshot({ path: testInfo.outputPath(name), clip: box ?? undefined });
};

const openDeck = async (page: Page) => {
  // The bar mounts the field tools once, over the minimap.
  await page.getByRole("button", { name: "Add canvas item" }).click();
  const deck = page.getByRole("dialog", { name: "Add canvas item" });
  await expect(deck).toBeVisible();
  return deck;
};

const addItem = async (page: Page, name: string): Promise<void> => {
  const deck = await openDeck(page);
  await deck.getByRole("button", { name: new RegExp(`^${name}\\b`) }).first().click();
};

/** A 1x1 PNG, the smallest real image a drop or a paste can carry. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Drop a real PNG file at a point inside the canvas element. */
const dropImage = async (page: Page, at: { readonly x: number; readonly y: number }): Promise<void> => {
  await page.evaluate(
    async ({ point, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
      const canvas = document.querySelector<HTMLCanvasElement>("canvas[data-testid='gpu-canvas']");
      if (canvas === null) throw new Error("the GPU canvas element is not mounted");
      const box = canvas.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        dataTransfer: data,
        clientX: box.left + point.x,
        clientY: box.top + point.y,
      };
      canvas.dispatchEvent(new DragEvent("dragover", init));
      canvas.dispatchEvent(new DragEvent("drop", init));
    },
    { point: at, base64: PNG_BASE64 },
  );
};

/** Paste a real PNG image with nothing typing. */
const pasteImage = async (page: Page): Promise<void> => {
  await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data });
    if (event.clipboardData === null) Object.defineProperty(event, "clipboardData", { value: data });
    document.body.dispatchEvent(event);
  }, PNG_BASE64);
};

test("+Add Item reaches the terminal, git and files wizards on the GPU canvas", async ({ junto }, testInfo) => {
  test.setTimeout(120_000);
  const { page } = junto;
  await canvasReady(page);

  await addItem(page, "Terminal");
  const terminal = page.getByRole("dialog", { name: "New terminal" });
  await expect(terminal).toBeVisible();
  await expect(terminal.getByRole("button", { name: "Create terminal" })).toBeVisible();
  await shot(page, testInfo, "add-item-terminal-wizard.png");
  await terminal.getByRole("button", { name: "Cancel" }).click();
  await expect(terminal).toHaveCount(0);

  await addItem(page, "Git");
  const git = page.getByRole("dialog", { name: "New git" });
  await expect(git).toBeVisible();
  await shot(page, testInfo, "add-item-git-wizard.png");
  await git.getByRole("button", { name: "Cancel" }).click();

  await addItem(page, "Files");
  const files = page.getByRole("dialog", { name: "New files" });
  await expect(files).toBeVisible();
  await shot(page, testInfo, "add-item-files-wizard.png");
  await files.getByRole("button", { name: "Cancel" }).click();
});

test("save as squad opens from the selection menu on the GPU canvas", async ({ junto }, testInfo) => {
  test.setTimeout(120_000);
  const { page } = junto;
  await canvasReady(page);

  await card(page, "a").click();
  await card(page, "b").click({ modifiers: ["Shift"] });
  await expect.poll(() => page.evaluate(() => {
    const hook = (window as unknown as { __juntoCanvas?: { selected?: () => ReadonlyArray<string> } }).__juntoCanvas;
    return hook?.selected?.().length ?? 0;
  })).toBe(2);

  await card(page, "b").rightClick();
  const menu = page.getByRole("toolbar", { name: "Actions for 2 nodes" });
  await expect(menu).toBeVisible();
  const row = menu.getByRole("button", { name: "Save the selected agents as a squad" });
  await expect(row).toBeVisible();
  await shot(page, testInfo, "selection-menu-squad-row.png");
  await row.click();

  const dialog = page.getByRole("dialog", { name: "Save as squad" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Squad name")).toBeVisible();
  await shot(page, testInfo, "save-as-squad-dialog.png");
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("an image dropped or pasted onto the GPU canvas becomes a card", async ({ junto }, testInfo) => {
  test.setTimeout(120_000);
  const { page } = junto;
  await canvasReady(page);
  const before = await cardCount(page);

  await dropImage(page, { x: 380, y: 260 });
  await expect.poll(() => cardCount(page), { timeout: 20_000 }).toBe(before + 1);
  await shot(page, testInfo, "image-dropped.png");

  await pasteImage(page);
  await expect.poll(() => cardCount(page), { timeout: 20_000 }).toBe(before + 2);
  await shot(page, testInfo, "image-pasted.png");
});

test("the cone chip and the wire mode follow the focus and the connect gesture", async ({ junto }, testInfo) => {
  test.setTimeout(120_000);
  const { page } = junto;
  await canvasReady(page);
  await expect.poll(() => wireMode(page)).toBe("rest");

  // A connection focus paints the cone: the chip names it and the wire mode
  // follows, so the cone's wires stay drawn and pickable.
  await card(page, "a").click();
  await page.getByTestId("node-toolbar-focus").click();
  const chip = page.locator(".impact-hud");
  await expect(chip).toBeVisible();
  await expect(chip.locator(".impact-hud__eyebrow")).toHaveText("focus");
  await expect.poll(() => wireMode(page)).toBe("cone");
  await shot(page, testInfo, "cone-chip-focus.png");

  // A connect gesture in flight holds its own reason: the wires a drop could
  // land on show, and letting go leaves the cone's reason standing.
  const start = await cardHandle(page, "a", "right").box();
  const target = await card(page, "b").box();
  expect(start).not.toBeNull();
  expect(target).not.toBeNull();
  await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2);
  await page.mouse.down();
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 12 });
  await expect.poll(() => wireMode(page)).toBe("connecting");
  await shot(page, testInfo, "connect-gesture-wires.png");
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height - 4, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => wireMode(page)).toBe("cone");
  await expect(chip).toBeVisible();

  // Letting the focus go leaves nothing held.
  await page.getByTestId("node-toolbar-focus").click();
  await expect.poll(() => wireMode(page)).toBe("rest");
  await expect(chip).toHaveCount(0);
});

test("Tab walks the keyboard focus ring across cards", async ({ junto }, testInfo) => {
  test.setTimeout(120_000);
  const { page } = junto;
  await canvasReady(page);
  const focused = (): Promise<string> => page.evaluate(() => window.__juntoCanvas?.focused?.() ?? "");

  // A press on empty pane hands the canvas the keyboard and leaves no
  // selection, so the walk starts from the reading order's first card.
  await pane(page).click({ position: { x: 80, y: 80 } });
  await expect.poll(focused).toBe("");
  await expect.poll(() => page.evaluate(() => window.__juntoCanvas?.selection() ?? [])).toEqual([]);

  await page.keyboard.press("Tab");
  await expect.poll(focused).toBe("a");
  const buffer = await page.screenshot({ scale: "css" });
  writeFileSync(testInfo.outputPath("keyboard-focus-ring.png"), buffer);
  const image = PNG.sync.read(buffer);
  const box = await card(page, "a").box();
  expect(box).not.toBeNull();
  expect(focusRingPixels(image, box!), "the cyan ring paints around the focused card").toBeGreaterThan(40);

  await page.keyboard.press("Tab");
  await expect.poll(focused).toBe("b");
  await page.keyboard.press("Shift+Tab");
  await expect.poll(focused).toBe("a");
  await page.keyboard.press("Escape");
  await expect.poll(focused).toBe("");
});
