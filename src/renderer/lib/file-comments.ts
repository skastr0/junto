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

/**
 * The anchor a drawn box writes: the page, and its fractions of that page.
 * The viewers normalise the box already (`ViewBox`, 0..1), so it goes as is.
 */
export const boxAnchorOf = (drawn: {
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}): FileBoxAnchor => ({
  kind: "pageBox",
  page: drawn.page,
  x: drawn.x,
  y: drawn.y,
  w: drawn.w,
  h: drawn.h,
});
