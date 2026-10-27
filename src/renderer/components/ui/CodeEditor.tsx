/**
 * Code and text edited in place: highlighted by the file's name, with line
 * numbers, find (Cmd+F), undo and bracket matching, and nothing heavier (no
 * language server, no completion). Colours and chrome are house tokens
 * (code-editor.css).
 *
 * The props say nothing of the engine underneath, so a host never depends on
 * it; the handle's `view` is the one way through, for a host's own effects.
 *
 * `value` is what the editor opens on; a host that must put text in later
 * (a reload from disk) uses the handle's `replace`, or keys the editor anew.
 * Every edit the operator makes reaches `onChange` as the whole text. With
 * `onLineComment` the gutter offers a plus beside the pointer's line and the
 * caret's; with `rows` and `renderRow` the host draws between lines.
 */
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Annotation, Compartment, EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, ViewPlugin } from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import { claimFocus, releaseFocus } from "../../lib/focus-ownership";
import { textSplice } from "../artifacts/artifacts-pane-model";
import { lineComments, lineRows, setLineRows, type LineHandlers, type LineRange, type LineRow } from "./code-editor-lines";
import "./code-editor.css";
import "./code-editor-lines.css";

export type { LineRange, LineRow };

/** What a host does to the editor that is not typing. */
export type CodeEditorHandle = {
  /** The engine's view, for a host's own effects. */
  readonly view: () => EditorView | null;
  /** Put text in as not typed: it is not reported, and undo does not reach it. */
  readonly replace: (text: string) => void;
  /** Bring a line into the middle of the view with the caret at its start, and write there. */
  readonly revealLine: (line: number) => void;
};

/** Marks a change that came from the host, not from the operator's typing. */
const fromHost = Annotation.define<boolean>();

