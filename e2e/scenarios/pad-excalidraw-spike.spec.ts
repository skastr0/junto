/**
 * The Excalidraw pad spike, in the real app (dev pad engine switch): cold
 * open, feel (tool switch, freehand, text, pan, zoom) measured from input to
 * the frame after, an operator drawing that becomes a pad version, an agent
 * patch that lands in the scene, a seat card, a pasted image and an area
 * comment, in both themes.
 *
 *   bun run test:e2e:fast e2e/scenarios/pad-excalidraw-spike.spec.ts
 *
 * Writes test-results/pad-excalidraw-spike/report.json and screenshots.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { mentionHref } from "../../src/shared/mention";
import { asNodeId, Node } from "../../src/shared/model";
import { mintOpId } from "../../src/shared/resource-command";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";

const CANVAS = "pad-spike";
const OUT = "test-results/pad-excalidraw-spike";
/** Seats behind the modal: the lag grows with the canvas, so measure where it shows. */
const SEATS = Number(process.env.SPIKE_SEATS ?? 80);

const frameAfter = async (page: Page, run: () => Promise<void>): Promise<number> => {
  const t0 = await page.evaluate(() => performance.now());
  await run();
  const t1 = await page.evaluate(
    () => new Promise<number>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())))),
  );
  return t1 - t0;
};

const stats = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { n: sorted.length, p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), max: Math.round(sorted.at(-1) ?? 0) };
};

const shot = async (page: Page, name: string) => {
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
};

