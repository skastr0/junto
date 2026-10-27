import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  type EditorState,
  type Extension,
  Prec,
  type Range,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { claimFocus } from "../../lib/focus-ownership";
import { safeArtifactMarkdownUrl } from "../work/ArtifactMarkdown";

/**
 * Live preview for a markdown document: the source is the document, and it
 * is drawn rendered. Syntax shows only on the lines the caret or selection
 * touches (a table or a fenced block shows whole), so a click on a line
 * opens it for editing and moving off renders it again. Nothing here changes
 * the text: every edit is the operator's own keystroke.
 */

/** A comment's place in the text: the quote it hangs on, near where it was taken. */
export type DocumentAnchor = { readonly id: string; readonly quote: string; readonly offset: number };

/** What the editor tells its owner about, read at the moment it happens. */
export type LiveMarkdownHandlers = {
  current: {
    readonly onAnchor?: ((id: string) => void) | undefined;
  };
};

/** The operator came into the editor or left it; the view sends this itself. */
export const setFocused = StateEffect.define<boolean>();
const setAnchors = StateEffect.define<ReadonlyArray<DocumentAnchor>>();
const flashAnchor = StateEffect.define<{ readonly id: string; readonly nonce: number }>();

/** Whether the operator is in the editor: off it, every line renders. */
const focused = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => tr.effects.reduce((next, effect) => (effect.is(setFocused) ? effect.value : next), value),
});

const anchors = StateField.define<{
  readonly list: ReadonlyArray<DocumentAnchor>;
  readonly flash: { readonly id: string; readonly nonce: number } | null;
}>({
  create: () => ({ list: [], flash: null }),
  update: (value, tr) => {
    let next = value;
    for (const effect of tr.effects) {
      if (effect.is(setAnchors)) next = { ...next, list: effect.value };
      if (effect.is(flashAnchor)) next = { ...next, flash: effect.value };
    }
    return next;
  },
});

/**
 * Where a quote sits now: at its offset when the text there still reads it,
 * otherwise the nearest place that does, or null once it is gone.
 */
export const resolveAnchor = (doc: string, quote: string, offset: number): { from: number; to: number } | null => {
  if (quote.length === 0) return null;
  if (doc.startsWith(quote, offset)) return { from: offset, to: offset + quote.length };
  let best: number | null = null;
  for (let at = doc.indexOf(quote); at !== -1; at = doc.indexOf(quote, at + 1)) {
    if (best === null || Math.abs(at - offset) < Math.abs(best - offset)) best = at;
  }
  return best === null ? null : { from: best, to: best + quote.length };
};

/** Set the comment anchors drawn in the text. */
export const anchorsEffect = (list: ReadonlyArray<DocumentAnchor>) => setAnchors.of(list);

/** Scroll an anchor into view and flash it; null when its quote is no longer in the text. */
export const revealAnchorEffects = (
  state: EditorState,
  id: string,
  nonce: number,
): ReadonlyArray<StateEffect<unknown>> | null => {
  const anchor = state.field(anchors).list.find((candidate) => candidate.id === id);
  const range = anchor ? resolveAnchor(state.doc.toString(), anchor.quote, anchor.offset) : null;
  if (range === null) return null;
  return [EditorView.scrollIntoView(range.from, { y: "center" }), flashAnchor.of({ id, nonce })];
};

class HiddenSpan extends WidgetType {
  override toDOM(): HTMLElement {
    return document.createElement("span");
  }
}

class Bullet extends WidgetType {
  override eq(): boolean {
    return true;
  }
  override toDOM(): HTMLElement {
    const bullet = document.createElement("span");
    bullet.className = "cm-md-bullet";
    bullet.setAttribute("aria-hidden", "true");
    return bullet;
  }
}

class Checkbox extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  override eq(other: Checkbox): boolean {
    return other.checked === this.checked;
  }
  override toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-md-checkbox";
    box.checked = this.checked;
    box.disabled = view.state.readOnly;
    box.setAttribute("aria-label", this.checked ? "Done" : "Not done");
    box.addEventListener("mousedown", (event) => event.preventDefault());
    box.addEventListener("click", (event) => {
      event.preventDefault();
      if (view.state.readOnly) return;
      // `[ ]` or `[x]`: the mark sits one in from where the widget starts.
      const at = view.posAtDOM(box) + 1;
      view.dispatch({ changes: { from: at, to: at + 1, insert: this.checked ? " " : "x" }, userEvent: "input" });
    });
    return box;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

