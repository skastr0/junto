/**
 * What the code editor hangs on its lines: a plus in the gutter that starts a
 * comment, and rows drawn between lines for what a host renders there (a
 * thread, its composer).
 *
 * The plus stands beside the line under the pointer and beside the caret
 * line, so the keyboard reaches it too. A selection over several lines makes
 * the plus on any of them comment on all of them; a press held on the plus and
 * dragged over other lines comments on the lines it passed. Rows between lines
 * follow their line as text is typed above them.
 */
import { RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, type DecorationSet } from "@codemirror/view";

/** Lines a comment hangs on, 1-based and inclusive, with their text as it stands. */
export type LineRange = { readonly start: number; readonly end: number; readonly quote: string };

/** A row drawn after a line; `key` names what the host renders into it. */
export type LineRow = { readonly key: string; readonly line: number };

/** What the host hears and draws, read at the moment of use. */
export type LineHandlers = {
  current: {
    readonly comment?: ((range: LineRange) => void) | undefined;
    readonly mount?: ((key: string, element: HTMLElement) => void) | undefined;
    readonly unmount?: ((key: string, element: HTMLElement) => void) | undefined;
  };
};

export const COMMENT_TEST_ID = "file-editor-gutter-comment";

/** The words on the plus, as the operator hears them. */
export const commentLabel = (start: number, end: number): string =>
  start === end ? `Comment on line ${String(start)}` : `Comment on lines ${String(start)} to ${String(end)}`;

const quoteOf = (state: EditorState, start: number, end: number): string =>
  state.sliceDoc(state.doc.line(start).from, state.doc.line(end).to);

/** The lines a selection spans when it spans more than one, else null. */
const selectedLines = (state: EditorState): { readonly start: number; readonly end: number } | null => {
  const { from, to, empty } = state.selection.main;
  if (empty) return null;
  const start = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to);
  // A selection that ends at a line's start does not take that line.
  const end = last.from === to && last.number > start ? last.number - 1 : last.number;
  return start < end ? { start, end } : null;
};

/** The caret's line: across several lines, the selected line the caret ends on. */
const caretLine = (state: EditorState): number => {
  const selected = selectedLines(state);
  const { head, anchor } = state.selection.main;
  if (selected === null) return state.doc.lineAt(head).number;
  return head >= anchor ? selected.end : selected.start;
};

/** The lines a plus on `line` comments on: the selection's when it spans several lines and holds this one. */
const rangeAt = (state: EditorState, line: number): { readonly start: number; readonly end: number } => {
  const selected = selectedLines(state);
  return selected !== null && line >= selected.start && line <= selected.end ? selected : { start: line, end: line };
};

const hoverEffect = StateEffect.define<number | null>();
const hovered = StateField.define<number | null>({
  create: () => null,
  update(line, tr) {
    for (const effect of tr.effects) if (effect.is(hoverEffect)) return effect.value;
    return line !== null && line > tr.state.doc.lines ? null : line;
  },
});

const dragEffect = StateEffect.define<{ readonly start: number; readonly end: number } | null>();
const dragged = StateField.define<{ readonly start: number; readonly end: number } | null>({
  create: () => null,
  update(range, tr) {
    for (const effect of tr.effects) if (effect.is(dragEffect)) return effect.value;
    return range;
  },
});

const draggedLine = Decoration.line({ class: "cm-commentRange" });
const draggedLines = EditorView.decorations.compute([dragged], (state) => {
  const range = state.field(dragged);
  if (range === null) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (let line = range.start; line <= range.end; line += 1) {
    const at = state.doc.line(line).from;
    builder.add(at, at, draggedLine);
  }
  return builder.finish();
});

const lineAtY = (view: EditorView, clientY: number): number =>
  view.state.doc.lineAt(view.lineBlockAtHeight(clientY - view.documentTop).from).number;

class CommentMarker extends GutterMarker {
  constructor(
    readonly start: number,
    readonly end: number,
    /** The caret's plus is the one the keyboard reaches; the pointer's is for the pointer only. */
    readonly keyboard: boolean,
    readonly handlers: LineHandlers,
  ) {
    super();
  }

