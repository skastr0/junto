// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { LiveMarkdownField, type LiveMarkdownFieldHandle } from "../src/renderer/components/artifacts/LiveMarkdownField";
import { COMMENT_TEST_ID, type LineRange } from "../src/renderer/components/ui/code-editor-lines";

// jsdom lays nothing out; CodeMirror's measuring asks a range for its boxes.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

let root: Root;
let host: HTMLDivElement;

const SOURCE = ["# Plan", "", "Ship the editor.", "Then the gutter.", "", "Done."].join("\n");

const editor = () => EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
const plus = () => host.querySelector<HTMLButtonElement>(`button[data-testid="${COMMENT_TEST_ID}"]`);
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
/** One display frame: CodeMirror's measure runs in it, inside the test rather than after it. */
const frame = () => act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  // A measure still scheduled runs now, inside this test, never after it; unmount then destroys the view.
  await frame();
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("offers no plus to a host that takes no line comments", async () => {
  await act(async () => root.render(<LiveMarkdownField value={SOURCE} label="README.md" surfaceLabel="File" />));
  expect(plus()).toBeNull();
  expect(host.querySelector(".cm-commentGutter")).toBeNull();
});

it("puts the code editor's plus on the caret line, with the lines' markdown as the quote", async () => {
  const comments: LineRange[] = [];
  await act(async () =>
    root.render(<LiveMarkdownField value={SOURCE} label="README.md" surfaceLabel="File" onLineComment={(range) => comments.push(range)} />),
  );
  const doc = editor().state.doc;
  await act(async () => editor().dispatch({ selection: { anchor: doc.line(3).from, head: doc.line(4).to } }));
  await frame();
  await settle();
  expect(plus()?.getAttribute("aria-label")).toBe("Comment on lines 3 to 4");
  expect(plus()?.tabIndex).toBe(0);
  await act(async () => plus()!.click());
  expect(comments).toEqual([{ start: 3, end: 4, quote: "Ship the editor.\nThen the gutter." }]);
});

it("draws a host's rows after their lines, and reveals a line on asking", async () => {
  const handle = createRef<LiveMarkdownFieldHandle>();
  await act(async () =>
    root.render(
      <LiveMarkdownField
        value={SOURCE}
        label="README.md"
        surfaceLabel="File"
        rows={[{ key: "thread:1", line: 3 }]}
        renderRow={(key) => <p data-thread={key}>A thread</p>}
        handle={handle}
      />,
    ),
  );
  await settle();
  expect(host.querySelector('.cm-lineRow[data-row="thread:1"] [data-thread="thread:1"]')?.textContent).toBe("A thread");
  await act(async () => handle.current!.revealLine(4));
  await frame();
  expect(editor().state.doc.lineAt(editor().state.selection.main.head).number).toBe(4);
});
