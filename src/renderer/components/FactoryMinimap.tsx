import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import { useStoreApi, type Node } from "@xyflow/react";

/**
 * The strategic minimap, drawn so that a pan costs one attribute write.
 *
 * React Flow's <MiniMap> selects the store transform, so every viewport change
 * re-rendered the component, rewrote the SVG viewBox (which re-lays out and
 * repaints every node rectangle) and re-ran one store selector per node.
 * Measured on the live board: about 45% of what a pan still cost the main
 * thread after the viewport itself was taken off it.
 *
 * Here the node rectangles are React state that changes only when nodes
 * change (position, size, hidden, colour inputs). The camera is applied
 * imperatively: a store subscription rewrites the mask path on viewport
 * changes and touches the viewBox only when the camera leaves the node
 * bounds. Pan and zoom on the map use the same math as React Flow's XYMinimap.
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
 * Must be mounted inside <ReactFlow> so the store resolves.
 */

type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

type MinimapNodeRect = Rect & {
  readonly id: string;
  readonly fill: string;
  readonly stroke: string;
};

export type FactoryMinimapProps = {
  readonly nodeColor: (node: Node) => string;
  readonly nodeStrokeColor: (node: Node) => string;
  readonly nodeStrokeWidth?: number;
  readonly nodeBorderRadius?: number;
  readonly maskColor: string;
  readonly onClick?: (event: ReactMouseEvent, position: { x: number; y: number }) => void;
  readonly onNodeClick?: (event: ReactMouseEvent, node: Node) => void;
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

export function FactoryMinimap({
  nodeColor,
  nodeStrokeColor,
  nodeStrokeWidth = 2,
  nodeBorderRadius = 5,
  maskColor,
  onClick,
  onNodeClick,
  ariaLabel,
  style,
}: FactoryMinimapProps): ReactElement {
  const store = useStoreApi();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const maskRef = useRef<SVGPathElement | null>(null);
  // Pixel identity of the last camera window drawn; a viewport change that
  // lands on the same map pixel writes nothing.
  const cameraKeyRef = useRef<string>("");
  const [rects, setRects] = useState<ReadonlyArray<MinimapNodeRect>>([]);
  // Node bounds feed the viewBox; kept in a ref so the camera subscription
  // reads the latest without re-subscribing.
  const nodeBoundsRef = useRef<Rect>(EMPTY_BOUNDS);
  const elementSizeRef = useRef<{ width: number; height: number }>({ width: 200, height: 150 });
  const viewBoxRef = useRef<string>("");
  const colorRef = useRef({ nodeColor, nodeStrokeColor });
  colorRef.current = { nodeColor, nodeStrokeColor };

  // Camera → mask path (every viewport change) and viewBox (only when the
  // camera leaves the node bounds). Direct DOM writes, coalesced per frame.
  const applyCamera = (): void => {
    const svg = svgRef.current;
    const mask = maskRef.current;
    if (!svg || !mask) return;
    const state = store.getState();
    const [tx, ty, zoom] = state.transform;
    const view: Rect = { x: -tx / zoom, y: -ty / zoom, width: state.width / zoom, height: state.height / zoom };
    const current = viewBoxRef.current === "" ? EMPTY_BOUNDS : parseViewBox(viewBoxRef.current);
    const nodeBounds = nodeBoundsRef.current;
    const needsBox = viewBoxRef.current === "" || !contains(current, view) || !contains(current, nodeBounds);
    if (needsBox) {
      const { width, height } = elementSizeRef.current;
      const next = viewBoxFor(unionRect(nodeBounds, view), width, height).viewBox;
      if (next !== viewBoxRef.current) {
        viewBoxRef.current = next;
        svg.setAttribute("viewBox", next);
      }
    }
    const box = parseViewBox(viewBoxRef.current);
    // Camera window in pixels of the map, through the SVG's own placement of
    // the viewBox (the default xMidYMid meet: one scale, then centred).
    const elementWidth = Math.max(elementSizeRef.current.width, 1);
    const elementHeight = Math.max(elementSizeRef.current.height, 1);
    const unitsPerPixel = Math.max(box.width / elementWidth, box.height / elementHeight);
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

  // Nodes → rectangles. Recomputed when the node set changes, never on pan.
  useEffect(() => {
    const recompute = (): void => {
      const { nodeLookup } = store.getState();
      const { nodeColor: fill, nodeStrokeColor: stroke } = colorRef.current;
      const next: MinimapNodeRect[] = [];
      for (const internal of nodeLookup.values()) {
        const user = internal.internals.userNode;
        if (user.hidden) continue;
        const width = internal.measured.width ?? user.width ?? 0;
        const height = internal.measured.height ?? user.height ?? 0;
        if (width <= 0 || height <= 0) continue;
        const { x, y } = internal.internals.positionAbsolute;
        next.push({ id: user.id, x, y, width, height, fill: fill(user), stroke: stroke(user) });
      }
      nodeBoundsRef.current = boundsOf(next);
      // A new node set may change the bounds; let the camera pass re-fit.
      viewBoxRef.current = "";
      setRects(next);
      applyCameraRef.current();
    };
    recompute();
    let lastNodes = store.getState().nodes;
    let lastLookup = store.getState().nodeLookup;
    const unsubscribe = store.subscribe((state) => {
      if (state.nodes === lastNodes && state.nodeLookup === lastLookup) return;
      lastNodes = state.nodes;
      lastLookup = state.nodeLookup;
      recompute();
    });
    return unsubscribe;
  }, [store, nodeColor, nodeStrokeColor]);

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
    let lastTransform = store.getState().transform;
    let lastSize = `${store.getState().width}x${store.getState().height}`;
    const unsubscribe = store.subscribe((state) => {
      const size = `${state.width}x${state.height}`;
      if (state.transform === lastTransform && size === lastSize) return;
      lastTransform = state.transform;
      lastSize = size;
      schedule();
    });
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry) return;
            elementSizeRef.current = { width: entry.contentRect.width, height: entry.contentRect.height };
            viewBoxRef.current = "";
            schedule();
          })
        : undefined;
    observer?.observe(svg);
    const rect = svg.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) elementSizeRef.current = { width: rect.width, height: rect.height };
    applyCameraRef.current();
    return () => {
      unsubscribe();
      observer?.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [store]);

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
    const state = store.getState();
    const panZoom = state.panZoom;
    if (!panZoom) return;
    const [tx, ty, zoom] = state.transform;
    const moveScale = viewScaleOf() * Math.max(zoom, Math.log(zoom));
    void panZoom.setViewportConstrained(
      { x: tx - dx * moveScale, y: ty - dy * moveScale, zoom },
      [[0, 0], [state.width, state.height]],
      state.translateExtent,
    );
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
    const state = store.getState();
    const panZoom = state.panZoom;
    if (!panZoom) return;
    const factor = event.ctrlKey && /Mac/.test(navigator.platform) ? 10 : 1;
    const pinchDelta = -event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002);
    void panZoom.scaleTo(state.transform[2] * Math.pow(2, pinchDelta * factor));
  };
  const onSvgClick = (event: ReactMouseEvent<SVGSVGElement>): void => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (!onClick) return;
    const position = flowPointOf(event.clientX, event.clientY);
    if (position) onClick(event, position);
  };
  const onRectClick = (event: ReactMouseEvent<SVGRectElement>, id: string): void => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      event.stopPropagation();
      return;
    }
    if (!onNodeClick) return;
    const node = store.getState().nodeLookup.get(id)?.internals.userNode;
    if (node) onNodeClick(event, node);
  };

  return (
    <div className="react-flow__panel react-flow__minimap bottom right" data-testid="rf__minimap" style={style}>
      <svg
        ref={svgRef}
        className="react-flow__minimap-svg"
        role="img"
        aria-label={ariaLabel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={(event) => { endDrag(event); }}
        onWheel={onWheel}
        onClick={onSvgClick}
      >
        {rects.map((rect) => (
          <rect
            key={rect.id}
            className="react-flow__minimap-node"
            x={rect.x}
            y={rect.y}
            rx={nodeBorderRadius}
            ry={nodeBorderRadius}
            width={rect.width}
            height={rect.height}
            // Inline style, not presentation attributes: the colours are CSS
            // (var(), color-mix()) which attributes cannot carry, and React
            // Flow's minimap stylesheet would outrank attributes anyway.
            style={{ fill: rect.fill, stroke: rect.stroke, strokeWidth: nodeStrokeWidth }}
            shapeRendering="crispEdges"
            onClick={(event) => onRectClick(event, rect.id)}
          />
        ))}
        <path ref={maskRef} className="react-flow__minimap-mask" style={{ fill: maskColor }} fillRule="evenodd" pointerEvents="none" />
      </svg>
    </div>
  );
}