  override eq(other: CommentMarker): boolean {
    return other.start === this.start && other.end === this.end && other.keyboard === this.keyboard;
  }

  override toDOM(view: EditorView): Node {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-commentButton";
    button.tabIndex = this.keyboard ? 0 : -1;
    button.setAttribute("aria-label", commentLabel(this.start, this.end));
    button.dataset.testid = COMMENT_TEST_ID;
    const face = document.createElement("span");
    face.className = "cm-commentButton__face";
    face.textContent = "+";
    face.setAttribute("aria-hidden", "true");
    button.append(face);
    const send = (start: number, end: number): void => {
      const low = Math.min(start, end);
      const high = Math.max(start, end);
      this.handlers.current.comment?.({ start: low, end: high, quote: quoteOf(view.state, low, high) });
    };
    // A held press dragged over lines takes them all; a still press takes this plus's lines.
    // The press captures the pointer, so a release lost to the system ends it as a cancel, never as a comment.
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const anchor = this.start;
      let reach: number | null = null;
      let done = false;
      button.setPointerCapture(event.pointerId);
      // Pressed: the pointer's line holds still, so this plus stays drawn under it.
      view.dispatch({ effects: dragEffect.of({ start: anchor, end: anchor }) });
      const finish = (): void => {
        done = true;
        button.removeEventListener("pointermove", move);
        button.removeEventListener("pointerup", up);
        button.removeEventListener("pointercancel", cancel);
        button.removeEventListener("lostpointercapture", cancel);
        if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
        view.dispatch({ effects: dragEffect.of(null) });
      };
      const move = (moved: PointerEvent): void => {
        const line = lineAtY(view, moved.clientY);
        if (line === (reach ?? anchor)) return;
        reach = line;
        view.dispatch({ effects: dragEffect.of({ start: Math.min(anchor, line), end: Math.max(anchor, line) }) });
      };
      const up = (): void => {
        if (done) return;
        finish();
        if (reach === null) send(this.start, this.end);
        else send(anchor, reach);
      };
      const cancel = (): void => {
        if (!done) finish();
      };
      button.addEventListener("pointermove", move);
      button.addEventListener("pointerup", up);
      button.addEventListener("pointercancel", cancel);
      button.addEventListener("lostpointercapture", cancel);
    });
    // Enter or Space on the focused plus: a click with no pointer behind it.
    button.addEventListener("click", (event) => {
      if (event.detail === 0) send(this.start, this.end);
    });
    return button;
  }
}

/** The gutter's width, held by a mark of the plus's size that is no control. */
class SpacerMarker extends GutterMarker {
  override toDOM(): Node {
    const mark = document.createElement("span");
    mark.className = "cm-commentButton";
    mark.setAttribute("aria-hidden", "true");
    return mark;
  }
}
const spacer = new SpacerMarker();

/**
 * The pointer's line, read over the gutter and the text alike, and read again
 * when the text scrolls under a still pointer. It holds still while a plus is
 * pressed, so the pressed plus is not taken from under the pointer.
 */
const hoverTracker = ViewPlugin.define((view) => {
  let lastY: number | null = null;
  let frame: number | null = null;
  const settle = (): void => {
    frame = null;
    if (lastY === null || view.state.field(dragged) !== null) return;
    const line = lineAtY(view, lastY);
    if (view.state.field(hovered) !== line) view.dispatch({ effects: hoverEffect.of(line) });
  };
  const move = (event: PointerEvent): void => {
    lastY = event.clientY;
    settle();
  };
  const scroll = (): void => {
    if (frame === null && lastY !== null) frame = requestAnimationFrame(settle);
  };
  const leave = (): void => {
    lastY = null;
    if (view.state.field(dragged) === null && view.state.field(hovered) !== null) view.dispatch({ effects: hoverEffect.of(null) });
  };
  view.scrollDOM.addEventListener("pointermove", move);
  view.scrollDOM.addEventListener("pointerleave", leave);
  view.scrollDOM.addEventListener("scroll", scroll, { passive: true });
  return {
    destroy: () => {
      if (frame !== null) cancelAnimationFrame(frame);
      view.scrollDOM.removeEventListener("pointermove", move);
      view.scrollDOM.removeEventListener("pointerleave", leave);
      view.scrollDOM.removeEventListener("scroll", scroll);
    },
  };
});

