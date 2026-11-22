import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import type { MinimapRect, MinimapSource } from "../canvas/shell/minimap-source";
import type { Urgency } from "../lib/region-urgency";
import { unseenRef } from "../lib/unseen";
import { drawMap, SEAT_DOT_PX, URGENT_DOT_PX, type MapPaint, type MinimapWorkerMessage, type PackedMap } from "./minimap-draw";
import "./factory-minimap.css";

/**
 * The strategic minimap, drawn so that a pan costs one attribute write.
 *
 * React Flow's <MiniMap> selects the store transform, so every viewport change
 * re-rendered the component, rewrote the SVG viewBox (which re-lays out and
 * repaints every node rectangle) and re-ran one store selector per node.
 * Measured on the live board: about 45% of what a pan still cost the main
 * thread after the viewport itself was taken off it.
 *
 * The map reads a `MinimapSource` (canvas/shell/minimap-source.ts): rectangles,
 * their changes, the camera and the camera's changes. Both canvases implement
 * it while both exist, so the same map sits beside either canvas and touches
 * no store. Node rectangles are React state that changes only when the scene
 * changes (position, size, hidden, colour inputs). The camera is applied
 * imperatively: a subscription rewrites the mask path on viewport changes and
 * touches the viewBox only when the camera leaves the node bounds. Pan and
 * zoom on the map call the source's camera; the canvas does the easing.
 *
 * The mask write is the map's whole remaining cost, and it is not cheap: an
 * SVG path rewrite re-lays out the drawing, and a layout marks the document
 * dirty, so one write drags a style, layout, paint and layerize pass through
 * the frame — measured at about a third of the main-thread cost of a pan on
 * the live board. The map is small and the camera window inside it is smaller,
 * so a pan step of a few screen pixels usually moves the window by a fraction
 * of a map pixel. Those writes are skipped: the window is redrawn only when it
 * would land on a different pixel of the map, so nothing the operator can see
 * is dropped.
 *
 * The cards and dots draw into one 2D canvas under the SVG, not one SVG child
 * per card: at 100x a child per card was 45,201 children of one svg, which
 * React placed one at a time (10 s of commit, issue 912). The canvas is
 * redrawn when the rectangles, their colours, the theme, the viewBox or the
 * map's size change, never on a pan, and a click finds its card through a
 * grid of the rectangles. The SVG keeps the camera mask and the pointer.
 * The draw itself runs in a worker on the canvas's OffscreenCanvas
 * (minimap-worker.ts): at 100x it is some 35,000 paths, 62 ms, which held a
 * frame of the window's each time the map changed. Batching them by colour
 * cannot keep the SVG's pixels: a card's stroke under the next card's fill,
 * and 25,300 seat dots that overlap in 5,345 layers at 100x, need the order.
 *
 * Agents are dots with a size floor in map pixels, so a seat reads at any
 * board size; a seat that is blocked, needs the operator or has work for
 * review wears a ring in that state's colour, and blocked and needs-you seats
 * ping on the attention clock (factory-minimap.css), drawn above the camera
 * mask so a glance at the map finds them anywhere on the board.
 *
 * The pings are HTML, not SVG: Chromium cannot composite an animation on an
 * SVG child, so SVG pings restyled and re-laid out the map on the main thread
 * every frame (2549 layouts in 29.5 s on a nested board). They sit in a layer
 * over the map that carries the viewBox's own placement as one transform,
 * written with the viewBox, so each ping is placed in flow units like the dot
 * it rings and animates transform and opacity only.
 */

type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

export type MinimapNodeRect = Rect & {
  readonly id: string;
  readonly fill: string;
  readonly stroke: string;
  readonly seat?: SeatMark;
};

/** Two lists of rectangles that draw the same map. */
export const sameRects = (
  before: ReadonlyArray<MinimapNodeRect> | undefined,
  after: ReadonlyArray<MinimapNodeRect>,
): boolean =>
  before !== undefined &&
  before.length === after.length &&
  after.every((rect, index) => {
    const was = before[index]!;
    return (
      was.id === rect.id &&
      was.x === rect.x &&
      was.y === rect.y &&
      was.width === rect.width &&
      was.height === rect.height &&
      was.fill === rect.fill &&
      was.stroke === rect.stroke &&
      was.seat?.urgency === rect.seat?.urgency &&
      (was.seat === undefined) === (rect.seat === undefined)
    );
  });