class Rule extends WidgetType {
  override eq(): boolean {
    return true;
  }
  override toDOM(): HTMLElement {
    const rule = document.createElement("span");
    rule.className = "cm-md-rule";
    rule.setAttribute("role", "separator");
    return rule;
  }
}

class FenceLabel extends WidgetType {
  constructor(readonly info: string) {
    super();
  }
  override eq(other: FenceLabel): boolean {
    return other.info === this.info;
  }
  override toDOM(): HTMLElement {
    const label = document.createElement("span");
    label.className = "cm-md-fence-label";
    label.textContent = this.info;
    return label;
  }
}

class Picture extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  override eq(other: Picture): boolean {
    return other.src === this.src && other.alt === this.alt;
  }
  override toDOM(): HTMLElement {
    const img = document.createElement("img");
    img.className = "cm-md-image";
    img.src = this.src;
    img.alt = this.alt;
    img.loading = "lazy";
    img.decoding = "async";
    return img;
  }
}

type TableCell = { readonly at: number; readonly node: SyntaxNode | null };
type TableModel = {
  readonly source: string;
  readonly align: ReadonlyArray<"left" | "center" | "right" | null>;
  readonly rows: ReadonlyArray<ReadonlyArray<TableCell>>;
};

/** A row's cells, split at its pipes; `at` is where typing into the cell starts, from the table's start. */
const rowCells = (state: EditorState, row: SyntaxNode, tableFrom: number): TableCell[] => {
  const line = state.doc.lineAt(row.from);
  const pipes: number[] = [];
  const cells: SyntaxNode[] = [];
  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableDelimiter") pipes.push(child.from);
    else if (child.name === "TableCell") cells.push(child);
  }
  const bounds = [...pipes];
  if (pipes[0] !== undefined && state.doc.sliceString(line.from, pipes[0]).trim().length > 0) bounds.unshift(line.from - 1);
  if (pipes.length === 0) bounds.push(line.from - 1);
  const last = pipes.at(-1);
  if (last === undefined || state.doc.sliceString(last + 1, line.to).trim().length > 0) bounds.push(line.to);
  const out: TableCell[] = [];
  for (let index = 0; index + 1 < bounds.length; index += 1) {
    const from = bounds[index]! + 1;
    const to = bounds[index + 1]!;
    const node = cells.find((cell) => cell.from >= from && cell.to <= to) ?? null;
    const text = state.doc.sliceString(from, to);
    const lead = text.length - text.trimStart().length;
    out.push({ at: (node?.from ?? Math.min(from + lead, to)) - tableFrom, node });
  }
  return out;
};

const tableModel = (state: EditorState, table: SyntaxNode): TableModel => {
  const from = state.doc.lineAt(table.from).from;
  const rows: TableCell[][] = [];
  let align: TableModel["align"] = [];
  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableHeader" || child.name === "TableRow") rows.push(rowCells(state, child, from));
    else if (child.name === "TableDelimiter") {
      align = state.doc
        .sliceString(child.from, child.to)
        .replace(/^\s*\|/u, "")
        .replace(/\|\s*$/u, "")
        .split("|")
        .map((spec) => {
          const cell = spec.trim();
          const left = cell.startsWith(":");
          const right = cell.endsWith(":");
          return left && right ? "center" : right ? "right" : left ? "left" : null;
        });
    }
  }
  return { source: state.doc.sliceString(from, state.doc.lineAt(table.to).to), align, rows };
};

const INLINE_TAGS: Readonly<Record<string, string>> = {
  Emphasis: "em",
  StrongEmphasis: "strong",
  Strikethrough: "s",
  InlineCode: "code",
};
const INLINE_MARKS = new Set(["EmphasisMark", "CodeMark", "StrikethroughMark", "LinkMark", "URL", "LinkTitle"]);