const editable = (readOnly: boolean) => [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * An Escape the editor used (closing find) stops here. Closing find takes
 * its field out of the page mid-key, so the modal around the editor would
 * read the key as pressed outside it and close as well.
 */
const keepUsedEscape = ViewPlugin.define((view) => {
  const stop = (event: globalThis.KeyboardEvent): void => {
    if (event.key === "Escape" && event.defaultPrevented) event.stopPropagation();
  };
  view.dom.addEventListener("keydown", stop);
  return { destroy: () => view.dom.removeEventListener("keydown", stop) };
});

export function CodeEditor({
  value,
  path,
  label = path,
  surfaceLabel = "File",
  readOnly = false,
  onChange,
  onLineComment,
  rows,
  renderRow,
  className,
  handle,
}: {
  /** The text the editor opens on. */
  readonly value: string;
  /** The file's path or name: what the language is read from. */
  readonly path: string;
  /** The text box's name; the path when not given. */
  readonly label?: string;
  /** The surface's name, for the group that holds the editor. */
  readonly surfaceLabel?: string;
  readonly readOnly?: boolean;
  /** Every edit the operator makes, as the whole text. */
  readonly onChange?: ((text: string) => void) | undefined;
  /** A press on the gutter's plus: the lines it covers and their text. */
  readonly onLineComment?: ((range: LineRange) => void) | undefined;
  /** Rows drawn after lines, each named by its key. */
  readonly rows?: ReadonlyArray<LineRow> | undefined;
  readonly renderRow?: ((key: string) => ReactNode) | undefined;
  readonly className?: string;
  readonly handle?: Ref<CodeEditorHandle>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const access = useRef(new Compartment());
  const language = useRef(new Compartment());
  const comments = useRef(new Compartment());
  /** The hosts the editor made for rows between lines, each drawn into by a portal. */
  const [mounts, setMounts] = useState<ReadonlyMap<HTMLElement, string>>(new Map());
  const heard = useRef({ onChange });
  heard.current = { onChange };
  const handlers = useRef<LineHandlers["current"]>({});
  handlers.current = {
    comment: onLineComment,
    mount: (key, element) => setMounts((prior) => new Map(prior).set(element, key)),
    unmount: (_key, element) =>
      setMounts((prior) => {
        if (!prior.has(element)) return prior;
        const next = new Map(prior);
        next.delete(element);
        return next;
      }),
  };

  useImperativeHandle(
    handle,
    () => ({
      view: () => view.current,
      replace: (text) => {
        const editor = view.current;
        if (editor === null) return;
        const patch = textSplice(editor.state.doc.toString(), text);
        if (patch === null) return;
        editor.dispatch({
          changes: { from: patch.at, to: patch.at + patch.remove, insert: patch.insert },
          annotations: [fromHost.of(true), Transaction.addToHistory.of(false)],
        });
      },
      revealLine: (line) => {
        const editor = view.current;
        if (editor === null) return;
        const at = editor.state.doc.line(Math.min(Math.max(1, line), editor.state.doc.lines)).from;
        editor.dispatch({ selection: EditorSelection.cursor(at), effects: EditorView.scrollIntoView(at, { y: "center" }) });
        claimFocus(editor.contentDOM, "gesture");
      },
    }),
    [],
  );

  /** Escape stops writing: the surface keeps the keyboard. Find takes Escape first while it is open. */
  const stopWriting = (editor: EditorView): boolean => {
    if (claimFocus(host.current, "gesture")) return true;
    return releaseFocus(editor.contentDOM, "gesture");
  };

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          comments.current.of([]),
          highlightActiveLine(),
          drawSelection(),
          history(),
          bracketMatching(),
          search({ top: true }),
          highlightSelectionMatches(),
          keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap]),
          keymap.of([{ key: "Escape", run: stopWriting }]),
          keepUsedEscape,
          language.current.of([]),
          syntaxHighlighting(classHighlighter),
          lineRows(handlers),
          access.current.of(editable(readOnly)),
          // An explicit tab stop on the text: no second stop, but the scroller around it has a focusable inside even read-only (axe scrollable-region-focusable).
          EditorView.contentAttributes.of({ "aria-label": label, tabindex: "0", spellcheck: "false", autocapitalize: "off", autocorrect: "off" }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.every((tr) => tr.annotation(fromHost) === true)) {
              heard.current.onChange?.(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  // The language loads by the file's name; until then, and for a name no language claims, the text is plain.
  useEffect(() => {
    const found = LanguageDescription.matchFilename(languages, baseName(path));
    if (found === null) {
      view.current?.dispatch({ effects: language.current.reconfigure([]) });
      return;
    }
    let live = true;
    void found.load().then((support) => {
      if (live) view.current?.dispatch({ effects: language.current.reconfigure(support) });
    });
    return () => {
      live = false;
    };
  }, [path]);

  useEffect(() => {
    view.current?.dispatch({ effects: access.current.reconfigure(editable(readOnly)) });
  }, [readOnly]);

  const commenting = onLineComment !== undefined;
  useEffect(() => {
    view.current?.dispatch({ effects: comments.current.reconfigure(commenting ? lineComments(handlers) : []) });
  }, [commenting]);

  useEffect(() => {
    view.current?.dispatch({ effects: setLineRows.of(rows ?? []) });
  }, [rows]);

  // A drawn row has its size now: the editor measures again.
  useLayoutEffect(() => {
    view.current?.requestMeasure();
  }, [mounts]);

  /** Enter on the surface writes again, at the caret it left. */
  const onSurfaceKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget || event.key !== "Enter" || readOnly) return;
    event.preventDefault();
    claimFocus(view.current?.contentDOM, "gesture", { event: event.nativeEvent });
  };

  return (
    <>
      <div
        ref={host}
        className={className ? `code-editor ${className}` : "code-editor"}
        data-readonly={readOnly ? "true" : undefined}
        tabIndex={0}
        role="group"
        aria-label={surfaceLabel}
        onKeyDown={onSurfaceKey}
      />
      {renderRow ? [...mounts].map(([element, key]) => createPortal(renderRow(key), element, key)) : null}
    </>
  );
}