/** An agent seat on the map: its urgency, if any. */
export type SeatMark = { readonly urgency?: Urgency };

/** Dot radius floors, in map pixels. */

export type FactoryMinimapProps = {
  readonly source: MinimapSource;
  readonly nodeColor: (rect: MinimapRect) => string;
  readonly nodeStrokeColor: (rect: MinimapRect) => string;
  /** Agent seats are drawn as dots; undefined for any other node. */
  readonly seatMarkOf?: (rect: MinimapRect) => SeatMark | undefined;
  readonly nodeStrokeWidth?: number;
  readonly nodeBorderRadius?: number;
  readonly maskColor: string;
  /** A click on the empty map, with the board point under it. */
  readonly onClick?: (event: ReactMouseEvent, position: { x: number; y: number }) => void;
  readonly onNodeClick?: (event: ReactMouseEvent, id: string) => void;
  readonly ariaLabel?: string;
  readonly style?: CSSProperties;
};

/** Padding around the node bounds, in map view-scale units (React Flow's offsetScale). */
const OFFSET_SCALE = 5;
/** Pointer travel below which a press is a click, not a drag. */
const CLICK_SLOP_PX = 3;

const EMPTY_BOUNDS: Rect = { x: 0, y: 0, width: 0, height: 0 };

const unionRect = (a: Rect, b: Rect): Rect => {
  if (a.width === 0 && a.height === 0) return b;
  if (b.width === 0 && b.height === 0) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};

const contains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

const boundsOf = (rects: ReadonlyArray<Rect>): Rect => rects.reduce(unionRect, EMPTY_BOUNDS);

/** React Flow's viewBox: the bounds letterboxed to the element's aspect, plus an offset margin. */
const viewBoxFor = (bounds: Rect, elementWidth: number, elementHeight: number): { readonly viewBox: string; readonly viewScale: number } => {
  const ew = Math.max(elementWidth, 1);
  const eh = Math.max(elementHeight, 1);
  const viewScale = Math.max(bounds.width / ew, bounds.height / eh) || 1;
  const viewWidth = viewScale * ew;
  const viewHeight = viewScale * eh;
  const offset = OFFSET_SCALE * viewScale;
  const x = bounds.x - (viewWidth - bounds.width) / 2 - offset;
  const y = bounds.y - (viewHeight - bounds.height) / 2 - offset;
  return { viewBox: `${x} ${y} ${viewWidth + offset * 2} ${viewHeight + offset * 2}`, viewScale };
};

const maskPath = (box: Rect, view: Rect): string =>
  `M${box.x},${box.y}h${box.width}v${box.height}h${-box.width}z M${view.x},${view.y}h${view.width}v${view.height}h${-view.width}z`;

const parseViewBox = (viewBox: string): Rect => {
  const [x = 0, y = 0, width = 0, height = 0] = viewBox.split(" ").map(Number);
  return { x, y, width, height };
};

/**
 * The SVG's placement of its viewBox (the default xMidYMid meet: one scale,
 * then centred) as a CSS transform, so flow units in the ping layer land on
 * the same map pixels as the SVG's.
 */
export const pingLayerTransform = (box: Rect, elementWidth: number, elementHeight: number): string => {
  const unitsPerPixel = Math.max(box.width / elementWidth, box.height / elementHeight);
  if (!(unitsPerPixel > 0) || !Number.isFinite(unitsPerPixel)) return "scale(0)";
  const scale = 1 / unitsPerPixel;
  const x = (elementWidth - box.width * scale) / 2 - box.x * scale;
  const y = (elementHeight - box.height * scale) / 2 - box.y * scale;
  return `translate(${x}px, ${y}px) scale(${scale})`;
};

/** A seat dot's radius in flow units: its card's half height, floored in map pixels. */
const dotRadius = (rect: MinimapNodeRect, unit: number): number =>
  Math.max(Math.min(rect.width, rect.height) / 2, (rect.seat?.urgency ? URGENT_DOT_PX : SEAT_DOT_PX) * unit);

/** A seat's rim: the ground, or its state's colour. */
const rimOf = (rect: MinimapNodeRect): string => {
  switch (rect.seat?.urgency) {
    case "blocked":
      return "var(--color-crimson)";
    case "needs-you":
      return "var(--color-amber)";
    case "review":
      return "var(--color-cyan)";
    default:
      return "color-mix(in oklab, var(--color-ground) 55%, transparent)";
  }
};