/** Draw a span of inline markdown as DOM, its marks left out. */
const inlineDom = (doc: Text, node: SyntaxNode, into: HTMLElement): void => {
  let at = node.from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.from > at) into.append(doc.sliceString(at, child.from));
    at = child.to;
    if (INLINE_MARKS.has(child.name)) continue;
    if (child.name === "Escape") {
      into.append(doc.sliceString(child.from + 1, child.to));
      continue;
    }
    const tag = INLINE_TAGS[child.name];
    const element = document.createElement(tag ?? "span");
    if (child.name === "Link") element.className = "cm-md-link";
    inlineDom(doc, child, element);
    into.append(element);
  }
  if (node.to > at) into.append(doc.sliceString(at, node.to));
};

class TableWidget extends WidgetType {
  constructor(
    readonly model: TableModel,
    readonly doc: Text,
    readonly cells: ReadonlyArray<ReadonlyArray<SyntaxNode | null>>,
  ) {
    super();
  }
  override eq(other: TableWidget): boolean {
    return other.model.source === this.model.source;
  }
  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table";
    const table = document.createElement("table");
    const width = Math.max(...this.model.rows.map((row) => row.length), 0);
    this.model.rows.forEach((row, rowIndex) => {
      const section = rowIndex === 0 ? table.createTHead() : (table.tBodies[0] ?? table.createTBody());
      const tr = section.insertRow();
      for (let column = 0; column < width; column += 1) {
        const cell = document.createElement(rowIndex === 0 ? "th" : "td");
        const source = row[column];
        const node = this.cells[rowIndex]?.[column] ?? null;
        if (source) cell.dataset.at = String(source.at);
        const align = this.model.align[column];
        if (align) cell.style.textAlign = align;
        if (node) inlineDom(this.doc, node, cell);
        tr.append(cell);
      }
    });
    wrap.append(table);
    // A press on a cell puts the caret in that cell's source, which opens the table.
    wrap.addEventListener("mousedown", (event) => {
      if (view.state.readOnly || event.button !== 0) return;
      event.preventDefault();
      const cell = (event.target as Element | null)?.closest<HTMLElement>("[data-at]");
      const at = view.posAtDOM(wrap) + Number(cell?.dataset.at ?? 0);
      view.dispatch({ selection: EditorSelection.cursor(at), scrollIntoView: false, userEvent: "select.pointer" });
      claimFocus(view.contentDOM, "gesture", { event, preventScroll: true });
    });
    return wrap;
  }
  override ignoreEvent(event: Event): boolean {
    return event.type === "mousedown";
  }
}

const hidden = Decoration.replace({ widget: new HiddenSpan() });
const mark = (className: string, attributes?: Record<string, string>) => Decoration.mark({ class: className, attributes });
const line = (className: string) => Decoration.line({ class: className });

const SYNTAX_MARKS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "StrikethroughMark",
  "LinkMark",
  "QuoteMark",
  "ListMark",
  "TaskMarker",
  "CodeInfo",
]);

