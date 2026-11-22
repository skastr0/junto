/**
 * The canvas minimap draws what the SVG minimap drew (issue 912).
 *
 * The map's cards and dots moved from one SVG child each to one 2D canvas
 * drawn in a worker. The SVG is gone at this commit, so the reference is
 * rebuilt in the page from the very map the canvas last drew (the test hook's
 * `minimapDrawn`): the same rectangles, colours, viewBox, corner radius and
 * stroke widths, with the SVG's own crispEdges rectangles and circles. Both
 * are shot over the same panel, and no pixel may differ by more than 4 levels
 * in any channel: the canvas keeps 8-bit premultiplied pixels and antialiases
 * a rounded corner its own way, which no one can see and the operator's lead
 * accepted (0 was never reachable). A blank shot guards against a vacuous pass.
 *
 * Board: the gate's proof board at 1x, from a COPY of a Junto database
 * (JUNTO_FACTORY_DB) or a saved fixture (JUNTO_FACTORY_JSON), seeded by the
 * harness like the GPU proof.
 *   JUNTO_FACTORY_DB=/tmp/junto-factory.db scripts/run-e2e.sh e2e/scenarios/minimap-parity.spec.ts
 * Receipt: /tmp/junto-minimap-parity/<head>.json and the three shots beside it.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { buildProofBoard, launchProofArm, loadFactoryBoard, loadFactoryFixture, settleAtlas, waitGpuReady } from "../harness/gpu-proof";

type PngImage = { readonly width: number; readonly height: number; readonly data: Buffer };
const { PNG } = createRequire(import.meta.url)("pngjs") as { readonly PNG: { readonly sync: { read(buf: Buffer): PngImage } } };

const DB = process.env["JUNTO_FACTORY_DB"] ?? "";
const JSON_FIXTURE = process.env["JUNTO_FACTORY_JSON"] ?? "";
const OUT = "/tmp/junto-minimap-parity";
/** The most any channel may differ, in 8-bit levels. */
const MAX_LEVELS = 4;

test.skip(DB === "" && JSON_FIXTURE === "", "set JUNTO_FACTORY_DB=<copy of junto.db> or JUNTO_FACTORY_JSON=<saved fixture>");

type Diff = { readonly differ: number; readonly max: number; readonly byLevel: Record<string, number> };

const diff = (a: Buffer, b: Buffer): Diff => {
  const left = PNG.sync.read(a);
  const right = PNG.sync.read(b);
  expect([right.width, right.height]).toEqual([left.width, left.height]);
  let differ = 0;
  let max = 0;
  const byLevel: Record<string, number> = {};
  for (let i = 0; i < left.data.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c += 1) d = Math.max(d, Math.abs(left.data[i + c]! - right.data[i + c]!));
    if (d === 0) continue;
    differ += 1;
    max = Math.max(max, d);
    const level = d > 8 ? ">8" : String(d);
    byLevel[level] = (byLevel[level] ?? 0) + 1;
  }
  return { differ, max, byLevel };
};

