// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/physics/schema";
import { parseFilePath } from "../src/shared/files";
import { asCanvasName } from "../src/shared/model";
import { files as filesNode } from "./support/model-nodes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { FilesNode } = await import("../src/renderer/components/files/FilesNode");
const { saveFileInFront } = await import("../src/renderer/lib/file-editor-keys");
const { installFilesSource, makeLocalFiles, setFileDraft, fileDraft } = await import("../src/renderer/lib/files-source");
const { modelStore } = await import("../src/renderer/lib/use-model");

const nodeId = asNodeId("files-render");
const ref = { canvas: "c", node: nodeId };
const A = parseFilePath("src/a.ts")!;
let root: Root;
let host: HTMLDivElement;

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
};

const press = async (element: Element | null | undefined): Promise<void> => {
  if (!(element instanceof HTMLElement)) throw new Error("nothing to press");
  await act(async () => element.click());
  await flush();
};

const buttonNamed = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find((button) => button.textContent === name || button.getAttribute("aria-label") === name);

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setFileDraft(nodeId, A, undefined);
  installFilesSource(null);
});

describe("the Files modal", () => {
  it("opens a text file in the editor, marks unsaved text, and Save writes it", async () => {
    const files = makeLocalFiles({ "src/a.ts": "one" });
    installFilesSource(files);
    await act(async () => root.render(<FilesNode canvasName="c" nodeId={nodeId} initialPath={A} onClose={() => undefined} />));
    await flush();
    expect(document.querySelector(".files-code .cm-content")?.textContent).toBe("one");
    expect(document.querySelector(".files-head__name")?.textContent).toBe("a.ts");
    const read = await files.read(ref, A);
    if (!read.ok || read.value.kind !== "text") throw new Error("expected text");
    const base = read.value.stamp;
    await act(async () => setFileDraft(nodeId, A, { text: "two", base }));
    await flush();
    expect(document.querySelector(".files-head__unsaved")?.textContent).toBe("Unsaved");
    await press(buttonNamed("Save"));
    expect(fileDraft(nodeId, A)).toBeUndefined();
    expect(await files.read(ref, A)).toMatchObject({ ok: true, value: { text: "two" } });
  });

  it("saves the open file on Cmd+S, through the key table's files.save", async () => {
    const files = makeLocalFiles({ "src/a.ts": "one" });
    installFilesSource(files);
    await act(async () => root.render(<FilesNode canvasName="c" nodeId={nodeId} initialPath={A} onClose={() => undefined} />));
    await flush();
    const read = await files.read(ref, A);
    if (!read.ok || read.value.kind !== "text") throw new Error("expected text");
    const base = read.value.stamp;
    await act(async () => setFileDraft(nodeId, A, { text: "three", base }));
    await act(async () => {
      expect(saveFileInFront()).toBe(true);
    });
    await flush();
    expect(await files.read(ref, A)).toMatchObject({ ok: true, value: { text: "three" } });
    act(() => root.render(<></>));
    expect(saveFileInFront()).toBe(false);
  });

  it("offers reload or keep when the file moved on disk under a draft, and keep writes the draft", async () => {
    const files = makeLocalFiles({ "src/a.ts": "one" });
    installFilesSource(files);
    await act(async () => root.render(<FilesNode canvasName="c" nodeId={nodeId} initialPath={A} onClose={() => undefined} />));
    await flush();
    const read = await files.read(ref, A);
    if (!read.ok || read.value.kind !== "text") throw new Error("expected text");
    setFileDraft(nodeId, A, { text: "mine", base: read.value.stamp });
    await act(async () => files.touch(nodeId, "src/a.ts", "theirs"));
    await flush();
    expect(document.querySelector(".files-stale")?.textContent).toContain("changed on disk");
    await press(buttonNamed("Keep mine"));
    expect(document.querySelector(".files-stale")).toBeNull();
    expect(await files.read(ref, A)).toMatchObject({ ok: true, value: { text: "mine" } });
  });

  it("offers the default app and Finder for a file it does not open", async () => {
    installFilesSource(makeLocalFiles({ "a.zip": { size: 10 } }));
    await act(async () => root.render(<FilesNode canvasName="c" nodeId={nodeId} initialPath={parseFilePath("a.zip")!} onClose={() => undefined} />));
    await flush();
    expect(document.querySelector("[data-testid=\"file-view-other\"]")).not.toBeNull();
    expect(buttonNamed("Open in default app")).toBeDefined();
    expect(buttonNamed("Reveal in Finder")).toBeDefined();
  });

  it("names the tree, keeps no search box inside it, and filters from a labelled field above it", async () => {
    installFilesSource(makeLocalFiles({ "src/a.ts": "one", "b.md": "" }));
    await act(async () => root.render(<FilesNode canvasName="c" nodeId={nodeId} onClose={() => undefined} />));
    await flush();
    const nav = document.querySelector("nav.files-tree-nav");
    expect(nav?.getAttribute("aria-label")).toMatch(/^Files in /);
    const shadow = nav?.querySelector("file-tree-container")?.shadowRoot;
    const tree = shadow?.querySelector('[role="tree"]');
    expect(tree).not.toBeNull();
    if (tree != null) {
      expect(tree.getAttribute("aria-label")).toBe(nav?.getAttribute("aria-label"));
      expect(tree.querySelector("input")).toBeNull();
    }
    expect(document.querySelector('input[aria-label^="Filter files in "]')).not.toBeNull();
  });

  it("keeps text typed while a save was out, as unsaved on the new version", async () => {
    const files = makeLocalFiles({ "src/a.ts": "one" });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    installFilesSource({ ...files, write: async (...args) => (await held, files.write(...args)) });
    await act(async () => root.render(<FilesNode canvasName="c" nodeId={nodeId} initialPath={A} onClose={() => undefined} />));
    await flush();
    const read = await files.read(ref, A);
    if (!read.ok || read.value.kind !== "text") throw new Error("expected text");
    const base = read.value.stamp;
    await act(async () => setFileDraft(nodeId, A, { text: "two", base }));
    await act(async () => {
      saveFileInFront();
    });
    await act(async () => setFileDraft(nodeId, A, { text: "two and more", base }));
    await act(async () => release());
    await flush();
    expect(await files.read(ref, A)).toMatchObject({ ok: true, value: { text: "two" } });
    const after = await files.read(ref, A);
    expect(fileDraft(nodeId, A)?.text).toBe("two and more");
    expect(after.ok && after.value.kind === "text" && fileDraft(nodeId, A)?.base).toEqual(after.ok && after.value.kind === "text" ? after.value.stamp : null);
  });

  it("says as an alert that a folder gone from disk cannot open", async () => {
    installFilesSource({ ...makeLocalFiles(), open: async () => ({ ok: false, error: "root-missing" }) });
    await act(async () => root.render(<FilesNode canvasName="c" nodeId={nodeId} onClose={() => undefined} />));
    await flush();
    expect(document.querySelector('[role="alert"].files-refused')?.textContent).toContain("missing on this machine");
  });

  it("closes the folder and opens the new one when the node's root moves under the open modal", async () => {
    const place = (rootPath: string) =>
      modelStore.adopt({ canvas: asCanvasName("c"), seq: 0, wires: [], nodes: [filesNode("files-render", { root: rootPath })] });
    let release = place("/Users/me/one");
    const calls: string[] = [];
    const local = makeLocalFiles({ "a.md": "" });
    installFilesSource({
      ...local,
      open: async (at) => {
        calls.push("open");
        return local.open(at);
      },
      close: async (at) => {
        calls.push("close");
        return local.close(at);
      },
    });
    await act(async () => root.render(<FilesNode canvasName="c" nodeId={nodeId} onClose={() => undefined} />));
    await flush();
    expect(calls).toEqual(["open"]);
    await act(async () => {
      release();
      release = place("/Users/me/two");
    });
    await flush();
    expect(calls).toEqual(["open", "close", "open"]);
    release();
  });
});
