import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { boxFromDrag, boxPixels, type ViewBox, type ViewPoint } from "./file-view-model";

/** A box already on the surface: a comment thread's, shown wherever the file is open. */
export type ShownBox = { readonly id: string; readonly box: ViewBox; readonly label?: string };

/**
 * The layer over one surface (an image, a PDF page) where a box is drawn,
 * the pad's area pick on a file: a drag draws a dashed amber box and the
 * release keeps it, as fractions of the surface. While the box tool is off
 * the layer lets every pointer through, so text on a PDF page selects.
 * Thread boxes always show; the drawn one carries its actions under it.
 */
export function BoxLayer({
  width,
  height,
  drawing,
  boxes = [],
  draft,
  onDraw,
  actions,
  label,
}: {
  /** The surface's rendered size in CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** The box tool is on: a drag here draws. */
  readonly drawing: boolean;
  readonly boxes?: ReadonlyArray<ShownBox>;
  /** The box drawn on this surface and not yet used, if any. */
  readonly draft: ViewBox | null;
  readonly onDraw: (box: ViewBox) => void;
  /** What the drawn box offers (comment, extract), placed under it. */
  readonly actions?: ReactNode;
  /** What the surface is, for the drawn box's name ("page 2", "the image"). */
  readonly label: string;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ readonly start: ViewPoint; readonly current: ViewPoint } | null>(null);
  const pointOf = (event: ReactPointerEvent): ViewPoint => {
    const rect = layerRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };
  const live = drag === null ? null : boxFromDrag(drag.start, drag.current, width, height);
  const shown = live ?? (drag === null ? draft : null);
  return (
    <div
      ref={layerRef}
      className="file-box-layer"
      data-drawing={drawing ? "" : undefined}
      data-testid="file-box-layer"
      onPointerDown={(event) => {
        if (!drawing || event.button !== 0) return;
        // The drawn box's own buttons are pressed, not drawn over.
        if (event.target instanceof Element && event.target.closest(".file-box__actions") !== null) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const point = pointOf(event);
        setDrag({ start: point, current: point });
      }}
      onPointerMove={(event) => {
        if (drag === null) return;
        setDrag({ start: drag.start, current: pointOf(event) });
      }}
      onPointerUp={(event) => {
        if (drag === null) return;
        const box = boxFromDrag(drag.start, pointOf(event), width, height);
        setDrag(null);
        // A click is not a box: it keeps whatever was drawn before.
        if (box !== undefined) onDraw(box);
      }}
      onPointerCancel={() => setDrag(null)}
    >
      {boxes.map((entry) => (
        <span
          key={entry.id}
          className="file-box file-box--thread"
          data-testid="file-box-thread"
          // The comments rail is where threads are read and opened; this is the pointer's glance at where they sit.
          aria-hidden
          title={entry.label}
          style={boxPixels(entry.box, width, height)}
        />
      ))}
      {shown === null ? null : (
        <span
          className="file-box file-box--draft"
          data-testid={live === null ? "file-box-draft" : "file-box-drawing"}
          role="img"
          aria-label={`The area you marked on ${label}`}
          style={boxPixels(shown, width, height)}
        >
          {live === null && actions !== undefined ? <span className="file-box__actions">{actions}</span> : null}
        </span>
      )}
    </div>
  );
}
