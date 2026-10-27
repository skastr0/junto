// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { CodeEditor, type CodeEditorHandle, type LineRange } from "../src/renderer/components/ui/CodeEditor";
import { commentLabel, COMMENT_TEST_ID } from "../src/renderer/components/ui/code-editor-lines";

let root: Root;
let host: HTMLDivElement;

const SOURCE = ["const a = 1;", "const b = 2;", "export function sum() {", "  return a + b;", "}"].join("\n");

const editor = () => EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
const plus = () => host.querySelector<HTMLButtonElement>(`[data-testid="${COMMENT_TEST_ID}"]`);
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("names its text box by the path and opens on the value", async () => {
  await act(async () => root.render(<CodeEditor value={SOURCE} path="src/sum.ts" />));
  expect(host.querySelector('[role="textbox"]')?.getAttribute("aria-label")).toBe("src/sum.ts");
  expect(host.querySelector(".code-editor")?.getAttribute("aria-label")).toBe("File");
  expect(editor().state.doc.toString()).toBe(SOURCE);
});

it("highlights by the file's name once its language loads", async () => {
  await act(async () => root.render(<CodeEditor value={SOURCE} path="src/sum.ts" />));
  await vi.waitFor(() => expect(host.querySelector(".tok-keyword")).not.toBeNull());
});

it("reports typing as the whole text, and a host's replace as nothing, out of undo", async () => {
  const onChange = vi.fn();
  const handle = createRef<CodeEditorHandle>();
  await act(async () => root.render(<CodeEditor value="one" path="a.txt" onChange={onChange} handle={handle} />));
  await act(async () => editor().dispatch({ changes: { from: 3, insert: " two" }, userEvent: "input.type" }));
  expect(onChange).toHaveBeenLastCalledWith("one two");
  await act(async () => handle.current!.replace("from disk"));
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(editor().state.doc.toString()).toBe("from disk");
});

it("offers no plus without onLineComment", async () => {
  await act(async () => root.render(<CodeEditor value={SOURCE} path="a.ts" />));
  expect(plus()).toBeNull();
});

it("puts a plus on the caret line that comments on that line with its text", async () => {
  const comments: LineRange[] = [];
  await act(async () => root.render(<CodeEditor value={SOURCE} path="a.ts" onLineComment={(range) => comments.push(range)} />));
  await act(async () => editor().dispatch({ selection: { anchor: editor().state.doc.line(4).from + 2 } }));
  await settle();
  expect(plus()?.getAttribute("aria-label")).toBe("Comment on line 4");
  await act(async () => plus()!.click());
  expect(comments).toEqual([{ start: 4, end: 4, quote: "  return a + b;" }]);
});

it("comments on every selected line from the plus on any of them", async () => {
  const comments: LineRange[] = [];
  await act(async () => root.render(<CodeEditor value={SOURCE} path="a.ts" onLineComment={(range) => comments.push(range)} />));
  const doc = editor().state.doc;
  // Ending at line 4's start does not take line 4.
  await act(async () => editor().dispatch({ selection: { anchor: doc.line(2).from + 3, head: doc.line(4).from } }));
  await settle();
  expect(plus()?.getAttribute("aria-label")).toBe("Comment on lines 2 to 3");
  await act(async () => plus()!.click());
  expect(comments).toEqual([{ start: 2, end: 3, quote: "const b = 2;\nexport function sum() {" }]);
});

it("says one line and a range in words", () => {
  expect(commentLabel(10, 10)).toBe("Comment on line 10");
  expect(commentLabel(10, 14)).toBe("Comment on lines 10 to 14");
});

it("draws a host's rows after their lines and lets them go", async () => {
  const rows = [{ key: "thread-1", line: 2 }];
  const render = (list: typeof rows) =>
    root.render(<CodeEditor value={SOURCE} path="a.ts" rows={list} renderRow={(key) => <p data-thread={key}>A thread</p>} />);
  await act(async () => render(rows));
  await settle();
  const row = host.querySelector<HTMLElement>('.cm-lineRow[data-row="thread-1"]');
  expect(row?.querySelector('[data-thread="thread-1"]')?.textContent).toBe("A thread");
  // The row sits after line 2's text and before line 3's.
  const lines = [...host.querySelectorAll(".cm-content > *")];
  const at = lines.indexOf(row!);
  expect(lines[at - 1]?.textContent).toBe("const b = 2;");
  expect(lines[at + 1]?.textContent).toBe("export function sum() {");
  await act(async () => render([]));
  await settle();
  expect(host.querySelector("[data-thread]")).toBeNull();
});
