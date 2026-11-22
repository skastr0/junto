/**
 * OffscreenCanvas raster worker (#911): rasterizes text runs (with true-ink
 * coverage and halo blur) and lucide glyphs off the main thread, transferring
 * the resulting ImageBitmap back with zero copy so background/prefetch rasters
 * never stall a frame. `ensureNow()` stays on the main thread as last resort.
 */

import { gpuColorCss, type GpuColor } from "@shared/theme";
import type { TextRun } from "../contract";
import { drawGlyph } from "./glyphs";
import { fontCss, HALO_SIGMA_PER_RADIUS, haloPadDevice, layoutRun, type MeasureContext } from "./text";

export type WorkerFontSpec = {
  readonly family: string;
  readonly source: string;
  readonly descriptors?: FontFaceDescriptors;
};

export type RasterWorkerRequest =
  | { readonly kind: "fonts"; readonly fonts: ReadonlyArray<WorkerFontSpec> }
  | { readonly kind: "text"; readonly id: number; readonly run: TextRun; readonly scale: number; readonly ink: GpuColor }
  | { readonly kind: "glyph"; readonly id: number; readonly name: string; readonly width: number; readonly height: number; readonly ink: GpuColor };

export type RasterWorkerResponse =
  | { readonly id: number; readonly ok: true; readonly bitmap: ImageBitmap }
  | { readonly id: number; readonly ok: true; readonly coverage: Uint8Array; readonly width: number; readonly height: number }
  | { readonly id: number; readonly ok: false; readonly error: string };

let measureCanvas: OffscreenCanvas | undefined;
let measureCtx: OffscreenCanvasRenderingContext2D | undefined;
let drawCanvas: OffscreenCanvas | undefined;
let drawCtx: OffscreenCanvasRenderingContext2D | undefined;
let sharpCanvas: OffscreenCanvas | undefined;
let sharpCtx: OffscreenCanvasRenderingContext2D | undefined;

const getMeasure = (): OffscreenCanvasRenderingContext2D => {
  if (measureCtx === undefined) {
    measureCanvas = new OffscreenCanvas(8, 8);
    measureCtx = measureCanvas.getContext("2d")!;
  }
  return measureCtx;
};

const getDraw = (w: number, h: number): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } => {
  const cw = Math.max(1, Math.ceil(w));
  const ch = Math.max(1, Math.ceil(h));
  if (drawCanvas === undefined || drawCtx === undefined) {
    drawCanvas = new OffscreenCanvas(cw, ch);
    drawCtx = drawCanvas.getContext("2d")!;
  } else if (drawCanvas.width !== cw || drawCanvas.height !== ch) {
    drawCanvas.width = cw;
    drawCanvas.height = ch;
  } else {
    drawCtx.clearRect(0, 0, cw, ch);
  }
  return { canvas: drawCanvas, ctx: drawCtx };
};

const getSharp = (w: number, h: number): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } => {
  const cw = Math.max(1, Math.ceil(w));
  const ch = Math.max(1, Math.ceil(h));
  if (sharpCanvas === undefined || sharpCtx === undefined) {
    sharpCanvas = new OffscreenCanvas(cw, ch);
    sharpCtx = sharpCanvas.getContext("2d")!;
  } else if (sharpCanvas.width !== cw || sharpCanvas.height !== ch) {
    sharpCanvas.width = cw;
    sharpCanvas.height = ch;
  } else {
    sharpCtx.clearRect(0, 0, cw, ch);
  }
  return { canvas: sharpCanvas, ctx: sharpCtx };
};

const extractAlpha = (ctx: OffscreenCanvasRenderingContext2D, w: number, h: number): Uint8Array => {
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = rgba[i * 4 + 3]!;
  return alpha;
};