test("pad on Excalidraw: feel, our data both ways, card, image, area comment", async () => {
  test.setTimeout(300_000);
  const scout = modelSeat({ id: "scout", key: "local:spike-scout", label: "Scout", harness: "codex", x: 40, y: 300 });
  const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({
    kind: "artifacts",
    id: "shelf",
    label: "Shelf",
    x: 40,
    y: 40,
    width: 280,
    height: 160,
    z: 0,
  });
  const crowd = Array.from({ length: Math.max(0, SEATS - 1) }, (_, i) =>
    modelSeat({ id: `s${i}`, key: `local:spike-${i}`, label: `Seat ${i}`, x: 400 + (i % 10) * 260, y: 300 + Math.floor(i / 10) * 160 }),
  );
  const region = modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 3200, height: 1800 });
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([region, shelf, scout, ...crowd], []) } });
  try {
    const { page } = junto;
    const report: Record<string, unknown> = { seats: SEATS };
    const card = page.locator('.react-flow__node[data-id="shelf"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.dblclick();
    await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "New artifact" }).click();
    await page.getByRole("group", { name: "New artifact" }).locator("button").filter({ hasText: "Pad" }).click();
    const meta = page.locator(".artifact-head__meta");
    await expect(meta).toHaveText("Pad, version 1", { timeout: 15_000 });

    // Cold open: the switch to the first drawn frame, chunk load included.
    const t0 = await page.evaluate(() => performance.now());
    await page.getByTestId("pad-engine-excalidraw").click();
    await expect(page.locator(".excalidraw canvas").first()).toBeVisible({ timeout: 20_000 });
    report.coldOpenMs = Math.round((await page.evaluate(() => performance.now())) - t0);
    const resources = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .filter((entry) => /ExcalidrawPad|excalidraw/i.test(entry.name))
        .map((entry) => ({ name: entry.name.split("/").pop(), ms: Math.round(entry.duration), bytes: (entry as PerformanceResourceTiming).decodedBodySize })),
    );
    report.chunks = resources;
    await shot(page, "01-empty-dark");

    const canvas = page.locator(".excalidraw .excalidraw__canvas.interactive");
    const box = (await canvas.boundingBox())!;
    // Excalidraw's properties panel covers the left of the canvas: draw right of it.
    const at = (x: number, y: number) => ({ x: box.x + 380 + x, y: box.y + y });

    // Tool switch by key, as the operator does.
    await canvas.click({ position: { x: box.width - 40, y: box.height - 40 } });
    const toolMs: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      for (const key of ["r", "o", "a", "t", "p", "v"]) {
        toolMs.push(await frameAfter(page, () => page.keyboard.press(key)));
        if (key === "t") await page.keyboard.press("Escape");
      }
    }
    report.toolSwitch = stats(toolMs);

    // A box: drawn, then a version.
    await page.keyboard.press("r");
    let p = at(120, 120);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + 160, p.y + 90, { steps: 8 });
    report.boxRelease = Math.round(await frameAfter(page, () => page.mouse.up()));
    await expect(meta).toHaveText("Pad, version 2", { timeout: 10_000 });

    // Freehand: each move to the next frame.
    await page.keyboard.press("p");
    const inkMs: number[] = [];
    p = at(120, 300);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    for (let step = 1; step <= 60; step += 1) {
      inkMs.push(await frameAfter(page, () => page.mouse.move(p.x + step * 6, p.y + Math.sin(step / 4) * 20)));
    }
    await page.mouse.up();
    report.freehandMove = stats(inkMs);
    await expect(meta).toHaveText("Pad, version 3", { timeout: 10_000 });

    // Text: each key to the next frame.
    await page.keyboard.press("t");
    p = at(420, 120);
    await page.mouse.click(p.x, p.y);
    const typeMs: number[] = [];
    for (const ch of "ship the pad") typeMs.push(await frameAfter(page, () => page.keyboard.type(ch)));
    await page.keyboard.press("Escape");
    report.textKey = stats(typeMs);
    await expect(meta).toHaveText("Pad, version 4", { timeout: 10_000 });

    // Pan (two-finger scroll is a wheel without Ctrl) and zoom (pinch is Ctrl+wheel).
    await page.keyboard.press("v");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const panMs: number[] = [];
    for (let i = 0; i < 20; i += 1) panMs.push(await frameAfter(page, () => page.mouse.wheel(14, 10)));
    report.pan = stats(panMs);
    const zoomMs: number[] = [];
    await page.keyboard.down("Control");
    for (let i = 0; i < 10; i += 1) zoomMs.push(await frameAfter(page, () => page.mouse.wheel(0, -8)));
    await page.keyboard.up("Control");
    report.zoom = stats(zoomMs);
    report.zoomAfter = await page.evaluate(() => document.querySelector(".excalidraw")?.textContent?.match(/\d+%/u)?.[0]);

    // What the operator drew, read as an agent reads the pad.
    const readPad = () =>
      page.evaluate(
        async ({ canvas, node }) => {
          const api = window.junto!.resource!.artifact!;
          const heads = await api.list(canvas, node);
          const head = heads.find((h) => h.artifact.type === "pad")!;
          const body = await api.body(canvas, head.artifact.artifactId, head.artifact.version);
          return { id: head.artifact.artifactId, version: head.artifact.version, body };
        },
        { canvas: CANVAS, node: asNodeId("shelf") },
      );
    const drawn = await readPad();
    report.operatorWrote = drawn.body;

    // An agent's patch: a triangle with a status, an edge to the operator's box, and a seat card.
    const pad = (drawn.body as { pad: { shapes: ReadonlyArray<{ id: string; type: string }> } }).pad;
    const boxId = pad.shapes.find((shape) => shape.type === "box")!.id;
    const seatHref = mentionHref({ kind: "seat", nodeId: asNodeId("scout") }, CANVAS);
    const landed = await page.evaluate(
      ({ canvas, node, id, version, boxId, seatHref, opId }) =>
        window.junto!.resource!.artifact!.apply(canvas, node, id as never, opId, {
          op: "edit",
          edit: {
            kind: "patch",
            type: "pad",
            baseVersion: version,
            patches: [
              { op: "upsert", layer: "shape", shape: { id: "agent-tri", type: "triangle", x: 120, y: 420, w: 120, h: 100, z: 50, status: "blocked" } },
              { op: "upsert", layer: "shape", shape: { id: "agent-box", type: "box", x: 600, y: 300, w: 160, h: 70, z: 51, text: "Agent step", status: "active" } },
              { op: "upsert", layer: "edge", edge: { id: "agent-edge", from: boxId, to: "agent-box", label: "then" } },
              { op: "upsert", layer: "shape", shape: { id: "agent-card", type: "box", x: 600, y: 420, w: 280, h: 120, z: 52, text: seatHref } },
            ],
          },
        } as never),
      { canvas: CANVAS, node: asNodeId("shelf"), id: drawn.id, version: drawn.version, boxId, seatHref, opId: mintOpId() },
    );
    report.agentPatch = landed;
    await expect(meta).toHaveText("Pad, version 5", { timeout: 10_000 });
    await expect(page.getByTestId("pad-card")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: /fit|zoom to fit/i }).first().click().catch(() => undefined);
    await page.keyboard.press("Shift+1");
    await shot(page, "02-agent-patch-and-card-dark");
    // The agent's write must not echo back as a new version.
    await page.waitForTimeout(800);
    await expect(meta).toHaveText("Pad, version 5");

    // A pasted image: stored as content, then a version.
    await junto.app.evaluate(({ clipboard, nativeImage }) => {
      const png = nativeImage.createFromDataURL(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVR4nGP8z8DwnwEJMDIwMjKgAiYGBgYGJgYGBhb+Dwz/GRhYmBgYGBj+MzAwMAAAzk0FEZsdu5gAAAAASUVORK5CYII=",
      );
      clipboard.writeImage(png);
    });
    await canvas.click({ position: { x: box.width - 60, y: 60 } });
    await page.keyboard.press("Meta+V");
    await expect(meta).toHaveText("Pad, version 6", { timeout: 15_000 });
    const withImage = await readPad();
    report.imageStored = (withImage.body as { pad: { images: ReadonlyArray<unknown> } }).pad.images;

    // An area comment: the overlay picks a box, the rail opens on it.
    await page.getByTestId("excalidraw-pad-area").click();
    const layer = page.getByTestId("excalidraw-pad-area-layer");
    const lb = (await layer.boundingBox())!;
    await page.mouse.move(lb.x + 200, lb.y + 200);
    await page.mouse.down();
    await page.mouse.move(lb.x + 360, lb.y + 300, { steps: 6 });
    await page.mouse.up();
    await expect(page.getByText(/On Area at/u)).toBeVisible({ timeout: 10_000 });
    await shot(page, "03-area-comment-dark");

    // Bright theme: our tokens, no inversion.
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "bright" } }));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
    await shot(page, "04-bright");
    await page.waitForTimeout(800);
    report.versionAfterTheme = await meta.textContent();

    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
    console.log("SPIKE", JSON.stringify(report));
  } finally {
    await junto.close();
  }
});
