/**
 * Canvas raster scale: zoomed out, the board is rastered for the zoom it is
 * seen at, and the compositor never runs out of tile memory.
 *
 * The operator's flicker (blank rectangles inside regions, half-painted
 * fills, labels cut at tile edges, the pane's radial gradient showing through
 * as a ghost circle) was missing raster tiles. A permanent
 * `will-change: transform` on `.react-flow__viewport` pinned every layer
 * under the camera at raster scale 1 (it never lowers below native). At the
 * canvas's 0.15 minimum zoom that asks for about 44 times the pixels the
 * screen shows. On the operator's board, at DPR 2 and 1726x1083, the tile set
 * outgrew the GPU tile budget (852 MB). cc reported
 * `had_enough_memory_to_schedule_tiles_needed_now: false`, and whole tiles
 * were drawn as checkerboard, flapping as tile priorities moved.
 *
 * Every earlier check measured frame rate or main-thread time, at DPR 1, in a
 * small window; a checkerboarded frame still hits 120 fps. This reads cc's own
 * state instead, from a trace: the raster scale of every layer under the
 * camera against its ideal scale, the tile manager's memory verdicts, and the
 * checkerboard quads drawn during a zoomed-out pan. It runs at the operator's
 * DPR and window size, after a zoom in and back out, because a pinned raster
 * scale goes wrong only after the camera has been close.
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CanvasDoc, CanvasEdge, CanvasNode } from "../../src/shared/canvas";
import { agentTextNode, canvasDoc, textNode, verbEdge } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

/** Nested regions, two levels deep, dense with seats and notes, wired within and across. */
const buildBoard = (): CanvasDoc => {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  let seatIndex = 0;
  let previousTail: string | undefined;
  for (let r = 0; r < 6; r += 1) {
    const x = (r % 3) * 2_200;
    const y = Math.floor(r / 3) * 1_700;
    const outer = `rg-${r}`;
    nodes.push({ id: outer, type: "group", label: `region ${r + 1}`, x, y, width: 2_000, height: 1_500 });
    for (let s = 0; s < 2; s += 1) {
      const inner = `${outer}-sub${s}`;
      const ix = x + 40 + s * 980;
      const iy = y + 80;
      nodes.push({ id: inner, type: "group", label: `team ${r + 1}.${s + 1}`, x: ix, y: iy, width: 920, height: 1_360 });
      const members: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        const id = `${inner}-s${i}`;
        nodes.push({
          ...agentTextNode({ id, key: `local:raster-${seatIndex}`, label: `seat ${seatIndex}`, x: 0, y: 0 }),
          x: ix + 30 + (i % 2) * 440,
          y: iy + 60 + Math.floor(i / 2) * 250,
        });
        seatIndex += 1;
        members.push(id);
      }
      nodes.push(textNode(`${inner}-note`, `notes for team ${r + 1}.${s + 1}\n\n- plan\n- review\n- ship`, ix + 30, iy + 1_120));
      for (let i = 0; i < members.length - 1; i += 1) {
        edges.push(verbEdge(`e-${inner}-${i}`, members[i]!, members[i + 1]!, "messages", nodes));
      }
      if (previousTail) edges.push(verbEdge(`e-x-${inner}`, previousTail, members[0]!, "messages", nodes));
      previousTail = members[members.length - 1];
    }
  }
  return canvasDoc(nodes, edges);
};

test.use({
  juntoOptions: {
    seedCanvases: { raster: buildBoard() },
    electronArgs: ["--force-device-scale-factor=2"],
  },
});

type TraceEvent = {
  readonly name?: string;
  readonly args?: Record<string, unknown>;
};
type SnapshotLayer = {
  readonly layer_name?: string;
  readonly draws_content?: number | boolean;
  readonly ideal_contents_scale?: number;
  readonly raster_scales?: { readonly contents_scale?: readonly number[] };
};