const rasterTextCoverage = (run: TextRun, scale: number, ink: GpuColor): { readonly coverage: Uint8Array; readonly width: number; readonly height: number } => {
  const mctx = getMeasure();
  const measure: MeasureContext = mctx;
  mctx.font = fontCss(run, scale);
  mctx.letterSpacing = run.tracking !== undefined ? `${run.tracking}em` : "0px";
  const lines = layoutRun(run, Math.max(1, run.width * scale), (t) => measure.measureText(t).width);
  const lineHeight = run.size * scale * (run.leading ?? 1.2);
  const pad = run.blur === undefined ? 0 : haloPadDevice(scale);
  const cellW = Math.max(1, Math.ceil(run.width * scale) + 2 * pad);
  const cellH = Math.max(1, Math.ceil(lineHeight * lines.length) + 2 * pad);
  const { ctx: draw } = getDraw(cellW, cellH);
  draw.font = mctx.font;
  draw.letterSpacing = mctx.letterSpacing;
  const paint = gpuColorCss({ ...ink, a: 1 });
  draw.fillStyle = paint;
  draw.textBaseline = "middle";
  const textWidth = cellW - 2 * pad;
  const glyphX = (target: OffscreenCanvasRenderingContext2D, line: string): number => {
    const x = run.align === "center" ? (textWidth - target.measureText(line).width) / 2 : 0;
    return x + pad;
  };
  if (run.blur === undefined) {
    lines.forEach((line, i) => {
      draw.fillText(line, glyphX(draw, line), pad + lineHeight * i + lineHeight / 2);
    });
    return { coverage: extractAlpha(draw, cellW, cellH), width: cellW, height: cellH };
  }
  const sharp = getSharp(cellW, cellH);
  sharp.ctx.font = draw.font;
  sharp.ctx.letterSpacing = draw.letterSpacing;
  sharp.ctx.fillStyle = paint;
  sharp.ctx.textBaseline = "middle";
  lines.forEach((line, i) => {
    sharp.ctx.fillText(line, glyphX(sharp.ctx, line), pad + lineHeight * i + lineHeight / 2);
  });
  draw.filter = `blur(${run.blur * scale * HALO_SIGMA_PER_RADIUS}px)`;
  draw.drawImage(sharp.canvas, 0, 0);
  draw.drawImage(sharp.canvas, 0, 0);
  draw.filter = "none";
  return { coverage: extractAlpha(draw, cellW, cellH), width: cellW, height: cellH };
};

const rasterGlyph = (name: string, width: number, height: number, ink: GpuColor): ImageBitmap => {
  const { canvas, ctx } = getDraw(width, height);
  const side = Math.min(canvas.width, canvas.height);
  ctx.save();
  ctx.translate((canvas.width - side) / 2, (canvas.height - side) / 2);
  drawGlyph(ctx as unknown as CanvasRenderingContext2D, name, side, ink);
  ctx.restore();
  return canvas.transferToImageBitmap();
};

const loadWorkerFonts = async (fonts: ReadonlyArray<WorkerFontSpec>): Promise<void> => {
  const fontSet = (self as unknown as { readonly fonts?: { add(face: FontFace): void } }).fonts;
  if (fontSet === undefined || typeof FontFace !== "function") return;
  await Promise.all(
    fonts.map(async (spec) => {
      try {
        const face = new FontFace(spec.family, spec.source, spec.descriptors);
        const loaded = await face.load();
        fontSet.add(loaded);
      } catch {
        // System fallback stack still applies.
      }
    }),
  );
};

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<RasterWorkerRequest>) => void) | null;
  postMessage(message: RasterWorkerResponse, transfer?: Transferable[]): void;
};

if (typeof scope !== "undefined" && typeof OffscreenCanvas !== "undefined") {
  scope.onmessage = (event: MessageEvent<RasterWorkerRequest>) => {
    const msg = event.data;
    if (msg.kind === "fonts") {
      void loadWorkerFonts(msg.fonts);
      return;
    }
    try {
      if (msg.kind === "text") {
        const { coverage, width, height } = rasterTextCoverage(msg.run, msg.scale, msg.ink);
        scope.postMessage({ id: msg.id, ok: true, coverage, width, height }, [coverage.buffer]);
      } else {
        const bitmap = rasterGlyph(msg.name, msg.width, msg.height, msg.ink);
        scope.postMessage({ id: msg.id, ok: true, bitmap }, [bitmap]);
      }
    } catch (error) {
      scope.postMessage({ id: msg.id, ok: false, error: String(error) });
    }
  };
}