/**
 * The gutter is hidden from assistive tech as a whole, because line numbers
 * are not worth reading out. The comment plus is the one control in a gutter,
 * so its own gutter is shown and every other gutter beside it stays hidden:
 * without this the plus is a button only a mouse can find.
 */
const shownCommentGutter = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      this.sync();
    }

    /** Every update, because the gutter can arrive after this plugin: a compartment reconfigure builds it then. */
    update(): void {
      this.sync();
    }

    private sync(): void {
      const gutters = this.view.dom.querySelector(".cm-gutters");
      if (gutters === null) return;
      if (gutters.hasAttribute("aria-hidden")) gutters.removeAttribute("aria-hidden");
      for (const child of gutters.children) {
        const shown = child.classList.contains("cm-commentGutter");
        const hidden = child.getAttribute("aria-hidden") === "true";
        if (shown && hidden) child.removeAttribute("aria-hidden");
        else if (!shown && !hidden) child.setAttribute("aria-hidden", "true");
      }
    }
  },
);

/** The plus in the gutter, beside the pointer's line and the caret's. */
export const lineComments = (handlers: LineHandlers): Extension => [
  hovered,
  dragged,
  draggedLines,
  hoverTracker,
  gutter({
    class: "cm-commentGutter",
    lineMarker(view, block) {
      const line = view.state.doc.lineAt(block.from).number;
      const caret = line === caretLine(view.state);
      if (!caret && line !== view.state.field(hovered)) return null;
      const { start, end } = rangeAt(view.state, line);
      return new CommentMarker(start, end, caret, handlers);
    },
    lineMarkerChange: (update) =>
      update.selectionSet || update.docChanged || update.startState.field(hovered) !== update.state.field(hovered),
    initialSpacer: () => spacer,
  }),
  // After the gutter, so the gutter it shows exists by the plugin's first look.
  shownCommentGutter,
];

class RowWidget extends WidgetType {
  constructor(
    readonly key: string,
    readonly handlers: LineHandlers,
  ) {
    super();
  }

  override eq(other: RowWidget): boolean {
    return other.key === this.key;
  }

  override toDOM(view: EditorView): HTMLElement {
    const element = document.createElement("div");
    element.className = "cm-lineRow";
    element.dataset.row = this.key;
    // What the host draws grows and shrinks; the editor measures again. Where there is no observer (jsdom), it is measured as drawn.
    if (typeof ResizeObserver !== "undefined") {
      const sizes = new ResizeObserver(() => view.requestMeasure());
      sizes.observe(element);
      observers.set(element, sizes);
    }
    this.handlers.current.mount?.(this.key, element);
    return element;
  }

  override destroy(element: HTMLElement): void {
    observers.get(element)?.disconnect();
    observers.delete(element);
    this.handlers.current.unmount?.(this.key, element);
  }

  // A composer inside takes its own keys and presses.
  override ignoreEvent(): boolean {
    return true;
  }
}

const observers = new WeakMap<HTMLElement, ResizeObserver>();

/** Put rows after lines; the list replaces the last one. */
export const setLineRows = StateEffect.define<ReadonlyArray<LineRow>>();

/** Rows between lines, each after its line, following it as text is typed above. */
export const lineRows = (handlers: LineHandlers): Extension =>
  StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(rows, tr) {
      for (const effect of tr.effects) {
        if (!effect.is(setLineRows)) continue;
        const sorted = [...effect.value].filter((row) => row.line >= 1 && row.line <= tr.state.doc.lines).sort((a, b) => a.line - b.line);
        return Decoration.set(
          sorted.map((row) =>
            Decoration.widget({ widget: new RowWidget(row.key, handlers), block: true, side: 1 }).range(tr.state.doc.line(row.line).to),
          ),
        );
      }
      return rows.map(tr.changes);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
