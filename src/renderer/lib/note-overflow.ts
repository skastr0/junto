/**
 * A note whose text runs past its box is marked `data-overflows`, and only
 * then does its last line fade out (styles.css, .note-md), so no line is cut
 * through its glyphs and a note that fits is left as it is.
 *
 * One ResizeObserver serves every note on the canvas. It watches the note's
 * box, which a resize changes, and each block inside it, which an image
 * landing or a font settling grows without moving the box. The mark is set on
 * the element itself: no React state, so a resize renders nothing.
 */

const watched = new Map<Element, HTMLElement>();
let observer: ResizeObserver | undefined;

const mark = (note: HTMLElement): void => {
  note.toggleAttribute("data-overflows", note.scrollHeight > note.clientHeight);
};

const onResize = (entries: ReadonlyArray<ResizeObserverEntry>): void => {
  const notes = new Set<HTMLElement>();
  for (const entry of entries) {
    const note = watched.get(entry.target);
    if (note !== undefined) notes.add(note);
  }
  for (const note of notes) mark(note);
};

/** Mark `note` while its text overflows; returns the release. Call again when its blocks change. */
export const watchNoteOverflow = (note: HTMLElement): (() => void) => {
  const targets = [note, ...note.children];
  if (typeof ResizeObserver !== "function") {
    mark(note);
    return () => note.removeAttribute("data-overflows");
  }
  observer ??= new ResizeObserver(onResize);
  for (const target of targets) {
    watched.set(target, note);
    observer.observe(target);
  }
  mark(note);
  return () => {
    for (const target of targets) {
      observer?.unobserve(target);
      watched.delete(target);
    }
    note.removeAttribute("data-overflows");
  };
};
