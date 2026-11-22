/**
 * A trackpad pan keeps going when the board slides a card or a wire under the
 * still pointer (src/window/lib/wheel-latch.ts).
 *
 * The bug: each wire has a transparent select button at its label point, a
 * DOM element over the GPU canvas. Panning moves it under the pointer, the
 * next wheel event lands on the button instead of the canvas, and the pan
 * stops dead. On a real board that happened every few hundred pixels.
 *
 * The pointer rests on empty ground just left of the wire's button and of
 * the cards, then scrolls them across it. Every wheel event must move the
 * camera, on both canvases.
 * Run: `bunx electron-vite build && scripts/run-e2e.sh e2e/scenarios/canvas-wheel-pan.spec.ts`
 */
import type { Page } from "@playwright/test";
import { camera, canvasReady, card } from "../harness/canvas";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelSeat, modelWire } from "../harness/model";

const CANVAS = "wheel-pan";
const seats = [
  modelSeat({ id: "a", key: "local:wheel-alpha", label: "Alpha", x: 0, y: 0 }),
  modelSeat({ id: "b", key: "local:wheel-bravo", label: "Bravo", x: 520, y: 0 }),
  modelSeat({ id: "c", key: "local:wheel-charlie", label: "Charlie", x: 1040, y: 0 }),
];
const fixture = modelFixture(seats, [
  modelWire("a-b", "a", "b", "messages", seats),
  modelWire("b-c", "b", "c", "messages", seats),
]);

/** The first wire select button's centre on screen. */
const wireButton = async (page: Page): Promise<{ x: number; y: number }> => {
  const button = page.locator(".junto-edge-label").first();
  await expect(button).toBeAttached({ timeout: 30_000 });
  const box = await button.boundingBox();
  if (box === null) throw new Error("the wire select button has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

const panAcross = async (page: Page): Promise<void> => {
  await card(page, "a").visible({ timeout: 30_000 });
  const target = await wireButton(page);
  // Rest on empty ground 120 px left of the wire's button, level with it.
  await page.mouse.move(target.x - 120, target.y);
  const elementUnder = (): Promise<string> =>
    page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (el === null) return "";
      // What the pointer is over: a wire's button, a card (any part of it), or ground.
      const over = el.closest(".junto-edge-label, .react-flow__edge") !== null ? "wire" : el.closest(".react-flow__node") !== null ? "card" : "ground";
      return `${over}: ${el.tagName.toLowerCase()}.${el.className}`;
    }, { x: target.x - 120, y: target.y });
  const seen = new Set<string>();
  let before = await camera(page);
  // 60 trackpad-sized steps scroll the button and both cards under the pointer.
  for (let step = 0; step < 60; step += 1) {
    seen.add(await elementUnder());
    await page.mouse.wheel(24, 0);
    await expect.poll(async () => (await camera(page)).x, {
      message: `wheel step ${String(step)} did not move the camera (pointer over ${[...seen].at(-1) ?? "?"})`,
      timeout: 2_000,
    }).not.toBe(before.x);
    before = await camera(page);
  }
  // The test only proves something if the pan really crossed a wire or a card.
  expect([...seen].some((name) => name.startsWith("wire:") || name.startsWith("card:")), [...seen].join(" | ")).toBe(true);
};

test("a wheel pan on the GPU canvas carries on over wires and cards", async () => {
  const junto = await launchJunto({ seedModels: { [CANVAS]: fixture }, seedExperimentalFeatures: ["gpuCanvas"] });
  try {
    const { page } = junto;
    await expect.poll(() => page.evaluate(() => Boolean(window.__juntoCanvas)), { timeout: 30_000 }).toBe(true);
    await canvasReady(page, { timeout: 30_000 });
    await panAcross(page);
  } finally {
    await junto.close();
  }
});

test("a wheel pan on the DOM canvas carries on over wires and cards", async () => {
  const junto = await launchJunto({ seedModels: { [CANVAS]: fixture } });
  try {
    const { page } = junto;
    await canvasReady(page, { timeout: 30_000 });
    await panAcross(page);
  } finally {
    await junto.close();
  }
});
