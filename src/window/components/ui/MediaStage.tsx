import type { ReactNode, Ref } from "react";
import { AlertTriangle } from "lucide-react";
import type { ThumbnailState } from "./Thumbnail";

export type MediaSize = { readonly width: number; readonly height: number };

/**
 * MediaStage: the dark well one image is shown in, whole. By default the
 * image fits the stage and is never drawn larger than it is, so a screenshot
 * stays sharp. Give `size` to lay it out at exact pixels instead (actual
 * size, or one scale shared by two stages): the stage then scrolls.
 *
 * It only draws. The caller hands it the pixels and the state, and hears the
 * image's real size from `onNaturalSize`.
 */
export function MediaStage({
  state,
  src,
  alt,
  size,
  zoomed = false,
  onToggleZoom,
  onNaturalSize,
  scrollRef,
  onScroll,
  children,
}: {
  readonly state: ThumbnailState;
  readonly src?: string;
  readonly alt: string;
  /** Exact layout size in CSS px. Absent: fit the stage. */
  readonly size?: MediaSize;
  /** The image is at its own size and a click fits it again. */
  readonly zoomed?: boolean;
  /** A click on the image: switch between fit and actual size. */
  readonly onToggleZoom?: () => void;
  readonly onNaturalSize?: (size: MediaSize) => void;
  /** The scrolling element, for a caller that pans two stages together. */
  readonly scrollRef?: Ref<HTMLDivElement>;
  readonly onScroll?: (element: HTMLDivElement) => void;
  /** Laid over the stage: a comparison tag, previous and next. */
  readonly children?: ReactNode;
}) {
  return (
    <div className="group/stage relative min-h-0 min-w-0 flex-1 bg-well" data-state={state}>
      <div
        ref={scrollRef}
        className="absolute inset-0 overflow-auto p-4"
        onScroll={onScroll ? (event) => onScroll(event.currentTarget) : undefined}
      >
        {/* Sized: centred while it fits, scrolled from the top left when it does not. */}
        <div
          className={
            size
              ? "grid min-h-full min-w-full w-max place-items-center"
              : "grid size-full grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] place-items-center"
          }
        >
          {state === "ready" && src !== undefined ? (
            <img
              src={src}
              alt={alt}
              draggable={false}
              onLoad={(event) =>
                onNaturalSize?.({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
              onClick={onToggleZoom}
              style={size ? { width: size.width, height: size.height } : undefined}
              className={[
                "rounded-sm",
                size ? "max-w-none flex-none" : "max-h-full max-w-full object-contain",
                onToggleZoom ? (zoomed ? "cursor-zoom-out" : "cursor-zoom-in") : "",
              ].join(" ")}
            />
          ) : state === "failed" ? (
            <AlertTriangle size={14} className="text-dim" aria-label="Could not be shown" />
          ) : null}
        </div>
      </div>
      {children}
    </div>
  );
}
