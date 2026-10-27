import { describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/physics/schema";
import { fileOfSelection, isSaveChord, treePathsOf } from "../src/renderer/components/files/FilesNode";
import { dirtyPaths, fileDraft, fileViewOf, filesErrorLine, makeLocalFiles, setFileDraft } from "../src/renderer/lib/files-source";

const node = asNodeId("files-test");
const stamp = { mtimeMs: 1, size: 1 };

describe("the Files modal's main pane picks a viewer by type", () => {
  it("opens Markdown in the document field and other text in the code editor", () => {
    expect(fileViewOf("README.md", { kind: "text", text: "", stamp })).toBe("markdown");
    expect(fileViewOf("docs/a.MDX", { kind: "text", text: "", stamp })).toBe("markdown");
    expect(fileViewOf("src/index.ts", { kind: "text", text: "", stamp })).toBe("code");
  });

  it("previews PDFs and images, and offers the way out for anything else", () => {
    expect(fileViewOf("a.pdf", { kind: "binary", mime: "application/pdf", stamp })).toBe("pdf");
    expect(fileViewOf("a.png", { kind: "binary", mime: "image/png", stamp })).toBe("image");
    expect(fileViewOf("a.zip", { kind: "binary", mime: "application/zip", stamp })).toBe("other");
    expect(fileViewOf("big.log", { kind: "too-large", size: 9e6 })).toBe("too-large");
  });
});

describe("the tree", () => {
  it("names directories with a trailing slash and opens the last file selected", () => {
    expect(treePathsOf([{ path: "src", dir: true, stamp }, { path: "src/a.ts", dir: false, stamp }])).toEqual(["src/", "src/a.ts"]);
    expect(fileOfSelection(["src/", "src/a.ts", "docs/"])).toBe("src/a.ts");
    expect(fileOfSelection(["src/"])).toBeNull();
  });
});

describe("saving", () => {
  it("answers Cmd+S on macOS and Ctrl+S elsewhere, and nothing with another key held", () => {
    const key = { key: "s", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(isSaveChord({ ...key, metaKey: true }, true)).toBe(true);
    expect(isSaveChord({ ...key, ctrlKey: true }, true)).toBe(false);
    expect(isSaveChord({ ...key, ctrlKey: true }, false)).toBe(true);
    expect(isSaveChord({ ...key, metaKey: true, shiftKey: true }, true)).toBe(false);
  });

  it("writes against the version read, and refuses stale once the disk moved on", async () => {
    const files = makeLocalFiles({ "a.ts": "one" }, () => 100);
    const read = await files.read(node, "a.ts");
    if (!read.ok || read.value.kind !== "text") throw new Error("expected text");
    files.touch(node, "a.ts", "changed elsewhere");
    expect(await files.write(node, "a.ts", "mine", read.value.stamp)).toEqual({ ok: false, error: "stale" });
    const fresh = await files.read(node, "a.ts");
    if (!fresh.ok || fresh.value.kind !== "text") throw new Error("expected text");
    const kept = await files.write(node, "a.ts", "mine", fresh.value.stamp);
    expect(kept.ok).toBe(true);
    expect(await files.read(node, "a.ts")).toMatchObject({ ok: true, value: { text: "mine" } });
  });

  it("holds unsaved text per file until it is saved or dropped", () => {
    setFileDraft(node, "a.ts", { text: "draft", base: stamp });
    expect(dirtyPaths(node)).toEqual(["a.ts"]);
    expect(fileDraft(node, "a.ts")?.text).toBe("draft");
    setFileDraft(node, "a.ts", undefined);
    expect(dirtyPaths(node)).toEqual([]);
  });

  it("says every refusal in plain words, with no middle dot", () => {
    for (const error of ["outside-root", "not-found", "exists", "stale", "too-large", "denied", "root-missing"] as const) {
      expect(filesErrorLine(error)).not.toContain(String.fromCharCode(0xb7));
    }
  });
});
