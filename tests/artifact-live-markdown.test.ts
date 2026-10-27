// @vitest-environment jsdom
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { type DecorationSet, EditorView } from "@codemirror/view";
import { afterEach, expect, it } from "vitest";
import {
  anchorsEffect,
  type LiveMarkdownHandlers,
  liveMarkdown,
  resolveAnchor,
  revealAnchorEffects,
  setFocused,
  toggleWrap,
} from "../src/renderer/components/artifacts/live-markdown";

const DOC = [
  "# Title",
  "",
  "Some **bold** and [a link](https://example.com).",
  "",
  "| Layer | Price |",
  "|---|--:|",
  "| Junto | free |",
  "",
  "- [ ] ship it",
].join("\n");

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

/** A view on `doc`, its tree parsed, the operator in it or not, the caret where asked. */
const viewOf = (
  doc: string,
  options: { readonly cursor?: number; readonly focused?: boolean; readonly readOnly?: boolean; readonly handlers?: LiveMarkdownHandlers["current"] } = {},
): EditorView => {
  const view = new EditorView({
    parent: document.body.appendChild(document.createElement("div")),
    state: EditorState.create({
      doc,
      extensions: [liveMarkdown({ current: options.handlers ?? {} }), ...(options.readOnly ? [EditorState.readOnly.of(true)] : [])],
    }),
  });
  views.push(view);
  ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
  view.dispatch({
    effects: setFocused.of(options.focused ?? false),
    ...(options.cursor === undefined ? {} : { selection: EditorSelection.cursor(options.cursor) }),
  });
  return view;
};

/** Every decoration the view draws, from the block field and the visible-range plugin. */
const each = (view: EditorView, visit: (from: number, to: number, spec: Record<string, unknown>) => void): void => {
  for (const source of view.state.facet(EditorView.decorations)) {
    const set = (typeof source === "function" ? source(view) : source) as DecorationSet;
    set.between(0, view.state.doc.length, (from, to, deco) => visit(from, to, deco.spec as Record<string, unknown>));
  }
};

/** The source spans drawn as something else: hidden marks and widgets. */
const replaced = (view: EditorView): string[] => {
  const out: string[] = [];
  each(view, (from, to, spec) => {
    if (spec.widget || spec.block) out.push(view.state.sliceDoc(from, to));
  });
  return out;
};

const at = (text: string) => DOC.indexOf(text);

it("renders every line while the operator is elsewhere: marks hidden, the table drawn", () => {
  const spans = replaced(viewOf(DOC));
  expect(spans).toContain("# ");
  expect(spans).toContain("**");
  expect(spans).toContain("[");
  expect(spans).toContain("](https://example.com)");
  expect(spans).toContain("| Layer | Price |\n|---|--:|\n| Junto | free |");
  expect(spans).toContain("[ ]");
});

it("shows the markdown of the line under the caret, and only that line", () => {
  const spans = replaced(viewOf(DOC, { cursor: at("Some") + 2, focused: true }));
  expect(spans).not.toContain("**");
  expect(spans).not.toContain("](https://example.com)");
  expect(spans).toContain("# ");
});

it("opens a whole table to its source when the caret enters it", () => {
  const view = viewOf(DOC, { cursor: at("| Junto") + 3, focused: true });
  expect(replaced(view).some((span) => span.includes("| Layer"))).toBe(false);
});

it("keeps every line rendered in a read-only version, even with a selection", () => {
  expect(replaced(viewOf(DOC, { cursor: 2, focused: true, readOnly: true }))).toContain("# ");
});

it("finds an anchor's quote at its offset, or the nearest place it moved to", () => {
  expect(resolveAnchor("tabs and tabs", "tabs", 9)).toEqual({ from: 9, to: 13 });
  expect(resolveAnchor("new tabs and tabs", "tabs", 0)).toEqual({ from: 4, to: 8 });
  expect(resolveAnchor("gone", "tabs", 0)).toBeNull();
});

it("marks anchors and flashes the quote asked for", () => {
  const view = viewOf(DOC);
  view.dispatch({
    effects: anchorsEffect([
      { id: "t1", quote: "bold", offset: 0, count: 2 },
      { id: "t2", quote: "gone from the text", offset: 0, count: 1 },
    ]),
  });
  view.dispatch({ effects: [...revealAnchorEffects(view.state, { quote: "bold", offset: 0, nonce: 3 })!] });
  const marks: string[] = [];
  each(view, (from, to, spec) => {
    const attributes = spec.attributes as Record<string, string> | undefined;
    if (attributes?.["data-anchor-id"] || attributes?.["data-flash"]) marks.push(`${view.state.sliceDoc(from, to)} ${JSON.stringify(attributes)}`);
  });
  expect(marks.sort()).toEqual(['bold {"data-anchor-id":"t1","data-count":"2"}', 'bold {"data-flash":"3"}']);
  expect(revealAnchorEffects(view.state, { quote: "missing", offset: 0, nonce: 1 })).toBeNull();
});