/**
 * The card under a board point, as the SVG's own hit test answered it: the
 * topmost drawn, seats above cards, later above earlier. The rectangles sit
 * on a grid whose cell is their median side, so a click tests the few near
 * it; a rectangle spanning more cells than there are rectangles is kept aside
 * and tested on every click.
 */
export type MinimapHits = { readonly at: (point: { readonly x: number; readonly y: number }, unit: number) => string | undefined };

export const minimapHits = (rects: ReadonlyArray<MinimapNodeRect>): MinimapHits => {
  if (rects.length === 0) return { at: () => undefined };
  const sides = rects.map((rect) => Math.max(1, rect.width, rect.height)).sort((a, b) => a - b);
  const cell = sides[sides.length >> 1]!;
  const cells = new Map<string, number[]>();
  const wide: number[] = [];
  rects.forEach((rect, index) => {
    const x0 = Math.floor(rect.x / cell);
    const y0 = Math.floor(rect.y / cell);
    const x1 = Math.floor((rect.x + rect.width) / cell);
    const y1 = Math.floor((rect.y + rect.height) / cell);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > rects.length) {
      wide.push(index);
      return;
    }
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        const key = `${String(cx)},${String(cy)}`;
        const list = cells.get(key);
        if (list === undefined) cells.set(key, [index]);
        else list.push(index);
      }
    }
  });
  return {
    at: (point, unit) => {
      // A dot can reach past its card by its pixel floor: look one cell out.
      const reach = Math.ceil((URGENT_DOT_PX * unit) / cell);
      const cx = Math.floor(point.x / cell);
      const cy = Math.floor(point.y / cell);
      const near = new Set<number>(wide);
      for (let dx = -reach; dx <= reach; dx += 1) {
        for (let dy = -reach; dy <= reach; dy += 1) for (const index of cells.get(`${String(cx + dx)},${String(cy + dy)}`) ?? []) near.add(index);
      }
      let seat = -1;
      let card = -1;
      for (const index of near) {
        const rect = rects[index]!;
        if (rect.seat) {
          const r = dotRadius(rect, unit);
          const ox = point.x - (rect.x + rect.width / 2);
          const oy = point.y - (rect.y + rect.height / 2);
          if (ox * ox + oy * oy <= r * r && index > seat) seat = index;
        } else if (point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height && index > card) {
          card = index;
        }
      }
      const hit = seat >= 0 ? seat : card;
      return hit >= 0 ? rects[hit]!.id : undefined;
    },
  };
};

/**
 * CSS colours (var(), color-mix()) resolved through a probe element's computed
 * style inside the map, so they resolve where the SVG's inline styles did.
 * The computed string goes to the canvas as it is (oklab() from color-mix):
 * Chromium's canvas parses it and converts it as its SVG paint did, where a
 * conversion here rounds a channel a step off. Kept until the theme changes.
 */
const colourReader = (probe: HTMLElement): ((css: string) => string) => {
  const known = new Map<string, string>();
  return (css) => {
    const held = known.get(css);
    if (held !== undefined) return held;
    probe.style.color = "";
    probe.style.color = css;
    const resolved = probe.style.color === "" ? "transparent" : getComputedStyle(probe).color || "transparent";
    known.set(css, resolved);
    return resolved;
  };
};

/** The rectangles as the drawing takes them: flat arrays, each colour resolved once. */
const packMap = (rects: ReadonlyArray<MinimapNodeRect>, colour: (css: string) => string): PackedMap => {
  const count = rects.length;
  const boxes = new Float64Array(count * 4);
  const kinds = new Uint8Array(count);
  const fills = new Uint16Array(count);
  const strokes = new Uint16Array(count);
  const palette: string[] = [];
  const indexOf = new Map<string, number>();
  const paletteIndex = (css: string): number => {
    const known = indexOf.get(css);
    if (known !== undefined) return known;
    const index = palette.length;
    palette.push(colour(css));
    indexOf.set(css, index);
    return index;
  };
  for (let i = 0; i < count; i += 1) {
    const rect = rects[i]!;
    boxes[i * 4] = rect.x;
    boxes[i * 4 + 1] = rect.y;
    boxes[i * 4 + 2] = rect.width;
    boxes[i * 4 + 3] = rect.height;
    kinds[i] = rect.seat === undefined ? 0 : rect.seat.urgency ? 2 : 1;
    fills[i] = paletteIndex(rect.fill);
    strokes[i] = paletteIndex(rect.seat === undefined ? rect.stroke : rimOf(rect));
  }
  return { count, boxes, kinds, fills, strokes, palette };
};