test("the canvas minimap matches the SVG minimap it replaced, to 4 levels", async () => {
  test.setTimeout(400_000);
  mkdirSync(OUT, { recursive: true });
  const head = execSync("git rev-parse --short=9 HEAD").toString().trim();
  const fixture = DB !== "" ? loadFactoryBoard(DB).fixture : loadFactoryFixture(JSON_FIXTURE);
  const board = buildProofBoard(fixture, 1);
  const handle = await launchProofArm(board, { gpu: true });
  try {
    const page = handle.page;
    await waitGpuReady(page, board);
    await settleAtlas(page);
    const map = page.getByTestId("rf__minimap");
    await expect
      .poll(() => page.evaluate(() => (window as any).__juntoCanvas?.minimapDrawn?.()?.map.count ?? 0), { timeout: 30_000 })
      .toBeGreaterThan(0);
    // The worker draws in its next frame: give it a few.
    await page.waitForTimeout(1_000);
    const canvasShot = await map.screenshot({ animations: "disabled" });

    const drawn = await page.evaluate(() => {
      const hook = (window as any).__juntoCanvas;
      const got = hook.minimapDrawn() as {
        map: { count: number; boxes: Float64Array; kinds: Uint8Array; fills: Uint16Array; strokes: Uint16Array; palette: string[] };
        paint: { box: { x: number; y: number; width: number; height: number }; unit: number; strokeWidth: number; radius: number };
      };
      const { map, paint } = got;
      const panel = document.querySelector<HTMLElement>("[data-testid=rf__minimap]")!;
      const canvas = panel.querySelector<HTMLCanvasElement>(".junto-minimap-canvas")!;
      const NS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("data-minimap-reference", "");
      svg.setAttribute("viewBox", `${String(paint.box.x)} ${String(paint.box.y)} ${String(paint.box.width)} ${String(paint.box.height)}`);
      svg.setAttribute("style", "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none");
      // The SVG's order: cards, then seats over them (FactoryMinimap at 2835d649d).
      for (let i = 0; i < map.count; i += 1) {
        if (map.kinds[i] !== 0) continue;
        const rect = document.createElementNS(NS, "rect");
        rect.setAttribute("x", String(map.boxes[i * 4]));
        rect.setAttribute("y", String(map.boxes[i * 4 + 1]));
        rect.setAttribute("width", String(map.boxes[i * 4 + 2]));
        rect.setAttribute("height", String(map.boxes[i * 4 + 3]));
        rect.setAttribute("rx", String(paint.radius));
        rect.setAttribute("ry", String(paint.radius));
        rect.setAttribute("shape-rendering", "crispEdges");
        rect.style.fill = map.palette[map.fills[i]!]!;
        rect.style.stroke = map.palette[map.strokes[i]!]!;
        rect.style.strokeWidth = String(paint.strokeWidth);
        svg.appendChild(rect);
      }
      for (let i = 0; i < map.count; i += 1) {
        const kind = map.kinds[i]!;
        if (kind === 0) continue;
        const w = map.boxes[i * 4 + 2]!;
        const h = map.boxes[i * 4 + 3]!;
        const circle = document.createElementNS(NS, "circle");
        circle.setAttribute("cx", String(map.boxes[i * 4]! + w / 2));
        circle.setAttribute("cy", String(map.boxes[i * 4 + 1]! + h / 2));
        circle.setAttribute("r", String(Math.max(Math.min(w, h) / 2, (kind === 2 ? 3 : 2.2) * paint.unit)));
        circle.style.fill = map.palette[map.fills[i]!]!;
        circle.style.stroke = map.palette[map.strokes[i]!]!;
        circle.style.strokeWidth = String(0.8 * paint.unit);
        svg.appendChild(circle);
      }
      canvas.after(svg);
      const box = (el: Element) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
      (window as any).__minimapGeometry = { panel: box(panel), canvas: box(canvas), backing: [canvas.width, canvas.height], svg: box(svg) };
      canvas.style.visibility = "hidden";
      return { count: map.count, cards: [...map.kinds].filter((kind) => kind === 0).length, paint };
    });
    await page.waitForTimeout(300);
    const svgShot = await map.screenshot({ animations: "disabled" });

    // Neither: the panel alone, so a pass must have drawn something.
    await page.evaluate(() => {
      document.querySelector<SVGElement>("[data-minimap-reference]")!.style.visibility = "hidden";
    });
    await page.waitForTimeout(300);
    const blankShot = await map.screenshot({ animations: "disabled" });
    await page.evaluate(() => {
      document.querySelector("[data-minimap-reference]")?.remove();
      document.querySelector<HTMLCanvasElement>("[data-testid=rf__minimap] .junto-minimap-canvas")!.style.visibility = "";
    });

    writeFileSync(join(OUT, `${head}-canvas.png`), canvasShot);
    writeFileSync(join(OUT, `${head}-svg.png`), svgShot);
    writeFileSync(join(OUT, `${head}-blank.png`), blankShot);
    const parity = diff(canvasShot, svgShot);
    const drawnInk = diff(svgShot, blankShot);
    const receipt = { head, geometry: await page.evaluate(() => (window as any).__minimapGeometry), drawn, ratio: await page.evaluate(() => devicePixelRatio), parity, drawnInk: { differ: drawnInk.differ } };
    writeFileSync(join(OUT, `${head}.json`), JSON.stringify(receipt, null, 2));
    console.log("MINIMAP", JSON.stringify(receipt));

    expect(drawn.count, "the minimap drew no cards or seats").toBeGreaterThan(0);
    expect(drawnInk.differ, "the reference drew nothing over the panel").toBeGreaterThan(drawn.count);
    expect(parity.max, `canvas against SVG: ${JSON.stringify(parity)}`).toBeLessThanOrEqual(MAX_LEVELS);
  } finally {
    await handle.close();
  }
});