/** Every decoration for the state: rendered off the caret's lines, source on them. */
const decorate = (state: EditorState): DecorationSet => {
  const doc = state.doc;
  const out: Range<Decoration>[] = [];
  const live = state.field(focused) && !state.readOnly;
  /** Whether the caret or a selection touches a line of this span. */
  const open = (from: number, to: number): boolean => {
    if (!live) return false;
    const start = doc.lineAt(from).from;
    const end = doc.lineAt(to).to;
    return state.selection.ranges.some((range) => range.from <= end && range.to >= start);
  };
  const hide = (from: number, to: number): void => {
    if (to > from) out.push(hidden.range(from, to));
  };
  const lines = (from: number, to: number, className: string): void => {
    for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n += 1) out.push(line(className).range(doc.line(n).from));
  };
  /** A mark and the spaces after it, kept on its line. */
  const hideWithSpace = (node: SyntaxNode): void => {
    const end = doc.lineAt(node.from).to;
    let to = node.to;
    while (to < end && doc.sliceString(to, to + 1) === " ") to += 1;
    hide(node.from, to);
  };

  syntaxTree(state).iterate({
    enter: (ref) => {
      const node = ref.node;
      const name = ref.name;
      if (SYNTAX_MARKS.has(name)) out.push(mark("cm-md-syntax").range(node.from, node.to));
      const heading = /^(?:ATXHeading|SetextHeading)(\d)$/u.exec(name);
      if (heading) {
        out.push(line(`cm-md-h${heading[1]}`).range(doc.lineAt(node.from).from));
        if (open(node.from, node.to)) return;
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (child.name !== "HeaderMark") continue;
          if (name.startsWith("Setext")) {
            hide(child.from, child.to);
            out.push(line("cm-md-collapsed").range(doc.lineAt(child.from).from));
          } else if (child.from === doc.lineAt(child.from).from) hideWithSpace(child);
          else {
            let from = child.from;
            while (from > node.from && doc.sliceString(from - 1, from) === " ") from -= 1;
            hide(from, child.to);
          }
        }
        return;
      }
      switch (name) {
        case "Emphasis":
        case "StrongEmphasis":
        case "Strikethrough":
        case "InlineCode": {
          out.push(mark(`cm-md-${name === "Emphasis" ? "em" : name === "StrongEmphasis" ? "strong" : name === "Strikethrough" ? "strike" : "code"}`).range(node.from, node.to));
          if (!open(node.from, node.to)) {
            for (let child = node.firstChild; child; child = child.nextSibling) {
              if (child.name.endsWith("Mark")) hide(child.from, child.to);
            }
          }
          return;
        }
        case "Link":
        case "Image": {
          const marks = node.getChildren("LinkMark");
          const url = node.getChild("URL");
          const inline = marks.length >= 4 && doc.sliceString(marks[2]!.from, marks[2]!.to) === "(";
          if (!inline || !url) return;
          const href = doc.sliceString(url.from, url.to);
          const labelFrom = marks[0]!.to;
          const labelTo = marks[1]!.from;
          if (name === "Image") {
            const src = safeArtifactMarkdownUrl(href);
            if (src && !open(node.from, node.to)) {
              out.push(Decoration.replace({ widget: new Picture(src, doc.sliceString(labelFrom, labelTo)) }).range(node.from, node.to));
              return false;
            }
            return;
          }
          if (labelTo > labelFrom) out.push(mark("cm-md-link", { "data-href": href }).range(labelFrom, labelTo));
          if (!open(node.from, node.to)) {
            hide(marks[0]!.from, marks[0]!.to);
            hide(marks[1]!.from, node.to);
          }
          return;
        }
        case "Autolink": {
          const url = node.getChild("URL");
          if (url) out.push(mark("cm-md-link", { "data-href": doc.sliceString(url.from, url.to) }).range(url.from, url.to));
          if (!open(node.from, node.to)) for (const linkMark of node.getChildren("LinkMark")) hide(linkMark.from, linkMark.to);
          return false;
        }
        case "URL": {
          if (node.parent?.name === "Link" || node.parent?.name === "Image") return;
          out.push(mark("cm-md-link", { "data-href": doc.sliceString(node.from, node.to) }).range(node.from, node.to));
          return;
        }
        case "Escape":
          if (!open(node.from, node.to)) hide(node.from, node.from + 1);
          return;
        case "Blockquote":
          lines(node.from, node.to, "cm-md-quote");
          return;
        case "QuoteMark":
          if (!open(node.from, node.to)) hideWithSpace(node);
          return;
        case "ListMark": {
          const list = node.parent?.parent?.name;
          const task = node.nextSibling?.name === "Task";
          if (open(node.from, node.to)) return;
          if (task) hideWithSpace(node);
          else if (list === "BulletList") out.push(Decoration.replace({ widget: new Bullet() }).range(node.from, node.to));
          else out.push(mark("cm-md-ordinal").range(node.from, node.to));
          return;
        }
        case "TaskMarker": {
          const checked = /x/iu.test(doc.sliceString(node.from, node.to));
          const task = node.parent;
          if (checked && task && node.to < task.to) out.push(mark("cm-md-done").range(node.to, task.to));
          if (!open(node.from, node.to)) out.push(Decoration.replace({ widget: new Checkbox(checked) }).range(node.from, node.to));
          return;
        }
        case "FencedCode":
        case "CodeBlock": {
          lines(node.from, node.to, "cm-md-codeblock");
          out.push(line("cm-md-codeblock-first").range(doc.lineAt(node.from).from));
          out.push(line("cm-md-codeblock-last").range(doc.lineAt(node.to).from));
          if (name === "CodeBlock" || open(node.from, node.to)) return false;
          const first = doc.lineAt(node.from);
          const info = node.getChild("CodeInfo");
          out.push(Decoration.replace({ widget: new FenceLabel(info ? doc.sliceString(info.from, info.to) : "") }).range(first.from, first.to));
          const last = doc.lineAt(node.to);
          if (last.number > first.number && node.lastChild?.name === "CodeMark") {
            hide(last.from, last.to);
            out.push(line("cm-md-collapsed").range(last.from));
          }
          return false;
        }
        case "HorizontalRule":
          if (!open(node.from, node.to)) out.push(Decoration.replace({ widget: new Rule() }).range(node.from, node.to));
          return;
        case "Table": {
          if (open(node.from, node.to)) {
            lines(node.from, node.to, "cm-md-table-source");
            return;
          }
          const model = tableModel(state, node);
          const cells = model.rows.map((row) => row.map((cell) => cell.node));
          out.push(
            Decoration.replace({ widget: new TableWidget(model, doc, cells), block: true }).range(
              doc.lineAt(node.from).from,
              doc.lineAt(node.to).to,
            ),
          );
          return false;
        }
        default:
          return;
      }
    },
  });

  const { list, flash } = state.field(anchors);
  if (list.length > 0) {
    const text = doc.toString();
    for (const anchor of list) {
      const range = resolveAnchor(text, anchor.quote, anchor.offset);
      if (range === null) continue;
      const attributes: Record<string, string> = { "data-anchor-id": anchor.id };
      if (flash?.id === anchor.id) attributes["data-flash"] = String(flash.nonce);
      out.push(mark("artifact-document__anchor", attributes).range(range.from, range.to));
    }
  }
  return Decoration.set(out, true);
};

