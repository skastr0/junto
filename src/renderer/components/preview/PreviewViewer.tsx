import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronLeft, ChevronRight, Columns2, FolderOpen, Pause, Play, X } from "lucide-react";
import {
  previewComparePair,
  type PreviewRef,
  type PreviewResult,
  type PreviewSource,
} from "@shared/preview";
import { isOperatorTyping } from "../../lib/focus-ownership";
import { getJuntoApi } from "../../lib/junto-api";
import { isMac } from "../../lib/platform";
import {
  Button,
  CompareSlider,
  CompareTag,
  Dialog,
  Dropdown,
  IconButton,
  MediaStage,
  Thumbnail,
  ThumbnailStrip,
  type MediaSize,
} from "../ui";
import { ArtifactMarkdown } from "../work/ArtifactMarkdown";
import { formatPreviewBytes, previewTile, usePreviews, type PreviewLoad } from "./use-previews";

const SLIDE_MS = 4000;
/** MediaStage's padding, both sides: what the image cannot use. */
const STAGE_PAD = 32;

type CompareMode = "side" | "swipe";
type Compare = { readonly a: string; readonly b: string; readonly mode: CompareMode };

/** A ref to hang on whichever element is the stage area now, and its size. */
const useElementSize = (): readonly [(element: HTMLDivElement | null) => void, MediaSize] => {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState<MediaSize>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!element) return;
    const measure = (): void => {
      const { width, height } = element.getBoundingClientRect();
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, size];
};

/** The largest scale, never above 1, at which a box fits a space. */
const fitScale = (box: MediaSize, space: MediaSize): number =>
  box.width <= 0 || box.height <= 0
    ? 1
    : Math.max(0, Math.min(1, Math.floor(space.width) / box.width, Math.floor(space.height) / box.height));

// Rounded down: a pixel over the space would raise a scrollbar on a fitted image.
const scaled = (size: MediaSize, scale: number): MediaSize => ({
  width: Math.floor(size.width * scale),
  height: Math.floor(size.height * scale),
});

const revealLabel = (): string => (isMac() ? "Reveal in Finder" : "Show in folder");

/**
 * The viewer for the files a piece of agent text names: one at a time at
 * full size (fit or actual size), a slideshow in the order the agent listed
 * them, and an A B comparison of any two images, side by side or under one
 * divider at the same scale.
 *
 * A ui Dialog: it takes its layer, Escape and focus from where it is opened.
 */
