// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFilePath, type FileStamp } from "../src/shared/files";
import { asNodeId } from "../src/shared/physics/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { UnsavedFilesHost } = await import("../src/renderer/components/files/UnsavedFilesHost");
const { installFileDraftsUnloadGuard, settleFileDrafts } = await import("../src/renderer/lib/files-drafts-settle");
const { fileDraft, heldFileDrafts, installFilesSource, makeLocalFiles, setFileDraft, useFilesRoot } = await import(
  "../src/renderer/lib/files-source"
);

const node = asNodeId("files-settle");
const A = parseFilePath("a.md")!;
const B = parseFilePath("docs/b.md")!;
let root: Root;
let host: HTMLDivElement;

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
};

const button = (name: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-testid="unsaved-files-dialog"] button')].find((each) => each.textContent === name)!;

/** Opens the node's folder as the modal does, so its drafts know their canvas. */
function Opened() {
  useFilesRoot({ canvas: "c", node });
  return <UnsavedFilesHost />;
}

const stampOf = async (files: ReturnType<typeof makeLocalFiles>, path: typeof A): Promise<FileStamp> => {
  const read = await files.read({ canvas: "c", node }, path);
  if (!read.ok) throw new Error("expected a file");
  return read.value.stamp;
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  for (const { node: at, path } of heldFileDrafts()) setFileDraft(at, path, undefined);
  installFilesSource(null);
});

describe("unsaved Files drafts before the window goes", () => {
  it("goes at once with no drafts, and asks nothing", async () => {
    installFilesSource(makeLocalFiles({}));
    await act(async () => root.render(<Opened />));
    await expect(settleFileDrafts()).resolves.toBe(true);
    expect(document.querySelector('[data-testid="unsaved-files-dialog"]')).toBeNull();
  });

  it("Save all writes every draft to its file and lets the window go", async () => {
    const files = makeLocalFiles({ "a.md": "one", "docs/b.md": "two" });
    installFilesSource(files);
    await act(async () => root.render(<Opened />));
    await flush();
    setFileDraft(node, A, { text: "one!", base: await stampOf(files, A) });
    setFileDraft(node, B, { text: "two!", base: await stampOf(files, B) });
    let settled: boolean | undefined;
    void settleFileDrafts().then((value) => (settled = value));
    await flush();
    expect(document.querySelector('[data-testid="unsaved-files-dialog"]')?.textContent).toContain("Save changes to 2 files?");
    await act(async () => button("Save all").click());
    await flush();
    expect(settled).toBe(true);
    expect(heldFileDrafts()).toHaveLength(0);
    const read = await files.read({ canvas: "c", node }, A);
    expect(read.ok && read.value.kind === "text" ? read.value.text : undefined).toBe("one!");
    expect(document.querySelector('[data-testid="unsaved-files-dialog"]')).toBeNull();
  });

  it("a refused write keeps its draft and the window, says why, and asks again", async () => {
    const files = makeLocalFiles({ "a.md": "one" });
    installFilesSource(files);
    await act(async () => root.render(<Opened />));
    await flush();
    // The draft was taken from a version the disk has since left.
    setFileDraft(node, A, { text: "mine", base: { mtimeMs: 1, size: 1 } });
    let settled: boolean | undefined;
    void settleFileDrafts().then((value) => (settled = value));
    await flush();
    await act(async () => button("Save all").click());
    await flush();
    expect(settled).toBeUndefined();
    expect(fileDraft(node, A)?.text).toBe("mine");
    expect(document.querySelector('[data-testid="unsaved-files-dialog"]')?.textContent).toContain("a.md: This file changed on disk since you opened it.");
    await act(async () => button("Cancel").click());
    await flush();
    expect(settled).toBe(false);
    expect(fileDraft(node, A)?.text).toBe("mine");
  });

  it("Discard drops the drafts and leaves the files as they are", async () => {
    const files = makeLocalFiles({ "a.md": "one" });
    installFilesSource(files);
    await act(async () => root.render(<Opened />));
    await flush();
    setFileDraft(node, A, { text: "gone", base: await stampOf(files, A) });
    let settled: boolean | undefined;
    void settleFileDrafts().then((value) => (settled = value));
    await flush();
    expect(document.querySelector('[data-testid="unsaved-files-dialog"]')?.textContent).toContain("Save changes to a.md?");
    await act(async () => button("Discard").click());
    await flush();
    expect(settled).toBe(true);
    expect(heldFileDrafts()).toHaveLength(0);
    const read = await files.read({ canvas: "c", node }, A);
    expect(read.ok && read.value.kind === "text" ? read.value.text : undefined).toBe("one");
  });

  it("a reload with drafts stops and asks; without drafts it goes", async () => {
    const files = makeLocalFiles({ "a.md": "one" });
    installFilesSource(files);
    await act(async () => root.render(<Opened />));
    await flush();
    const stop = installFileDraftsUnloadGuard();
    const unload = (): Event => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event;
    };
    expect(unload().defaultPrevented).toBe(false);
    setFileDraft(node, A, { text: "draft", base: await stampOf(files, A) });
    expect(unload().defaultPrevented).toBe(true);
    await flush();
    expect(document.querySelector('[data-testid="unsaved-files-dialog"]')).not.toBeNull();
    await act(async () => button("Cancel").click());
    await flush();
    stop();
  });
});
