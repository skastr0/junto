import type { ButtonHTMLAttributes, ReactNode } from "react";
import { AlertTriangle, File } from "lucide-react";

export type ThumbnailSize = "sm" | "md" | "lg";
/** What the tile draws. Required: an empty box is never an accident. */
export type ThumbnailState = "loading" | "ready" | "failed";

const SIZES: Readonly<Record<ThumbnailSize, string>> = {
  sm: "size-12",
  md: "size-18",
  lg: "size-24",
};

const TILE =
  "relative grid flex-none place-items-center overflow-hidden rounded-md border outline-none transition-colors select-none " +
  "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-cyan/60";

/** The corner mark of one side of a comparison. One definition, either top corner. */
export function CompareTag({ side, corner = "left" }: { readonly side: "A" | "B"; readonly corner?: "left" | "right" }) {
  return (
    <span
      className={[
        "pointer-events-none absolute top-1 rounded-sm bg-ground/80 px-1 text-label uppercase tracking-label text-ink",
        corner === "left" ? "left-1" : "right-1",
      ].join(" ")}
    >
      {side}
    </span>
  );
}

/**
 * Thumbnail: one small square that stands for a file and opens it. An image
 * is cropped to fill the square; anything else is a glyph over its
 * extension. It only draws: the caller hands it the pixels (a data or
 * content URL) and says which state it is in.
 *
 * `failed` is for an image that was found and would not draw. A file that is
 * gone is not a tile at all: the caller says so in words.
 *
 * `label` is the file name, read by title and by assistive tech. Size is a
 * prop; the tile takes no className.
 */
export function Thumbnail({
  size = "md",
  state,
  src,
  label,
  extension,
  glyph,
  tag,
  current = false,
  ...rest
}: {
  readonly size?: ThumbnailSize;
  readonly state: ThumbnailState;
  /** The image. Without one a ready tile is a file: glyph and extension. */
  readonly src?: string;
  readonly label: string;
  /** Shown under the glyph of a file tile, without the dot. */
  readonly extension?: string;
  /** A 16px lucide glyph for a file tile. Default: a plain file. */
  readonly glyph?: ReactNode;
  readonly tag?: "A" | "B";
  /** The one being shown, in a filmstrip. */
  readonly current?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children" | "title" | "aria-label" | "type">) {
  return (
    <button
      {...rest}
      type="button"
      title={label}
      aria-label={label}
      aria-current={current ? "true" : undefined}
      data-state={state}
      className={[
        TILE,
        SIZES[size],
        current ? "border-ink bg-overlay-2" : "border-stroke bg-inset hover:border-stroke-hi",
      ].join(" ")}
    >
      {state === "failed" ? (
        <AlertTriangle size={14} className="text-dim" aria-hidden />
      ) : state === "loading" ? null : src !== undefined ? (
        <img src={src} alt="" draggable={false} decoding="async" className="size-full object-cover object-center" />
      ) : (
        <span className="grid justify-items-center gap-1 text-dim">
          {glyph ?? <File size={16} aria-hidden />}
          {extension ? (
            <span className="max-w-full truncate px-1 text-label uppercase tracking-label">{extension}</span>
          ) : null}
        </span>
      )}
      {tag ? <CompareTag side={tag} /> : null}
    </button>
  );
}

/** The tile that stands for the items a strip does not show: "+3". */
export function ThumbnailMore({
  size = "md",
  count,
  ...rest
}: {
  readonly size?: ThumbnailSize;
  readonly count: number;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children" | "type">) {
  return (
    <button
      {...rest}
      type="button"
      aria-label={`${count} more`}
      className={[TILE, SIZES[size], "border-stroke bg-overlay-2 text-body text-dim tabular-nums hover:border-stroke-hi"].join(" ")}
    >
      +{count}
    </button>
  );
}

/**
 * ThumbnailStrip: thumbnails in a row. `card` wraps inside a card's details;
 * `film` is the one scrolling line under a viewer's stage.
 */
export function ThumbnailStrip({
  variant = "card",
  label,
  children,
}: {
  readonly variant?: "card" | "film";
  /** Names the group for assistive tech. */
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={variant === "film" ? "flex flex-none gap-1.5 overflow-x-auto" : "flex flex-wrap gap-2"}
    >
      {children}
    </div>
  );
}
