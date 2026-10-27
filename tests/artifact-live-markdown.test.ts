import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { type DecorationSet, EditorView } from "@codemirror/view";
import { expect, it } from "vitest";
import {
  anchorsEffect,
  liveMarkdown,
  resolveAnchor,
  revealAnchorEffects,
  setFocused,
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

const stateOf = (doc: string, cursor?: number, focused = false): EditorState => {
  let state = EditorState.create({ doc, extensions: [liveMarkdown({ current: {} })] });
  ensureSyntaxTree(state, state.doc.length, 5_000);
  const tr = state.update({
    effects: setFocused.of(focused),
    ...(cursor === undefined ? {} : { selection: EditorSelection.cursor(cursor) }),
  });
  state = tr.state;
  return state;
};

/** The source spans drawn as something else: hidden marks and widgets. */
const replaced = (state: EditorState): string[] => {
  const out: string[] = [];
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue;
    (source as DecorationSet).between(0, state.doc.length, (from, to, deco) => {
      if (deco.spec.widget || deco.spec.block) out.push(state.sliceDoc(from, to));
    });
  }
  return out;
};

const lineOf = (state: EditorState, text: string) => state.doc.toString().indexOf(text);

it("renders every line while the operator is elsewhere: marks hidden, the table drawn", () => {
  const spans = replaced(stateOf(DOC));
  expect(spans).toContain("# ");
  expect(spans).toContain("**");
  expect(spans).toContain("[");
  expect(spans).toContain("](https://example.com)");
  expect(spans).toContain("| Layer | Price |\n|---|--:|\n| Junto | free |");
  expect(spans).toContain("[ ]");
});

it("shows the markdown of the line under the caret, and only that line", () => {
  const state = stateOf(DOC, lineOf(stateOf(DOC), "Some") + 2, true);
  const spans = replaced(state);
  expect(spans).not.toContain("**");
  expect(spans).not.toContain("](https://example.com)");
  expect(spans).toContain("# ");
});

it("opens a whole table to its source when the caret enters it", () => {
  const state = stateOf(DOC, lineOf(stateOf(DOC), "| Junto") + 3, true);
  expect(replaced(state).some((span) => span.includes("| Layer"))).toBe(false);
});

it("keeps every line rendered in a read-only version, even with a selection", () => {
  let state = EditorState.create({ doc: DOC, extensions: [liveMarkdown({ current: {} }), EditorState.readOnly.of(true)] });
  ensureSyntaxTree(state, state.doc.length, 5_000);
  state = state.update({ effects: setFocused.of(true), selection: EditorSelection.cursor(2) }).state;
  expect(replaced(state)).toContain("# ");
});

it("finds an anchor's quote at its offset, or the nearest place it moved to", () => {
  expect(resolveAnchor("tabs and tabs", "tabs", 9)).toEqual({ from: 9, to: 13 });
  expect(resolveAnchor("new tabs and tabs", "tabs", 0)).toEqual({ from: 4, to: 8 });
  expect(resolveAnchor("gone", "tabs", 0)).toBeNull();
});

it("marks anchors and flashes the quote asked for", () => {
  let state = stateOf(DOC);
  state = state.update({
    effects: anchorsEffect([
      { id: "t1", quote: "bold", offset: 0, count: 2 },
      { id: "t2", quote: "gone from the text", offset: 0, count: 1 },
    ]),
  }).state;
  const effects = revealAnchorEffects(state, { quote: "bold", offset: 0, nonce: 3 })!;
  state = state.update({ effects: [...effects] }).state;
  const marks: string[] = [];
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue;
    (source as DecorationSet).between(0, state.doc.length, (from, to, deco) => {
      const attributes = deco.spec.attributes as Record<string, string> | undefined;
      if (attributes?.["data-anchor-id"] || attributes?.["data-flash"]) marks.push(`${state.sliceDoc(from, to)} ${JSON.stringify(attributes)}`);
    });
  }
  expect(marks).toEqual(['bold {"data-anchor-id":"t1","data-count":"2"}', 'bold {"data-flash":"3"}']);
  expect(revealAnchorEffects(state, { quote: "missing", offset: 0, nonce: 1 })).toBeNull();
});

it("draws a mention link as a chip and a bang mention alone on its line as an embed", () => {
  const href = "junto://canvas/factory?node=agent-01M46TAATD7VE4ZQA4VRKMX3MP";
  const doc = `Ask [@product-lead](${href}) first.\n\n![@product-lead](${href})\n\n[web](https://example.com)`;
  const mounted: string[] = [];
  let state = EditorState.create({
    doc,
    extensions: [liveMarkdown({ current: { mount: (_host, mention) => mounted.push(mention.kind) } })],
  });
  ensureSyntaxTree(state, state.doc.length, 5_000);
  state = state.update({ effects: setFocused.of(false) }).state;
  const spans = replaced(state);
  expect(spans).toContain(`[@product-lead](${href})`);
  expect(spans).toContain(`![@product-lead](${href})`);
  // A web link keeps its label in the text; only its marks are hidden.
  expect(spans).toContain("](https://example.com)");
});