it("draws a mention link as a chip and a bang mention alone on its line as an embed", () => {
  const href = "junto://canvas/factory?node=agent-01M46TAATD7VE4ZQA4VRKMX3MP";
  const doc = `Ask [@product-lead](${href}) first.\n\n![@product-lead](${href})\n\n[web](https://example.com)`;
  const spans = replaced(viewOf(doc, { handlers: { mount: () => undefined } }));
  expect(spans).toContain(`[@product-lead](${href})`);
  expect(spans).toContain(`![@product-lead](${href})`);
  // A web link keeps its label in the text; only its marks are hidden.
  expect(spans).toContain("](https://example.com)");
});

it("bolds a selection on Mod-b and takes the bold off again", () => {
  const view = viewOf("ship it");
  view.dispatch({ selection: EditorSelection.range(5, 7) });
  toggleWrap("**")(view);
  expect(view.state.doc.toString()).toBe("ship **it**");
  toggleWrap("**")(view);
  expect(view.state.doc.toString()).toBe("ship it");
});

it("keeps a mention a chip on the caret's line, one unit, while an embed's line opens to its source", () => {
  const href = "junto://canvas/factory?node=agent-01M46TAATD7VE4ZQA4VRKMX3MP";
  const doc = `Ask [@product-lead](${href}) first.\n\n![@product-lead](${href})`;
  const caretAt = (cursor: number) => viewOf(doc, { cursor, focused: true, handlers: { mount: () => undefined } });
  expect(replaced(caretAt(2))).toContain(`[@product-lead](${href})`);
  const onEmbed = caretAt(doc.length);
  expect(replaced(onEmbed)).not.toContain(`![@product-lead](${href})`);
  const atomic = onEmbed.state.facet(EditorView.atomicRanges).map((source) => source(onEmbed));
  expect(atomic.some((set) => set.size > 0)).toBe(true);
});

it("ends a flash on the next edit, so a redrawn line does not replay it", () => {
  const view = viewOf(DOC);
  view.dispatch({ effects: anchorsEffect([{ id: "t1", quote: "bold", offset: 0, count: 1 }]) });
  view.dispatch({ effects: [...revealAnchorEffects(view.state, { quote: "bold", offset: 0, nonce: 1 })!] });
  view.dispatch({ changes: { from: 0, insert: "x" } });
  const flashes: string[] = [];
  each(view, (_from, _to, spec) => {
    if ((spec.attributes as Record<string, string> | undefined)?.["data-flash"]) flashes.push("flash");
  });
  expect(flashes).toEqual([]);
});

it("italicises on Mod-e without taking a bold's stars for italic's", () => {
  const view = viewOf("ship **it**");
  view.dispatch({ selection: EditorSelection.range(7, 9) });
  toggleWrap("*")(view);
  expect(view.state.doc.toString()).toBe("ship ***it***");
  toggleWrap("*")(view);
  expect(view.state.doc.toString()).toBe("ship **it**");
});

it("draws inline marks for the visible part of a long document only", () => {
  const doc = Array.from({ length: 4_000 }, (_, n) => `Line ${n} has **bold** in it.`).join("\n\n");
  const view = viewOf(doc);
  const hiddenStars = replaced(view).filter((span) => span === "**").length;
  expect(hiddenStars).toBeGreaterThan(0);
  expect(hiddenStars).toBeLessThan(8_000);
});

it("draws a link whose title or label crosses a line as source, without a widget over the break", () => {
  const titled = viewOf('Read [the notes](https://example.com\n"Notes") today.');
  expect(replaced(titled).some((span) => span.includes("\n"))).toBe(false);
  // The plugin still draws: a crashed plugin would leave the marks shown.
  expect(replaced(titled)).toContain("[");
  const wrapped = viewOf("Ask [Atlas\nseat](junto://canvas/factory?node=atlas) now.", { handlers: { mount: () => undefined } });
  expect(replaced(wrapped).some((span) => span.includes("\n"))).toBe(false);
  expect(replaced(wrapped)).toContain("[");
});

it("moves anchors an edit misses, and finds a touched quote again", () => {
  const view = viewOf(DOC);
  view.dispatch({ effects: anchorsEffect([{ id: "t1", quote: "bold", offset: 0, count: 1 }]) });
  const quoteAt = (): string[] => {
    const out: string[] = [];
    each(view, (from, to, spec) => {
      if ((spec.attributes as Record<string, string> | undefined)?.["data-anchor-id"]) out.push(view.state.sliceDoc(from, to));
    });
    return out;
  };
  view.dispatch({ changes: { from: 0, insert: "New " } });
  expect(quoteAt()).toEqual(["bold"]);
  const at = view.state.doc.toString().indexOf("bold");
  view.dispatch({ changes: { from: at, to: at + 4, insert: "bald" } });
  expect(quoteAt()).toEqual([]);
});
