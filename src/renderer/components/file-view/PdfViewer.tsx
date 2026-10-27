import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { claimFocus, releaseFocus } from "../../lib/focus-ownership";
import { BoxLayer } from "./BoxLayer";
import { BoxActions, useBoxTools, ViewerToolbar, type BoxTools, type FileThreadBox, type FileViewProps } from "./box-tools";
import { canvasPng } from "./extract";
import { fileNameOf, PAGE_GUTTER, pageAtScroll, parsePageInput, zoomIn, zoomLabel, zoomOf, zoomOut, type ZoomMode } from "./file-view-model";
import { usePaneWidth, useViewerKeys } from "./viewer-keys";

type Engine = typeof import("./pdf-engine");
type LoadedPdf = import("./pdf-engine").LoadedPdf;

/** The space between pages in the stack, in CSS pixels. */
const PAGE_GAP = 16;

type Loading = { readonly kind: "loading" } | { readonly kind: "ready"; readonly engine: Engine; readonly pdf: LoadedPdf } | { readonly kind: "failed" };

/**
 * A PDF in the main pane (F6): its pages in one scrolling stack, fitted to
 * the pane's width until the operator zooms, each page drawn only near the
 * view, with a text layer so text selects and copies. pdf.js loads the first
 * time a PDF opens. The box tool marks an area of a page for a comment (F7)
 * or an extract (F8).
 */
