// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/physics/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { FilesNode } = await import("../src/renderer/components/files/FilesNode");
const { installFilesSource, makeLocalFiles, setFileDraft, fileDraft } = await import("../src/renderer/lib/files-source");

const nodeId = asNodeId("files-render");
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
  setFileDraft(nodeId, "src/a.ts", undefined);
});

describe("the Files modal", () => {
  it("opens a text file in the editor, marks unsaved text, and Save writes it", async () => {
    const files = makeLocalFiles({ "src/a.ts": "one" });
    installFilesSource(files);
    await act(async () => root.render(<FilesNode canvasName="c" nodeId={nodeId} initialPath="src/a.ts" onClose={() => undefined} />));
    await flush();
    const editor = document.querySelector<HTMLTextAreaElement>("textarea.files-code");
    expect(editor?.value).toBe("one");
    expect(document.querySelector(".files-head__name")?.textContent).toBe("a.ts");
    const read = await files.read(nodeId, "src/a.ts");
    if (!read.ok || read.value.kind !== "text") throw new Error("expected text");
    const base = read.value.stamp;
    await act(async () => setFileDraft(nodeId, "src/a.ts", { text: "two", base }));
    await flush();
    expect(document.querySelector(".files-head__unsaved")?.textContent).toBe("Unsaved");
    await press(buttonNamed("Save"));
    expect(fileDraft(nodeId, "src/a.ts")).toBeUndefined();
    expect(await files.read(nodeId, "src/a.ts")).toMatchObject({ ok: true, value: { text: "two" } });
  });

  it("offers reload or keep when the file moved on disk under a draft, and keep writes the draft", async () => {
    const files = makeLocalFiles({ "src/a.ts": "one" });
    installFilesSource(files);
    await act(async () => root.render(<FilesNode canvasName="c" nodeId={nodeId} initialPath="src/a.ts" onClose={() => undefined} />));
    await flush();
    const read = await files.read(nodeId, "src/a.ts");
    if (!read.ok || read.value.kind !== "text") throw new Error("expected text");
    setFileDraft(nodeId, "src/a.ts", { text: "mine", base: read.value.stamp });
    await act(async () => files.touch(nodeId, "src/a.ts", "theirs"));
    await flush();
    expect(document.querySelector(".files-stale")?.textContent).toContain("changed on disk");
    await press(buttonNamed("Keep mine"));
    expect(document.querySelector(".files-stale")).toBeNull();
    expect(await files.read(nodeId, "src/a.ts")).toMatchObject({ ok: true, value: { text: "mine" } });
  });

  it("offers the default app and Finder for a file it does not open", async () => {
    installFilesSource(makeLocalFiles({ "a.zip": { mime: "application/zip", size: 10 } }));
    await act(async () => root.render(<FilesNode canvasName="c" nodeId={nodeId} initialPath="a.zip" onClose={() => undefined} />));
    await flush();
    expect(document.body.textContent).toContain("Junto does not open this kind of file");
    expect(buttonNamed("Open in default app")).toBeDefined();
    expect(buttonNamed("Reveal in Finder")).toBeDefined();
  });
});