test("zoomed out, the board rasters at the zoom it is seen at, within tile memory", async ({ junto }) => {
  test.setTimeout(180_000);
  const { app, page } = junto;
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1726, 1083);
  });
  await expect(page.locator(".react-flow__node-group")).toHaveCount(18, { timeout: 30_000 });
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);

  const pane = await page.locator(".react-flow").boundingBox();
  if (!pane) throw new Error("canvas has no box");
  const cx = pane.x + pane.width / 2;
  const cy = pane.y + pane.height / 2 - 100;
  const wheel = (deltaX: number, deltaY: number, ctrlKey: boolean) =>
    page.evaluate(
      (event) => {
        document.querySelector(".react-flow__pane")?.dispatchEvent(
          new WheelEvent("wheel", { ...event, bubbles: true, cancelable: true }),
        );
      },
      { clientX: cx, clientY: cy, deltaX, deltaY, ctrlKey },
    );
  const zoom = () =>
    page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a);

  // Close first (a pinned scale is set by the closest raster), then all the way out.
  for (let i = 0; i < 40; i += 1) await wheel(0, -40, true);
  await page.waitForTimeout(1_500);
  expect(await zoom()).toBeGreaterThan(1);
  for (let i = 0; i < 80; i += 1) await wheel(0, 40, true);
  await page.waitForTimeout(2_000);
  const far = await zoom();
  expect(far).toBeLessThan(0.2);

  await app.evaluate(async ({ contentTracing }) => {
    await contentTracing.startRecording({ included_categories: ["cc", "disabled-by-default-cc.debug"] });
  });
  // A zoomed-out pan across the board, then rest.
  for (let i = 0; i < 120; i += 1) {
    const dir = Math.floor(i / 30) % 2 === 0 ? 1 : -1;
    await wheel(30 * dir, 12 * dir, false);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(1_500);
  await mkdir(test.info().outputDir, { recursive: true });
  const tracePath = await app.evaluate(
    async ({ contentTracing }, path) => contentTracing.stopRecording(path),
    join(test.info().outputDir, "raster-trace.json"),
  );
  const raw = JSON.parse(await readFile(tracePath, "utf8")) as { traceEvents?: TraceEvent[] } | TraceEvent[];
  const events = Array.isArray(raw) ? raw : (raw.traceEvents ?? []);

  const starved = events.filter(
    (e) =>
      e.name === "TileManager::AssignGpuMemoryToTiles" &&
      e.args?.["had_enough_memory_to_schedule_tiles_needed_now"] === false,
  ).length;
  const missingTiles = events
    .filter((e) => e.name === "TileBasedLayerImpl::AppendQuads checkerboard")
    .reduce((sum, e) => sum + Number(e.args?.["missing_tile_count"] ?? 0), 0);

  // The last full layer tree: every drawing layer under the camera (ideal
  // scale below native) must raster near its ideal, not pinned above it.
  const snapshots = events.filter((e) => {
    const tree = (e.args?.["snapshot"] as { active_tree?: { layers?: unknown[] } } | undefined)?.active_tree;
    return e.name === "LayerTreeHostImpl:snapshot" && (tree?.layers?.length ?? 0) > 5;
  });
  expect(snapshots.length, "the trace carries cc layer snapshots").toBeGreaterThan(0);
  const layers = (
    snapshots[snapshots.length - 1]!.args!["snapshot"] as { active_tree: { layers: SnapshotLayer[] } }
  ).active_tree.layers;
  const underCamera = layers.filter(
    (l) => Boolean(l.draws_content) && (l.ideal_contents_scale ?? 1) < 0.5,
  );
  expect(underCamera.length, "layers under the zoomed-out camera").toBeGreaterThan(0);
  const pinned = underCamera
    .map((l) => ({
      layer: (l.layer_name ?? "").slice(0, 80),
      ideal: +(l.ideal_contents_scale ?? 0).toFixed(3),
      raster: +(l.raster_scales?.contents_scale?.[0] ?? 0).toFixed(3),
    }))
    .filter((l) => l.raster > Math.max(l.ideal * 2, l.ideal + 0.05));

  console.log(
    `RASTER-SCALE ${JSON.stringify({ zoom: far, layers: layers.length, underCamera: underCamera.length, pinned: pinned.length, starved, missingTiles })}`,
  );
  expect(
    pinned.slice(0, 5),
    `${String(pinned.length)} of ${String(underCamera.length)} layers rastered far above the zoom they are seen at`,
  ).toEqual([]);
  expect(starved, "tile manager assigns without memory for the tiles needed now").toBe(0);
  // A few late tiles in a fast pan are raster physics; a starved budget is thousands.
  expect(missingTiles, "checkerboarded tiles drawn during a zoomed-out pan").toBeLessThan(40);
});