export function PdfViewer({
  canvasName,
  nodeId,
  path,
  url,
  data,
  boxes = [],
  onComment,
  onDraft,
  initialPage,
}: FileViewProps & {
  /** The PDF's bytes instead of its address: the dev gallery has no Files node to serve them. */
  readonly data?: Uint8Array;
}) {
  const [loading, setLoading] = useState<Loading>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    let close: (() => void) | undefined;
    setLoading({ kind: "loading" });
    void import("./pdf-engine")
      .then(async (engine) => {
        // pdf.js hands the bytes to its worker and detaches them, so it gets a copy.
        const pdf = await engine.loadPdf(data === undefined ? url : data.slice());
        if (!live) return pdf.close();
        close = pdf.close;
        setLoading({ kind: "ready", engine, pdf });
      })
      .catch(() => {
        if (live) setLoading({ kind: "failed" });
      });
    return () => {
      live = false;
      close?.();
    };
  }, [url, data]);

  const [pane, paneWidth, paneElement] = usePaneWidth();
  const [mode, setMode] = useState<ZoomMode>({ kind: "fit" });
  const sizes = loading.kind === "ready" ? loading.pdf.sizes : [];
  const widest = sizes.reduce((most, size) => Math.max(most, size.width), 0);
  const zoom = widest === 0 ? 1 : zoomOf(mode, widest, paneWidth);
  const zoomTo = (next: number): void => setMode({ kind: "fixed", zoom: next });

  /** Each page's top and height in the stage's scroll pixels. */
  const tops = useMemo(() => {
    let top = PAGE_GUTTER;
    return sizes.map((size) => {
      const height = Math.round(size.height * zoom);
      const entry = { top, height };
      top += height + PAGE_GAP;
      return entry;
    });
  }, [sizes, zoom]);
  const [page, setPage] = useState(1);
  const [pageText, setPageText] = useState<string | null>(null);
  const goTo = (target: number): void => {
    const entry = tops[target - 1];
    if (entry === undefined || paneElement === null) return;
    paneElement.scrollTo({ top: entry.top - PAGE_GUTTER });
    setPage(target);
  };

  // A zoom keeps the place: the same point of the same page stays at the top of the stage.
  const lastTops = useRef(tops);
  useLayoutEffect(() => {
    const before = lastTops.current;
    lastTops.current = tops;
    if (paneElement === null || before === tops || before.length !== tops.length || before.length === 0) return;
    const scroll = paneElement.scrollTop;
    const index = Math.max(0, pageAtScroll(before, scroll, 0) - 1);
    const was = before[index]!;
    const now = tops[index]!;
    paneElement.scrollTop = now.top + ((scroll - was.top) / Math.max(1, was.height)) * now.height;
    setPage(pageAtScroll(tops, paneElement.scrollTop, paneElement.clientHeight));
  }, [tops, paneElement]);

  // An extract's link back opens on its page as soon as the pages are laid out.
  // Each new page asked for jumps once; the same viewer asked for another page jumps again.
  const jumped = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (initialPage === undefined || jumped.current === initialPage || tops.length === 0 || paneElement === null) return;
    jumped.current = initialPage;
    const entry = tops[Math.min(tops.length, Math.max(1, initialPage)) - 1]!;
    paneElement.scrollTo({ top: entry.top - PAGE_GUTTER });
    setPage(Math.min(tops.length, Math.max(1, initialPage)));
  }, [initialPage, tops, paneElement]);

  const tools = useBoxTools({
    canvasName,
    nodeId,
    path,
    onComment,
    onDraft,
    boxes,
    stage: paneElement,
    shoot: async (draft) => {
      if (loading.kind !== "ready" || draft.page === undefined) throw new Error("The PDF is not open.");
      const shot = await loading.engine.renderPageBox(await loading.pdf.doc.getPage(draft.page), draft.box);
      return canvasPng(shot.canvas);
    },
  });
  const onKeyDown = useViewerKeys({
    tools,
    zoomIn: () => zoomTo(zoomIn(zoom)),
    zoomOut: () => zoomTo(zoomOut(zoom)),
    actual: () => zoomTo(1),
    page,
  });
  const onStageKey = (event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // Page Up and Down already scroll the stage; these step a whole page.
    if (event.key === "n" || event.key === "j") goTo(Math.min(sizes.length, page + 1));
    else if (event.key === "p" || event.key === "k") goTo(Math.max(1, page - 1));
    else if (event.key === "Home") goTo(1);
    else if (event.key === "End") goTo(sizes.length);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const name = fileNameOf(path);
  const count = sizes.length;
  return (
    <div className="file-view" data-testid="pdf-viewer" onKeyDown={onKeyDown}>
      <ViewerToolbar
        zoom={zoom}
        fitted={mode.kind === "fit"}
        onZoomIn={() => zoomTo(zoomIn(zoom))}
        onZoomOut={() => zoomTo(zoomOut(zoom))}
        onFit={() => setMode({ kind: "fit" })}
        onActual={() => zoomTo(1)}
        tools={tools}
        announce={count === 0 ? zoomLabel(zoom) : `Page ${page} of ${count}, ${zoomLabel(zoom)}`}
        pages={
          count === 0 ? undefined : (
            <label className="file-view__pages">
              <input
                className="file-view__page-input"
                data-testid="pdf-page-input"
                inputMode="numeric"
                aria-label={`Page number, of ${count}`}
                value={pageText ?? String(page)}
                onFocus={(event) => {
                  setPageText(String(page));
                  claimFocus(event.currentTarget, "gesture", { select: true });
                }}
                onChange={(event) => setPageText(event.target.value)}
                onBlur={() => setPageText(null)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    const target = parsePageInput(event.currentTarget.value, count);
                    if (target !== undefined) goTo(target);
                    setPageText(null);
                    event.preventDefault();
                  } else if (event.key === "Escape") {
                    setPageText(null);
                    releaseFocus(event.currentTarget, "gesture");
                    event.preventDefault();
                    event.stopPropagation();
                  }
                }}
              />
              <span className="file-view__count" data-testid="pdf-page-count">
                of {count}
              </span>
            </label>
          )
        }
      />
      <div
        ref={pane}
        className="file-view__stage"
        role="group"
        tabIndex={0}
        aria-label={count === 0 ? name : `${name}, ${count} ${count === 1 ? "page" : "pages"}`}
        onKeyDown={onStageKey}
        onScroll={(event) => setPage(pageAtScroll(tops, event.currentTarget.scrollTop, event.currentTarget.clientHeight))}
      >
        {loading.kind === "loading" ? <p className="file-view__empty">Opening {name}</p> : null}
        {loading.kind === "failed" ? (
          <p className="file-view__empty" role="alert">
            This PDF could not be opened.
          </p>
        ) : null}
        {loading.kind === "ready" ? (
          <div className="file-view__pages-stack" style={{ gap: PAGE_GAP }}>
            {sizes.map((size, index) => (
              <PdfPage
                key={index}
                number={index + 1}
                count={sizes.length}
                width={Math.round(size.width * zoom)}
                height={Math.round(size.height * zoom)}
                zoom={zoom}
                engine={loading.engine}
                pdf={loading.pdf}
                root={paneElement}
                tools={tools}
                boxes={boxes.filter((entry: FileThreadBox) => entry.page === index + 1)}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One page: a sized frame always, its pixels and text only while near the
 * view, drawn again at each zoom. A page that scrolls away keeps what it
 * drew; one that was never near the view stays an empty sheet.
 */
function PdfPage({
  number,
  count,
  width,
  height,
  zoom,
  engine,
  pdf,
  root,
  tools,
  boxes,
}: {
  readonly number: number;
  readonly count: number;
  readonly width: number;
  readonly height: number;
  readonly zoom: number;
  readonly engine: Engine;
  readonly pdf: LoadedPdf;
  readonly root: HTMLElement | null;
  readonly tools: BoxTools;
  readonly boxes: ReadonlyArray<FileThreadBox>;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null || root === null) return;
    const observer = new IntersectionObserver((entries) => setNear(entries.some((entry) => entry.isIntersecting)), {
      root,
      rootMargin: "100% 0px",
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [root]);
  useEffect(() => {
    const canvas = canvasRef.current;
    const text = textRef.current;
    if (!near || canvas === null || text === null) return;
    let draw: ReturnType<Engine["drawPage"]> | undefined;
    let live = true;
    void pdf.doc.getPage(number).then((page) => {
      if (!live) return;
      draw = engine.drawPage(page, zoom, canvas, text);
      // A cancelled draw rejects; the next zoom draws again.
      draw.done.catch(() => undefined);
    });
    return () => {
      live = false;
      draw?.cancel();
    };
  }, [near, zoom, number, engine, pdf]);
  const draft = tools.draft?.page === number ? tools.draft.box : null;
  return (
    <div
      ref={frameRef}
      className="file-view__surface file-view__page"
      role="group"
      aria-label={`Page ${number} of ${count}`}
      data-testid="pdf-page"
      data-page={number}
      // The page holding the drawn box sits above the next one, so the box's buttons in the gap stay pressable.
      style={{ width, height, ...(draft === null ? {} : { zIndex: 1 }) }}
    >
      <canvas ref={canvasRef} className="file-view__canvas" style={{ width, height }} aria-hidden />
      <div ref={textRef} className="textLayer" />
      <BoxLayer
        width={width}
        height={height}
        drawing={tools.drawing}
        boxes={boxes}
        draft={draft}
        onDraw={(box) => tools.draw({ page: number, box })}
        actions={<BoxActions tools={tools} />}
        label={`page ${number}`}
      />
    </div>
  );
}
