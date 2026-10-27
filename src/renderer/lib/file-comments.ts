/**
 * A file's threads, placed on the file (0.11 F7, `src/shared/thread-subject.ts`).
 *
 * A thread hangs on the lines it was written on, or on a box on one of the
 * file's pages, or on the whole file. Lines move as the file is edited, so a
 * lines anchor quotes the text it was written on and the thread is drawn on
 * the place the quote is now (`locateLines`); a thread whose text is gone is
 * listed in the rail and drawn nowhere. Pure: text in, places out.
 */
import type { Anchor, FileBoxAnchor, LinesAnchor } from "@shared/thread-subject";
import { locateLines } from "@shared/thread-subject";
import type { SubjectThread } from "./subject-threads-source";

/** Where a thread hangs now. */
export type FileThreadPlace =
  | { readonly kind: "whole" }
  /** Its lines, as quoted, at the line they read at now. */
  | { readonly kind: "lines"; readonly anchor: LinesAnchor; readonly from: number; readonly to: number; readonly moved: boolean }
  /** Its text is no longer in the file: the rail lists it, the file draws it nowhere. */
  | { readonly kind: "lost"; readonly anchor: LinesAnchor }
  /** A box on one of the file's pages, normalised 0..1 of that page. */
  | { readonly kind: "box"; readonly anchor: FileBoxAnchor };

export type PlacedFileThread = { readonly thread: SubjectThread; readonly place: FileThreadPlace };

/** A place on the file now, from its anchor and the text as it stands. */
export const filePlaceOf = (anchor: Anchor | undefined, text: string): FileThreadPlace => {
  if (anchor === undefined) return { kind: "whole" };
  if (anchor.kind === "pageBox") return { kind: "box", anchor };
  if (anchor.kind !== "lines") return { kind: "whole" };
  const at = locateLines(anchor, text);
  if (at === undefined) return { kind: "lost", anchor };
  return { kind: "lines", anchor, from: at.from, to: at.to, moved: at.from !== anchor.from || at.to !== anchor.to };
};

/** Every thread of the file, placed, in time order as the source lists them. */
export const placedFileThreads = (threads: ReadonlyArray<SubjectThread>, text: string): ReadonlyArray<PlacedFileThread> =>
  threads.map((thread) => ({ thread, place: filePlaceOf(thread.anchor, text) }));

/** The first line a thread is drawn from, for the rail's press; undefined when the file no longer holds it. */
export const revealedLine = (place: FileThreadPlace): number | undefined => (place.kind === "lines" ? place.from : undefined);

/** What a thread's place is called, in the rail and above a row. */
export const placeLabel = (place: FileThreadPlace): string => {
  switch (place.kind) {
    case "whole":
      return "Whole file";
    case "lines":
      return place.from === place.to ? `Line ${String(place.from)}` : `Lines ${String(place.from)} to ${String(place.to)}`;
    case "lost":
      return "Its lines are gone";
    case "box":
      return place.anchor.page === 1 ? "Area on the image" : `Area on page ${String(place.anchor.page)}`;
  }
};

/** The most lines a press may cover in one comment: a block, not a file. */
export const LINES_COMMENT_MAX = 200;

/** A press on the gutter's plus, as the file's composer holds it. */
export type LineDraft = { readonly start: number; readonly end: number; readonly quote: string };

/** The lines a press may comment on: at most LINES_COMMENT_MAX, and never empty. */
export const lineDraftOf = (range: { readonly start: number; readonly end: number; readonly quote: string }): LineDraft | undefined => {
  const start = Math.max(1, Math.min(range.start, range.end));
  const end = Math.max(start, Math.min(Math.max(range.start, range.end), start + LINES_COMMENT_MAX - 1));
  return range.quote.trim() === "" ? undefined : { start, end, quote: range.quote };
};

/** The anchor a line draft writes: the file's own path, its lines, and their text. */
export const lineAnchorOf = (path: string, draft: LineDraft): LinesAnchor => ({
  kind: "lines",
  file: path,
  from: draft.start,
  to: draft.end,
  quote: draft.quote.length > 1_000 ? draft.quote.slice(0, 1_000) : draft.quote,
});

/** A box drawn on a page, as the drawing hands it over: fractions of the page's box. */
export type BoxDraft = { readonly page: number; readonly x: number; readonly y: number; readonly w: number; readonly h: number };

/** A box smaller than this on either side, in page fractions, is a click and not a drawing. */
export const BOX_DRAFT_MIN = 0.01;

/**
 * The box a drag covers on a page, clamped to it and normalised 0..1: the
 * anchor a comment on an image or a PDF page carries. Undefined for a drag
 * too small to be a box.
 */
export const boxDraftOf = (
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
  size: { readonly width: number; readonly height: number },
  page = 1,
): BoxDraft | undefined => {
  if (size.width <= 0 || size.height <= 0) return undefined;
  const clamp = (value: number): number => Math.min(1, Math.max(0, value));
  const x = clamp(Math.min(from.x, to.x) / size.width);
  const y = clamp(Math.min(from.y, to.y) / size.height);
  const w = clamp(Math.max(from.x, to.x) / size.width) - x;
  const h = clamp(Math.max(from.y, to.y) / size.height) - y;
  return w < BOX_DRAFT_MIN || h < BOX_DRAFT_MIN ? undefined : { page, x, y, w, h };
};

/** The anchor a box draft writes. */
export const boxAnchorOf = (draft: BoxDraft): FileBoxAnchor => ({
  kind: "pageBox",
  page: draft.page,
  x: draft.x,
  y: draft.y,
  w: draft.w,
  h: draft.h,
});

/** A box as the layer draws it over the page it was drawn on, in that page's fractions. */
export const boxRectOf = (anchor: FileBoxAnchor): { readonly left: string; readonly top: string; readonly width: string; readonly height: string } => ({
  left: `${String(anchor.x * 100)}%`,
  top: `${String(anchor.y * 100)}%`,
  width: `${String(anchor.w * 100)}%`,
  height: `${String(anchor.h * 100)}%`,
});