const decorations = StateField.define<DecorationSet>({
  create: decorate,
  update: (value, tr) =>
    tr.docChanged ||
    tr.selection !== undefined ||
    tr.effects.length > 0 ||
    syntaxTree(tr.startState) !== syntaxTree(tr.state)
      ? decorate(tr.state)
      : value,
  provide: (field) => EditorView.decorations.from(field),
});

/** The source cells of the table the caret is in, as document positions, or null outside one. */
const tableCellsAt = (state: EditorState, pos: number): number[] | null => {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (node.name !== "Table") continue;
    const from = state.doc.lineAt(node.from).from;
    const starts: number[] = [];
    for (let row = node.firstChild; row; row = row.nextSibling) {
      if (row.name === "TableHeader" || row.name === "TableRow") starts.push(...rowCells(state, row, from).map((cell) => from + cell.at));
    }
    return starts;
  }
  return null;
};

/** Tab and Shift-Tab step between a table's cells while its source is open. */
const stepCell = (direction: 1 | -1) => (view: EditorView): boolean => {
  const pos = view.state.selection.main.head;
  const starts = tableCellsAt(view.state, pos);
  if (starts === null || starts.length === 0) return false;
  const current = starts.filter((start) => start <= pos).length - 1;
  const target = starts[direction === 1 ? current + 1 : Math.max(current - 1, 0)];
  if (target === undefined) return true;
  view.dispatch({ selection: EditorSelection.cursor(target), scrollIntoView: true, userEvent: "select" });
  return true;
};

const openLink = (href: string): void => {
  const url = safeArtifactMarkdownUrl(href);
  if (url) window.open(url, "_blank", "noopener,noreferrer");
};

/** The live preview: markdown with GFM, rendered off the caret's lines. */
export const liveMarkdown = (handlers: LiveMarkdownHandlers): Extension => [
  markdown({ base: markdownLanguage }),
  focused,
  anchors,
  decorations,
  EditorView.lineWrapping,
  EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing)),
  Prec.high(
    keymap.of([
      { key: "Tab", run: stepCell(1) },
      { key: "Shift-Tab", run: stepCell(-1) },
    ]),
  ),
  EditorView.domEventHandlers({
    mousedown: (event, view) => {
      const target = event.target as Element | null;
      const link = target?.closest<HTMLElement>(".cm-md-link[data-href]");
      // A link opens on a modified click, or any click where nothing can be typed.
      if (link?.dataset.href && (event.metaKey || event.ctrlKey || view.state.readOnly)) {
        event.preventDefault();
        openLink(link.dataset.href);
        return true;
      }
      const anchor = target?.closest<HTMLElement>("[data-anchor-id]");
      if (anchor?.dataset.anchorId) handlers.current.onAnchor?.(anchor.dataset.anchorId);
      return false;
    },
  }),
];
