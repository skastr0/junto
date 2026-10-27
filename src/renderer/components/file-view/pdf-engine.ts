/**
 * pdf.js behind one door, loaded only when a PDF opens: the library and its
 * worker are their own chunks, and the worker is served from the app's own
 * origin (the CSP allows `worker-src 'self' blob:`), never a CDN.
 */
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { cropOf, EXTRACT_SCALE, type ViewBox } from "./file-view-model";

GlobalWorkerOptions.workerSrc = workerUrl;

export type { PDFDocumentProxy, PDFPageProxy };

/** A page's size at zoom 1, in CSS pixels (one PDF point each). */
export type PageSize = { readonly width: number; readonly height: number };

export type LoadedPdf = {
  readonly doc: PDFDocumentProxy;
  /** Every page's size at zoom 1, read up front so the stack lays out before any page draws. */
  readonly sizes: ReadonlyArray<PageSize>;
  readonly close: () => void;
};

/**
 * Open a PDF at its `junto-file:` address (or from bytes, for the gallery). pdf.js reads it by ranges
 * when the protocol serves them. No form script in the PDF runs: XFA is off and
 * the app's CSP has no `unsafe-eval` either.
 */
export const loadPdf = async (source: string | Uint8Array): Promise<LoadedPdf> => {
  const task = getDocument(typeof source === "string" ? { url: source, enableXfa: false } : { data: source, enableXfa: false });
  try {
    const doc = await task.promise;
    const sizes: PageSize[] = [];
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      sizes.push({ width: viewport.width, height: viewport.height });
    }
    return { doc, sizes, close: () => void task.destroy() };
  } catch (error) {
    void task.destroy();
    throw error;
  }
};

/** A drawn page: cancel stops a render or a text layer still in flight. */
export type PageDraw = { readonly done: Promise<void>; readonly cancel: () => void };

/**
 * Draw one page at `zoom` into `canvas`, sharp at the screen's pixel ratio,
 * with its text layer in `textLayer` so the text selects and copies.
 */
export const drawPage = (page: PDFPageProxy, zoom: number, canvas: HTMLCanvasElement, textLayer: HTMLElement): PageDraw => {
  const ratio = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: zoom });
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  const render = page.render({
    canvas,
    viewport,
    ...(ratio === 1 ? {} : { transform: [ratio, 0, 0, ratio, 0, 0] }),
  });
  textLayer.replaceChildren();
  textLayer.style.setProperty("--total-scale-factor", String(zoom));
  const text = new TextLayer({ textContentSource: page.streamTextContent(), container: textLayer, viewport });
  return {
    done: Promise.all([render.promise, text.render()]).then(() => undefined),
    cancel: () => {
      render.cancel();
      text.cancel();
    },
  };
};

/**
 * The box on a page as PNG, rendered fresh from the PDF at twice the page's
 * own size: the extract is as sharp as the PDF, not as the screen was.
 */
export const renderPageBox = async (
  page: PDFPageProxy,
  box: ViewBox,
): Promise<{ readonly canvas: HTMLCanvasElement; readonly width: number; readonly height: number }> => {
  const base = page.getViewport({ scale: 1 });
  const crop = cropOf(box, base.width, base.height, EXTRACT_SCALE);
  const viewport = page.getViewport({ scale: crop.scale });
  const canvas = document.createElement("canvas");
  canvas.width = crop.w;
  canvas.height = crop.h;
  await page.render({ canvas, viewport, transform: [1, 0, 0, 1, -crop.x, -crop.y] }).promise;
  return { canvas, width: crop.w, height: crop.h };
};