/** A worker that draws the map into its canvas, where the window can hand one over. */
const minimapWorker = (canvas: HTMLCanvasElement): Worker | undefined => {
  if (typeof Worker !== "function" || typeof canvas.transferControlToOffscreen !== "function") return undefined;
  try {
    const worker = new Worker(new URL("./minimap-worker.ts", import.meta.url), { type: "module" });
    const offscreen = canvas.transferControlToOffscreen();
    worker.postMessage({ kind: "canvas", canvas: offscreen } satisfies MinimapWorkerMessage, [offscreen]);
    return worker;
  } catch {
    return undefined;
  }
};

export function FactoryMinimap({
  source,
  nodeColor,
  nodeStrokeColor,
  seatMarkOf,
  nodeStrokeWidth = 2,
  nodeBorderRadius = 5,
  maskColor,
  onClick,
  onNodeClick,
  ariaLabel,
  style,
}: FactoryMinimapProps): ReactElement {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** The worker that draws into the canvas; undefined where the window draws it. */
  const workerRef = useRef<Worker | undefined>(undefined);
  /** The packed map, and what it was packed from. */
  const packedRef = useRef<{ readonly map: PackedMap; readonly rects: ReadonlyArray<MinimapNodeRect>; readonly colour: (css: string) => string } | undefined>(undefined);
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const colourRef = useRef<((css: string) => string) | undefined>(undefined);
  const hitsRef = useRef<MinimapHits | undefined>(undefined);
  /** What the canvas last drew; a draw with the same inputs is skipped. */
  const drawnRef = useRef<string>("");
  const drawFrameRef = useRef(0);
  const maskRef = useRef<SVGPathElement | null>(null);
  const pingsRef = useRef<HTMLDivElement | null>(null);
  const pingTransformRef = useRef<string>("");
  // Pixel identity of the last camera window drawn; a viewport change that
  // lands on the same map pixel writes nothing.
  const cameraKeyRef = useRef<string>("");
  const [rects, setRects] = useState<ReadonlyArray<MinimapNodeRect>>([]);
  /** The rectangles last published, to tell a real change from the same map. */
  const rectsRef = useRef<ReadonlyArray<MinimapNodeRect> | undefined>(undefined);
  // Node bounds feed the viewBox; kept in a ref so the camera subscription
  // reads the latest without re-subscribing.
  const nodeBoundsRef = useRef<Rect>(EMPTY_BOUNDS);
  const elementSizeRef = useRef<{ width: number; height: number }>({ width: 200, height: 150 });
  const viewBoxRef = useRef<string>("");
  const colorRef = useRef({ nodeColor, nodeStrokeColor, seatMarkOf });
  colorRef.current = { nodeColor, nodeStrokeColor, seatMarkOf };
  const sourceRef = useRef(source);
  sourceRef.current = source;
  // Flow units per map pixel, for dot sizes; changes only with the viewBox.
  const [unit, setUnit] = useState(1);
  const unitRef = useRef(1);
  const strokeRef = useRef({ width: nodeStrokeWidth, radius: nodeBorderRadius });
  strokeRef.current = { width: nodeStrokeWidth, radius: nodeBorderRadius };

  /** Redraw the canvas in the next frame if anything it draws has changed. */
  const draw = (): void => {
    const canvas = canvasRef.current;
    const rects = rectsRef.current;
    if (!canvas || !rects || viewBoxRef.current === "") return;
    const { width, height } = elementSizeRef.current;
    const ratio = typeof window === "object" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const key = `${viewBoxRef.current}|${String(width)}x${String(height)}@${String(ratio)}|${String(unitRef.current)}|${String(strokeRef.current.width)}|${String(strokeRef.current.radius)}`;
    if (key === drawnRef.current) return;
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (colourRef.current === undefined && probeRef.current) colourRef.current = colourReader(probeRef.current);
    const colour = colourRef.current ?? ((css: string) => css);
    const worker = workerRef.current;
    let packed = packedRef.current;
    if (packed === undefined || packed.rects !== rects || packed.colour !== colour) {
      packed = { map: packMap(rects, colour), rects, colour };
      packedRef.current = packed;
      if (worker !== undefined) {
        const { boxes, kinds, fills, strokes } = packed.map;
        worker.postMessage({ kind: "map", map: packed.map } satisfies MinimapWorkerMessage, [boxes.buffer, kinds.buffer, fills.buffer, strokes.buffer]);
      }
    }
    drawnRef.current = key;
    const paint: MapPaint = {
      box: parseViewBox(viewBoxRef.current),
      width,
      height,
      ratio,
      unit: unitRef.current,
      strokeWidth: strokeRef.current.width,
      radius: strokeRef.current.radius,
    };
    if (worker !== undefined) {
      worker.postMessage({ kind: "paint", paint, pixelWidth, pixelHeight } satisfies MinimapWorkerMessage);
      return;
    }
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const context = canvas.getContext("2d");
    if (context) drawMap(context, packed.map, paint);
  };
  const drawRef = useRef(draw);
  drawRef.current = draw;
  /** Ask for a redraw: once per frame at most, never when nothing changed. */
  const redraw = (fresh = false): void => {
    if (fresh) drawnRef.current = "";
    if (drawFrameRef.current !== 0 || typeof requestAnimationFrame !== "function") return;
    drawFrameRef.current = requestAnimationFrame(() => {
      drawFrameRef.current = 0;
      drawRef.current();
    });
  };
  const redrawRef = useRef(redraw);
  redrawRef.current = redraw;

  // The canvas, made here so each mount has its own: a canvas handed to a
  // worker cannot be handed again, nor drawn by the window.
  useEffect(() => {
    const panel = probeRef.current?.parentElement;
    if (!panel) return;
    const canvas = document.createElement("canvas");
    canvas.className = "junto-minimap-canvas";
    canvas.setAttribute("role", "img");
    panel.prepend(canvas);
    canvasRef.current = canvas;
    workerRef.current = minimapWorker(canvas);
    packedRef.current = undefined;
    redrawRef.current(true);
    return () => {
      workerRef.current?.terminate();
      workerRef.current = undefined;
      packedRef.current = undefined;
      canvasRef.current = null;
      canvas.remove();
    };
  }, []);
  useEffect(() => {
    if (ariaLabel === undefined) canvasRef.current?.removeAttribute("aria-label");
    else canvasRef.current?.setAttribute("aria-label", ariaLabel);
  }, [ariaLabel]);

  // The theme moves what var() and color-mix() resolve to: read them again.
  useEffect(() => {
    if (typeof MutationObserver !== "function") return;
    const observer = new MutationObserver(() => {
      colourRef.current = undefined;
      redrawRef.current(true);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    return () => {
      observer.disconnect();
      if (drawFrameRef.current !== 0) cancelAnimationFrame(drawFrameRef.current);
      drawFrameRef.current = 0;
    };
  }, []);

  // Camera → mask path (every camera change) and viewBox (only when the
  // camera leaves the node bounds). Direct DOM writes, coalesced per frame.
  const applyCamera = (): void => {
    const svg = svgRef.current;
    const mask = maskRef.current;
    if (!svg || !mask) return;
    const camera = sourceRef.current.camera();
    const size = sourceRef.current.viewport();
    const view: Rect = { x: -camera.x / camera.zoom, y: -camera.y / camera.zoom, width: size.width / camera.zoom, height: size.height / camera.zoom };
    const current = viewBoxRef.current === "" ? EMPTY_BOUNDS : parseViewBox(viewBoxRef.current);
    const nodeBounds = nodeBoundsRef.current;
    const needsBox = viewBoxRef.current === "" || !contains(current, view) || !contains(current, nodeBounds);
    if (needsBox) {
      const { width, height } = elementSizeRef.current;
      const next = viewBoxFor(unionRect(nodeBounds, view), width, height).viewBox;
      if (next !== viewBoxRef.current) {
        viewBoxRef.current = next;
        svg.setAttribute("viewBox", next);
        redrawRef.current();
      }
    }
    const box = parseViewBox(viewBoxRef.current);
    // Camera window in pixels of the map, through the SVG's own placement of
    // the viewBox (the default xMidYMid meet: one scale, then centred).
    const elementWidth = Math.max(elementSizeRef.current.width, 1);
    const elementHeight = Math.max(elementSizeRef.current.height, 1);
    const unitsPerPixel = Math.max(box.width / elementWidth, box.height / elementHeight);
    // The ping layer follows the viewBox, which moves only when the camera
    // leaves the node bounds or the map resizes: no write on a plain pan.
    const pingTransform = pingLayerTransform(box, elementWidth, elementHeight);
    if (pingsRef.current && pingTransform !== pingTransformRef.current) {
      pingTransformRef.current = pingTransform;
      pingsRef.current.style.transform = pingTransform;
    }
    if (unitsPerPixel > 0 && Math.abs(unitsPerPixel - unitRef.current) / unitRef.current > 0.02) {
      unitRef.current = unitsPerPixel;
      setUnit(unitsPerPixel);
      redrawRef.current();
    }
    const density = unitsPerPixel > 0 ? 1 / unitsPerPixel : 0;
    const key =
      density > 0 && Number.isFinite(density)
        ? `${viewBoxRef.current}|${Math.round(view.x * density)},${Math.round(view.y * density)},${Math.round(view.width * density)},${Math.round(view.height * density)}`
        : "";
    if (key !== "" && key === cameraKeyRef.current) return;
    cameraKeyRef.current = key;
    mask.setAttribute("d", maskPath(box, view));
  };
  const applyCameraRef = useRef(applyCamera);
  applyCameraRef.current = applyCamera;

  // Rectangles. Recomputed when the scene changes, never on pan.
  useEffect(() => {
    const recompute = (): void => {
      const { nodeColor: fillOf, nodeStrokeColor: strokeOf, seatMarkOf: seatOf } = colorRef.current;
      const next: MinimapNodeRect[] = [];
      for (const rect of sourceRef.current.rects()) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        const seat = seatOf?.(rect);
        next.push({ id: rect.id, x: rect.x, y: rect.y, width: rect.width, height: rect.height, fill: fillOf(rect), stroke: strokeOf(rect), ...(seat ? { seat } : {}) });
      }
      // The scene replaces its rectangles for changes the map cannot show (a
      // selection, a measurement, a card's class). Rectangles that say what
      // the last ones said are not published again: the map does not render
      // and its view box is not worked out afresh.
      if (sameRects(rectsRef.current, next)) return;
      rectsRef.current = next;
      hitsRef.current = undefined;
      nodeBoundsRef.current = boundsOf(next);
      // A new scene may change the bounds; let the camera pass re-fit.
      viewBoxRef.current = "";
      // Only the pinging seats are React children; the rest are drawn.
      setRects(next.filter((rect) => rect.seat?.urgency === "blocked" || rect.seat?.urgency === "needs-you"));
      applyCameraRef.current();
      redrawRef.current(true);
    };
    recompute();
    return sourceRef.current.onRects(() => {
      recompute();
    });
  }, [source, nodeColor, nodeStrokeColor, seatMarkOf]);

  // Camera subscription + element size.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    let frame = 0;
    const schedule = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        applyCameraRef.current();
      });
    };
    const offCamera = sourceRef.current.onCamera(schedule);
    const offViewport = sourceRef.current.onViewport(schedule);
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry) return;
            elementSizeRef.current = { width: entry.contentRect.width, height: entry.contentRect.height };
            viewBoxRef.current = "";
            schedule();
            redrawRef.current();
          })
        : undefined;
    observer?.observe(svg);
    const rect = svg.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) elementSizeRef.current = { width: rect.width, height: rect.height };
    applyCameraRef.current();
    redrawRef.current();
    return () => {
      offCamera();
      offViewport();
      observer?.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [source]);

  // Client pixel → flow coordinates through the SVG's own transform.
  const flowPointOf = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const point = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: point.x, y: point.y };
  };

  /** Flow units per CSS pixel of the map (React Flow's viewScale). */
  const viewScaleOf = (): number => {
    const ctm = svgRef.current?.getScreenCTM();
    return ctm && ctm.a !== 0 ? 1 / ctm.a : 1;
  };

  // Drag = pan the camera, wheel = zoom, short press = click. Same math as
  // React Flow's XYMinimap; no d3-zoom so no extra listeners per node.
  const dragRef = useRef<{ pointerId: number; lastX: number; lastY: number; travel: number } | null>(null);
  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return;
    dragRef.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY, travel: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    drag.travel += Math.abs(dx) + Math.abs(dy);
    if (drag.travel <= CLICK_SLOP_PX) return;
    const camera = sourceRef.current.camera();
    const moveScale = viewScaleOf() * Math.max(camera.zoom, Math.log(camera.zoom));
    sourceRef.current.setCamera({ x: camera.x - dx * moveScale, y: camera.y - dy * moveScale, zoom: camera.zoom });
  };
  const endDrag = (event: React.PointerEvent<SVGSVGElement>): boolean => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return false;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    return drag.travel > CLICK_SLOP_PX;
  };
  const suppressClickRef = useRef(false);
  const onPointerUp = (event: React.PointerEvent<SVGSVGElement>): void => {
    suppressClickRef.current = endDrag(event);
  };
  const onWheel = (event: React.WheelEvent<SVGSVGElement>): void => {
    const factor = event.ctrlKey && /Mac/.test(navigator.platform) ? 10 : 1;
    const pinchDelta = -event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002);
    sourceRef.current.zoomBy(Math.pow(2, pinchDelta * factor));
  };
  /** The card under a client point, through the grid of the drawn rectangles. */
  const cardAt = (clientX: number, clientY: number): string | undefined => {
    const rects = rectsRef.current;
    if (!rects) return undefined;
    const position = flowPointOf(clientX, clientY);
    if (!position) return undefined;
    hitsRef.current ??= minimapHits(rects);
    return hitsRef.current.at(position, unitRef.current);
  };
  const onSvgClick = (event: ReactMouseEvent<SVGSVGElement>): void => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    // A card's click comes first, then the map's own, as the SVG's bubbling did.
    if (onNodeClick) {
      const id = cardAt(event.clientX, event.clientY);
      if (id !== undefined) onNodeClick(event, id);
    }
    if (!onClick) return;
    const position = flowPointOf(event.clientX, event.clientY);
    if (position) onClick(event, position);
  };
  /** A dot shows the hand it showed as an SVG child. */
  const pointingRef = useRef(false);
  const onHover = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (dragRef.current) return;
    const over = rectsRef.current?.length ? cardAt(event.clientX, event.clientY) : undefined;
    const pointing = over !== undefined && (rectsRef.current?.find((rect) => rect.id === over)?.seat !== undefined);
    if (pointing === pointingRef.current) return;
    pointingRef.current = pointing;
    event.currentTarget.style.cursor = pointing ? "pointer" : "";
  };

  return (
    // Scrolled out of the bottom bar (a narrow window), the map's pings stop (lib/unseen.ts).
    <div ref={unseenRef} className="react-flow__panel react-flow__minimap bottom right" data-testid="rf__minimap" style={style}>
      <span ref={probeRef} className="junto-minimap-probe" aria-hidden="true" />
      <svg
        ref={svgRef}
        className="react-flow__minimap-svg"
        onPointerDown={onPointerDown}
        onPointerMove={(event) => {
          onPointerMove(event);
          onHover(event);
        }}
        onPointerUp={onPointerUp}
        onPointerCancel={(event) => { endDrag(event); }}
        onWheel={onWheel}
        onClick={onSvgClick}
      >
        <path ref={maskRef} className="react-flow__minimap-mask" style={{ fill: maskColor }} fillRule="evenodd" pointerEvents="none" />
      </svg>
      <div ref={pingsRef} className="junto-minimap-pings" data-testid="minimap-pings" aria-hidden="true">
        {rects.map((rect) => {
          if (rect.seat?.urgency !== "blocked" && rect.seat?.urgency !== "needs-you") return null;
          // The SVG ring this replaces: radius r about the dot's centre, a
          // stroke one map pixel wide centred on r. A border-box of r plus
          // half the stroke, with the stroke as its border, draws the same.
          const r = Math.max(Math.min(rect.width, rect.height) / 2, URGENT_DOT_PX * unit);
          const outer = r + unit / 2;
          return (
            <span
              key={rect.id}
              className="junto-minimap-ping"
              data-urgency={rect.seat.urgency}
              style={{
                left: rect.x + rect.width / 2 - outer,
                top: rect.y + rect.height / 2 - outer,
                width: outer * 2,
                height: outer * 2,
                borderWidth: unit,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