export function PreviewViewer({
  items,
  thumbs,
  load,
  source,
  startAt,
  onClose,
}: {
  /** What can be shown, in the order written. */
  readonly items: ReadonlyArray<PreviewRef>;
  readonly thumbs: ReadonlyMap<string, PreviewResult>;
  readonly load: PreviewLoad;
  readonly source: PreviewSource;
  /** Path of the item to open on. */
  readonly startAt: string;
  readonly onClose: () => void;
}) {
  const [path, setPath] = useState(startAt);
  const [zoomed, setZoomed] = useState(false);
  const [compare, setCompare] = useState<Compare | null>(null);
  const [split, setSplit] = useState(50);
  const [playing, setPlaying] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [natural, setNatural] = useState<ReadonlyMap<string, MediaSize>>(() => new Map());
  const [areaRef, area] = useElementSize();

  const index = Math.max(0, items.findIndex((ref) => ref.path === path));
  const current = items[index]!;
  const images = useMemo(
    () => items.filter((ref) => ref.kind === "image" && thumbs.get(ref.path)?.ok !== false),
    [items, thumbs],
  );
  const pair = previewComparePair(images);

  // Only what is on the stage is read at full size.
  const wanted = useMemo(
    () => items.filter((ref) => (compare ? ref.path === compare.a || ref.path === compare.b : ref.path === path)),
    [items, compare, path],
  );
  const full = usePreviews(load, wanted, "full");

  const go = (step: number): void => {
    const next = items[index + step];
    if (!next) return;
    setPath(next.path);
    setZoomed(false);
  };
  const noteNatural = (key: string, size: MediaSize): void =>
    setNatural((known) => {
      const prior = known.get(key);
      return prior && prior.width === size.width && prior.height === size.height ? known : new Map(known).set(key, size);
    });
  const toggleCompare = (): void => {
    setPlaying(false);
    setZoomed(false);
    setCompare((now) => (now || !pair ? null : { a: pair[0].path, b: pair[1].path, mode: "side" }));
  };

  // The slideshow: one step every few seconds, held while the pointer rests
  // on the stage, ended by the last image, any key, or the window going away.
  useEffect(() => {
    if (!playing || hovered || compare) return;
    if (index >= items.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => go(1), SLIDE_MS);
    return () => window.clearTimeout(timer);
  });
  useEffect(() => {
    if (!playing) return;
    const stop = (): void => setPlaying(false);
    const onVisibility = (): void => {
      if (document.hidden) stop();
    };
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [playing]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape" || event.key === "Tab" || event.key === "Shift") return;
    setPlaying(false);
    if (isOperatorTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      if (compare) return;
      event.preventDefault();
      go(event.key === "ArrowRight" ? 1 : -1);
    } else if (event.key === "c" && pair) {
      event.preventDefault();
      toggleCompare();
    } else if (event.key === "z" && (compare || current.kind === "image")) {
      event.preventDefault();
      setZoomed((now) => !now);
    }
  };

  const reveal = (target: string): void => {
    void getJuntoApi()?.previewReveal?.(source, target);
  };

  const result = full.get(current.path);
  const image = result?.ok && result.kind === "image" ? result : undefined;
  const size = natural.get(current.path);
  const space = { width: area.width - STAGE_PAD, height: area.height - STAGE_PAD };

  let title: string = current.name;
  let eyebrow: string | undefined = current.caption;
  const facts: string[] = [];
  let stage: ReactNode;

  if (compare) {
    const refA = images.find((ref) => ref.path === compare.a) ?? images[0]!;
    const refB = images.find((ref) => ref.path === compare.b) ?? images[1] ?? refA;
    const resultA = full.get(refA.path);
    const resultB = full.get(refB.path);
    const srcA = resultA?.ok && resultA.kind === "image" ? resultA.dataUrl : undefined;
    const srcB = resultB?.ok && resultB.kind === "image" ? resultB.dataUrl : undefined;
    const sizeA = natural.get(refA.path);
    const sizeB = natural.get(refB.path);
    const differ = sizeA && sizeB && (sizeA.width !== sizeB.width || sizeA.height !== sizeB.height);
    // One scale for both, read off the larger of each edge, so neither is
    // stretched to meet the other.
    const union = sizeA && sizeB
      ? { width: Math.max(sizeA.width, sizeB.width), height: Math.max(sizeA.height, sizeB.height) }
      : undefined;
    const paneSpace = compare.mode === "side"
      ? { width: (area.width - 1) / 2 - STAGE_PAD, height: space.height - 20 }
      : space;
    const scale = zoomed || !union ? 1 : fitScale(union, paneSpace);
    title = "Compare";
    eyebrow = undefined;
    if (union) facts.push(`${Math.round(scale * 100)}%`);
    if (differ) facts.push("sizes differ");

    const options = images.map((ref) => ({ value: ref.path, label: ref.caption ? `${ref.caption}, ${ref.name}` : ref.name }));
    const stateOf = (src: string | undefined, r: PreviewResult | undefined) =>
      src !== undefined ? "ready" as const : r === undefined ? "loading" as const : "failed" as const;
    const panes = [
      { side: "A" as const, ref: refA, src: srcA, result: resultA, size: sizeA },
      { side: "B" as const, ref: refB, src: srcB, result: resultB, size: sizeB },
    ];
    stage = (
      <>
        <div className="preview-viewer__compare-bar">
          <Button size="sm" variant={compare.mode === "side" ? "primary" : "chrome"} aria-pressed={compare.mode === "side"} onClick={() => setCompare({ ...compare, mode: "side" })}>
            Side by side
          </Button>
          <Button size="sm" variant={compare.mode === "swipe" ? "primary" : "chrome"} aria-pressed={compare.mode === "swipe"} onClick={() => setCompare({ ...compare, mode: "swipe" })}>
            Swipe
          </Button>
          <span className="preview-viewer__pick">
            A
            <Dropdown aria-label="Image A" value={refA.path} options={options} onChange={(a) => setCompare({ ...compare, a })} />
          </span>
          <span className="preview-viewer__pick">
            B
            <Dropdown aria-label="Image B" value={refB.path} options={options} onChange={(b) => setCompare({ ...compare, b })} />
          </span>
        </div>
        <div ref={areaRef} className="preview-viewer__area" data-testid="preview-compare" data-mode={compare.mode}>
          {compare.mode === "swipe" && srcA !== undefined && srcB !== undefined && sizeA && sizeB ? (
            <div className="preview-viewer__swipe">
              <div className="preview-viewer__swipe-fit">
                <CompareSlider
                  a={{ src: srcA, size: scaled(sizeA, scale) }}
                  b={{ src: srcB, size: scaled(sizeB, scale) }}
                  value={split}
                  onChange={setSplit}
                  labelA={refA.name}
                  labelB={refB.name}
                />
              </div>
            </div>
          ) : (
            // Also where both images are first measured, whichever mode is asked for.
            <ComparePanes panes={panes} stateOf={stateOf} scale={union ? scale : undefined} zoomed={zoomed} onToggleZoom={() => setZoomed((now) => !now)} onNatural={noteNatural} />
          )}
        </div>
      </>
    );
  } else {
    facts.push(`${index + 1} of ${items.length}`);
    if (image && size) {
      const scale = zoomed ? 1 : fitScale(size, space);
      facts.push(`${size.width} × ${size.height}`, formatPreviewBytes(image.byteLength), `${Math.round(scale * 100)}%`);
    } else if (result?.ok) {
      facts.push(formatPreviewBytes(result.byteLength));
    }
    stage = (
      <div
        ref={areaRef}
        className="preview-viewer__area"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {result?.ok && result.kind === "text" ? (
          <div className="preview-viewer__text" data-testid="preview-text" tabIndex={0}>
            {result.format === "markdown" ? <ArtifactMarkdown source={result.text} /> : <pre>{result.text}</pre>}
            {result.truncated ? (
              <p className="preview-viewer__note">
                Showing the first {formatPreviewBytes(new TextEncoder().encode(result.text).length)} of {formatPreviewBytes(result.byteLength)}.
              </p>
            ) : null}
          </div>
        ) : result?.ok && result.kind === "file" ? (
          <div className="preview-viewer__file" data-testid="preview-file">
            <p className="preview-viewer__file-name">{result.name}</p>
            <p className="preview-viewer__note">
              {result.extension ? `${result.extension.toUpperCase()} file` : "File"}, {formatPreviewBytes(result.byteLength)}
            </p>
            <Button size="sm" variant="chrome" onClick={() => reveal(current.path)}>
              <FolderOpen size={12} aria-hidden />
              {revealLabel()}
            </Button>
          </div>
        ) : (
          <div key={current.path} className="preview-viewer__slide">
            <MediaStage
              state={image ? "ready" : result === undefined ? "loading" : "failed"}
              src={image?.dataUrl}
              alt={current.caption ?? current.name}
              size={zoomed && size ? size : undefined}
              zoomed={zoomed}
              onToggleZoom={() => setZoomed((now) => !now)}
              onNaturalSize={(next) => noteNatural(current.path, next)}
            />
          </div>
        )}
        {items.length > 1 ? (
          <>
            <IconButton
              className="preview-viewer__step preview-viewer__step--previous"
              aria-label="Previous"
              title="Previous (←)"
              disabled={index === 0}
              onClick={() => go(-1)}
            >
              <ChevronLeft size={15} />
            </IconButton>
            <IconButton
              className="preview-viewer__step preview-viewer__step--next"
              aria-label="Next"
              title="Next (→)"
              disabled={index === items.length - 1}
              onClick={() => go(1)}
            >
              <ChevronRight size={15} />
            </IconButton>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <Dialog
      title={<span data-testid="preview-viewer-title">{title}</span>}
      eyebrow={eyebrow}
      onClose={onClose}
      width={1180}
      className="preview-viewer"
      testId="preview-viewer"
      onKeyDown={onKeyDown}
    >
      <div className="preview-viewer__bar">
        <span className="text-body text-dim tabular-nums" data-testid="preview-viewer-status">
          {facts.join(", ")}
        </span>
        <span className="preview-viewer__actions">
          {!compare && items.length > 1 ? (
            <IconButton
              size="sm"
              aria-label={playing ? "Pause slideshow" : "Play slideshow"}
              title={playing ? "Pause slideshow" : "Play slideshow"}
              disabled={index === items.length - 1 && !playing}
              onClick={() => setPlaying((now) => !now)}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </IconButton>
          ) : null}
          {pair ? (
            <IconButton
              size="sm"
              tone={compare ? "accent" : "default"}
              aria-label="Compare two images"
              aria-pressed={compare !== null}
              title="Compare two images (c)"
              onClick={toggleCompare}
            >
              <Columns2 size={14} />
            </IconButton>
          ) : null}
          {!compare ? (
            <IconButton size="sm" aria-label={revealLabel()} title={revealLabel()} onClick={() => reveal(current.path)}>
              <FolderOpen size={14} />
            </IconButton>
          ) : null}
          <IconButton size="sm" aria-label="Close viewer" title="Close (Esc)" onClick={onClose}>
            <X size={14} />
          </IconButton>
        </span>
      </div>
      {stage}
      {!compare && items.length > 1 ? (
        <ThumbnailStrip variant="film" label="All files">
          {items.map((ref) => {
            const tile = previewTile(ref, thumbs.get(ref.path));
            return (
              <Thumbnail
                key={ref.path}
                size="sm"
                state={tile.state}
                src={tile.src}
                extension={tile.extension}
                label={ref.caption ? `${ref.caption}, ${ref.name}` : ref.name}
                current={ref.path === current.path}
                onClick={() => {
                  setPath(ref.path);
                  setZoomed(false);
                }}
              />
            );
          })}
        </ThumbnailStrip>
      ) : null}
    </Dialog>
  );
}

type Pane = {
  readonly side: "A" | "B";
  readonly ref: PreviewRef;
  readonly src: string | undefined;
  readonly result: PreviewResult | undefined;
  readonly size: MediaSize | undefined;
};

/** Two stages on one scale, panned together. */
function ComparePanes({
  panes,
  stateOf,
  scale,
  zoomed,
  onToggleZoom,
  onNatural,
}: {
  readonly panes: ReadonlyArray<Pane>;
  readonly stateOf: (src: string | undefined, result: PreviewResult | undefined) => "ready" | "loading" | "failed";
  /** Undefined until both images are measured. */
  readonly scale: number | undefined;
  readonly zoomed: boolean;
  readonly onToggleZoom: () => void;
  readonly onNatural: (path: string, size: MediaSize) => void;
}) {
  const scrollers = useRef<(HTMLDivElement | null)[]>([null, null]);
  const pan = (from: HTMLDivElement): void => {
    for (const other of scrollers.current) {
      if (!other || other === from) continue;
      if (other.scrollLeft !== from.scrollLeft) other.scrollLeft = from.scrollLeft;
      if (other.scrollTop !== from.scrollTop) other.scrollTop = from.scrollTop;
    }
  };
  return (
    <div className="preview-viewer__panes">
      {panes.map((pane, at) => (
        <div key={pane.side} className="preview-viewer__pane">
          <MediaStage
            state={stateOf(pane.src, pane.result)}
            src={pane.src}
            alt={pane.ref.caption ?? pane.ref.name}
            size={scale !== undefined && pane.size ? scaled(pane.size, scale) : undefined}
            zoomed={zoomed}
            onToggleZoom={onToggleZoom}
            onNaturalSize={(size) => onNatural(pane.ref.path, size)}
            scrollRef={(element) => {
              scrollers.current[at] = element;
            }}
            onScroll={pan}
          >
            <CompareTag side={pane.side} />
          </MediaStage>
          <p className="preview-viewer__pane-name" title={pane.ref.path}>
            {pane.ref.caption ? `${pane.ref.caption}, ${pane.ref.name}` : pane.ref.name}
          </p>
        </div>
      ))}
    </div>
  );
}
