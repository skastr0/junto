import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorSelection, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { Mounted } from "./main";

const darkStyle = HighlightStyle.define([
  { tag: t.keyword, color: "#ff678d" },
  { tag: [t.string, t.special(t.string)], color: "#5ecc71" },
  { tag: t.comment, color: "#84848a" },
  { tag: [t.typeName, t.className], color: "#ffa359" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#9d6afb" },
  { tag: t.number, color: "#68cdf2" },
  { tag: t.propertyName, color: "#68cdf2" },
]);

export async function mountCodeMirror(root: HTMLElement, text: string, theme: "dark" | "light"): Promise<Mounted> {
  const lang = LanguageDescription.matchFilename(languages, "fixture.ts");
  const support = lang ? await lang.load() : [];
  const view = new EditorView({
    parent: root,
    state: EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        bracketMatching(),
        search({ top: true }),
        highlightSelectionMatches(),
        keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap]),
        support,
        syntaxHighlighting(theme === "dark" ? darkStyle : defaultHighlightStyle),
        EditorView.theme(
          {
            "&": { height: "100%", backgroundColor: theme === "dark" ? "#141414" : "#fbfbfb" },
            ".cm-scroller": { fontFamily: "ui-monospace, Menlo, monospace" },
            ".cm-gutters": { backgroundColor: "transparent", border: "none" },
          },
          { dark: theme === "dark" },
        ),
      ],
    }),
  });
  return {
    getText: () => view.state.doc.toString(),
    host: () => root,
    caretLine: () => view.state.doc.lineAt(view.state.selection.main.head).number,
    focusLineEnd: (line) => {
      const at = view.state.doc.line(line).to;
      view.dispatch({ selection: EditorSelection.cursor(at), effects: EditorView.scrollIntoView(at, { y: "center" }) });
      view.focus();
    },
    unmount: () => view.destroy(),
  };
}
