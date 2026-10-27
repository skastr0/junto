import { useState } from "react";
import { BoxLayer } from "./BoxLayer";
import { BoxActions, useBoxTools, ViewerToolbar, type FileViewProps } from "./box-tools";
import { imageBoxShot } from "./extract";
import { fileNameOf, zoomIn, zoomLabel, zoomOf, zoomOut, type ZoomMode } from "./file-view-model";
import { usePaneWidth, useViewerKeys } from "./viewer-keys";

/** An image whose size the browser cannot read (an SVG with no width) shows at this size. */
const FALLBACK_SIZE = { width: 300, height: 150 } as const;

/**
 * An image file in the main pane (F6): fitted to the pane and never past its
 * own size until the operator zooms, with the box tool for a comment on an
 * area (F7) or an extract (F8).
 */
export function ImageViewer({ canvasName, nodeId, path, url, boxes = [], onComment, onDraft }: FileViewProps) {
  const [pane, paneWidth] = usePaneWidth();
  const [natural, setNatural] = useState<{ readonly width: number; readonly height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<ZoomMode>({ kind: "fit" });
  const size = natural ?? FALLBACK_SIZE;
  // Fit never enlarges an image: a small icon stays small.
  const zoom = zoomOf(mode, size.width, paneWidth, 1);
  const width = Math.round(size.width * zoom);
  const height = Math.round(size.height * zoom);
  const tools = useBoxTools({ canvasName, nodeId, path, onComment, onDraft, shoot: (draft) => imageBoxShot(url, draft.box) });
  const zoomTo = (next: number): void => setMode({ kind: "fixed", zoom: next });
  const onKeyDown = useViewerKeys({
    tools,
    zoomIn: () => zoomTo(zoomIn(zoom)),
    zoomOut: () => zoomTo(zoomOut(zoom)),
    actual: () => zoomTo(1),
  });
  const name = fileNameOf(path);
  return (
    <div className="file-view" data-testid="image-viewer" onKeyDown={onKeyDown}>
      <ViewerToolbar
        zoom={zoom}
        fitted={mode.kind === "fit"}
        onZoomIn={() => zoomTo(zoomIn(zoom))}
        onZoomOut={() => zoomTo(zoomOut(zoom))}
        onFit={() => setMode({ kind: "fit" })}
        onActual={() => zoomTo(1)}
        tools={tools}
        announce={zoomLabel(zoom)}
      />
      <div ref={pane} className="file-view__stage" role="group" tabIndex={0} aria-label={`${name}, image`}>
        {failed ? (
          <p className="file-view__empty" role="alert">
            This image could not be shown.
          </p>
        ) : (
          <div className="file-view__surface file-view__surface--image" style={{ width, height }}>
            <img
              src={url}
              alt={name}
              draggable={false}
              width={width}
              height={height}
              onLoad={(event) => {
                const image = event.currentTarget;
                setNatural(
                  image.naturalWidth > 0 && image.naturalHeight > 0
                    ? { width: image.naturalWidth, height: image.naturalHeight }
                    : FALLBACK_SIZE,
                );
                setFailed(false);
              }}
              onError={() => setFailed(true)}
            />
            <BoxLayer
              width={width}
              height={height}
              drawing={tools.drawing}
              boxes={boxes.filter((entry) => entry.page === undefined)}
              draft={tools.draft?.box ?? null}
              onDraw={(box) => tools.draw({ box })}
              actions={<BoxActions tools={tools} />}
              label="the image"
            />
          </div>
        )}
      </div>
    </div>
  );
}
