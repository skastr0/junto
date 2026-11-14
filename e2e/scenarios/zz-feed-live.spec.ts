// Track E's real-canvas proof (operator rule): the feed's SceneOps paint the
// GPU canvas with no card mounted — the loom's routes draw the seat-to-seat
// wire, and kind/spine cards carry their live facts into paint. The hook's
// textOf is the row title only (surface-mirror.ts), so the pixels are the
// evidence: PNGs and the hook dump land in tmpdir/junto-feed-live/ — outside
// test-results/, which every e2e run on this machine wipes.
import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchJunto } from "../harness/launch";
import { galleryFixture } from "../harness/gallery-fixture";
import { modelMessagesWire } from "../harness/model";
import { canvasReady, card, camera, cameraSettled, pane } from "../harness/canvas";

const CANVAS = "factory";
const OUT = join(tmpdir(), "junto-feed-live");

/** Wheel the camera toward a zoom around the pane centre (look-gallery's gesture). */
const zoomTo = async (page: import("@playwright/test").Page, zoom: number): Promise<void> => {
  const deadline = Date.now() + 20_000;
  const cdp = await page.context().newCDPSession(page);
  try {
    for (;;) {
      const cam = await camera(page);
      if (Math.abs(cam.zoom - zoom) < 0.01) break;
      const box = await pane(page).box();
      if (box === null) throw new Error("no pane to zoom over");
      const factor = 0.002 * 10;
      const delta = -Math.log2(zoom / cam.zoom) / factor;
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        deltaX: 0,
        deltaY: Math.max(-240, Math.min(240, delta)),
        modifiers: 2,
      });
      if (Date.now() >= deadline) throw new Error(`camera never reached zoom ${zoom} (at ${cam.zoom})`);
      await page.waitForTimeout(80);
    }
    await cameraSettled(page);
  } finally {
    await cdp.detach();
  }
};

test("feed facts paint the GPU canvas: the loom's routes draw the wire, kind and spine cards are on the scene", async () => {
  test.setTimeout(300_000);
  const fixture = {
    ...galleryFixture,
    wires: [
      ...galleryFixture.wires,
      modelMessagesWire("feed-w1", "gal-agent-a", "gal-agent-b", galleryFixture.nodes),
    ],
  };
  const junto = await launchJunto({
    seedModels: { [CANVAS]: fixture },
    seedExperimentalFeatures: ["gpuCanvas"],
  });
  try {
    await canvasReady(junto.page);
    await junto.page
      .waitForFunction(() => typeof window.__juntoCanvas?.ready === "function", undefined, { timeout: 30_000 })
      .catch(() => undefined);
    await canvasReady(junto.page);
    const hooked = await junto.page.evaluate(() => typeof window.__juntoCanvas?.ready === "function");
    test.skip(!hooked, "window.__juntoCanvas absent — the GPU canvas is not in this build");

    // Every gallery card is on the engine's scene, feed facts included.
    const ids = await junto.page.evaluate(() => [...(window.__juntoCanvas?.cardIds() ?? [])]);
    for (const id of ["gal-agent-a", "gal-agent-b", "gal-terminal", "gal-task", "gal-peer", "gal-stub", "gal-git", "gal-link", "gal-file-doc"]) {
      expect(ids, `card ${id} on the GPU scene`).toContain(id);
    }

    // Frames are being drawn (the engine is live, not a static fallback).
    const stats = await junto.page.evaluate(() => window.__juntoCanvas?.stats());
    expect(stats?.frames ?? 0).toBeGreaterThan(0);

    await mkdir(OUT, { recursive: true });
    // The hook's own facts, so every clip below can be audited against them.
    const dump = await junto.page.evaluate(() => {
      const hook = window.__juntoCanvas;
      if (hook === undefined) return null;
      return {
        camera: hook.camera(),
        tier: hook.tier(),
        settled: hook.settled(),
        stats: hook.stats(),
        cards: Object.fromEntries(hook.cardIds().map((id) => [id, hook.rectOf(id) ?? null])),
      };
    });
    await writeFile(join(OUT, "hook.json"), JSON.stringify(dump, null, 2));

    // Fit view first: the whole board as the camera opened it.
    await junto.page.screenshot({ path: join(OUT, "01-fit-window.png") });
    const paneRect = await junto.page.evaluate(() => window.__juntoCanvas?.rectOf("") ?? null);
    if (paneRect !== null && paneRect !== undefined) {
      await junto.page.screenshot({
        path: join(OUT, "02-fit-pane.png"),
        clip: { x: paneRect.x, y: paneRect.y, width: paneRect.width, height: paneRect.height },
      });
    }

    // Then readable pixels: zoom to ~0.9 so cards and the wire between the
    // seats are inspectable.
    await zoomTo(junto.page, 0.9);
    await junto.page.screenshot({ path: join(OUT, "03-zoom-window.png") });
    const paneRect2 = await junto.page.evaluate(() => window.__juntoCanvas?.rectOf("") ?? null);
    if (paneRect2 !== null && paneRect2 !== undefined) {
      await junto.page.screenshot({
        path: join(OUT, "04-zoom-pane.png"),
        clip: { x: paneRect2.x, y: paneRect2.y, width: paneRect2.width, height: paneRect2.height },
      });
    }

    // The wire's own evidence: a clip spanning both seats and the cable
    // between their handles, plus one clip per interesting card.
    const a = await card(junto.page, "gal-agent-a").box();
    const b = await card(junto.page, "gal-agent-b").box();
    if (a !== null && b !== null) {
      const x = Math.min(a.x, b.x) - 80;
      const y = Math.min(a.y, b.y) - 80;
      const right = Math.max(a.x + a.width, b.x + b.width) + 80;
      const bottom = Math.max(a.y + a.height, b.y + b.height) + 80;
      await junto.page.screenshot({
        path: join(OUT, "05-wire.png"),
        clip: { x, y, width: right - x, height: bottom - y },
      });
    }
    for (const id of ["gal-agent-a", "gal-agent-b", "gal-terminal", "gal-peer", "gal-stub", "gal-task", "gal-link", "gal-git"]) {
      const rect = await card(junto.page, id).box();
      if (rect !== null) {
        await junto.page.screenshot({
          path: join(OUT, `card-${id}.png`),
          clip: { x: rect.x - 24, y: rect.y - 24, width: rect.width + 48, height: rect.height + 84 },
        });
      }
    }
  } finally {
    await junto.close();
  }
});
