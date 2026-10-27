import { createRoot } from "react-dom/client";
import { Editor } from "@pierre/diffs/edit";
import { EditProvider, File, Virtualizer, WorkerPoolContextProvider } from "@pierre/diffs/react";
import PierreWorker from "@pierre/diffs/worker/worker.js?worker";
import type { Mounted } from "./main";

export function mountPierre(root: HTMLElement, text: string, theme: "dark" | "light", virtual: boolean, worker = false, highlighter?: "shiki-wasm" | "highlights"): Mounted {
  let editor: Editor<"file"> | undefined;
  const createEditor = ((type: "file", options: object, key?: string) => {
    editor = new Editor(type, options as never, key);
    return editor;
  }) as never;
  const file = (
    <File
      file={{ name: "fixture.ts", contents: text }}
      edit
      disableWorkerPool={!worker}
      options={{ theme: { dark: "pierre-dark", light: "pierre-light" }, themeType: theme, overflow: "scroll", disableFileHeader: true, ...(highlighter ? { preferredHighlighter: highlighter } : {}) }}
    />
  );
  const reactRoot = createRoot(root);
  const tree = (
    <EditProvider createEditor={createEditor}>
      {virtual ? <Virtualizer style={{ height: "100%", overflow: "auto" }}>{file}</Virtualizer> : file}
    </EditProvider>
  );
  reactRoot.render(
    worker ? (
      <WorkerPoolContextProvider
        poolOptions={{ workerFactory: () => new PierreWorker(), poolSize: 2 }}
        highlighterOptions={{ theme: { dark: "pierre-dark", light: "pierre-light" }, langs: ["typescript"] }}
      >
        {tree}
      </WorkerPoolContextProvider>
    ) : (
      tree
    ),
  );
  return {
    getText: () => editor?.getText() ?? "",
    host: () => root.querySelector("diffs-container")?.shadowRoot ?? null,
    caretLine: () => (editor?.getViewState().selections?.[0]?.start.line ?? -1) + 1,
    focusLineEnd: (line) => {
      const length = (editor?.getText().split("\n")[line - 1] ?? "").length;
      editor?.focus({ lineNumber: line, character: length });
    },
    unmount: () => reactRoot.unmount(),
  };
}
