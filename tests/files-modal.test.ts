import { describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/physics/schema";
import { parseFilePath, ROOT_PATH, type FileEntry, type FilePath } from "../src/shared/files";
import { isSaveChord } from "../src/renderer/components/files/FilesNode";
import { fileOfSelection, folderOps, treePathOf } from "../src/renderer/components/files/files-tree";
import { changeTouches, dirtyPaths, fileDraft, fileViewOf, filesErrorLine, foldersTouched, makeLocalFiles, setFileDraft } from "../src/renderer/lib/files-source";

const node = asNodeId("files-test");
const ref = { canvas: "c", node };
const stamp = { mtimeMs: 1, size: 1 };
const path = (raw: string): FilePath => {
  const parsed = parseFilePath(raw);
  if (parsed === undefined) throw new Error(`not a path: ${raw}`);
  return parsed;
};
const entry = (raw: string, dir = false): FileEntry => ({ path: path(raw), dir, stamp });

describe("the Files modal's main pane picks a viewer by type", () => {
  it("opens Markdown in the document field and other text in the code editor", () => {
    expect(fileViewOf(path("README.md"), { kind: "text", text: "", stamp })).toBe("markdown");
    expect(fileViewOf(path("docs/a.MDX"), { kind: "text", text: "", stamp })).toBe("markdown");
    expect(fileViewOf(path("src/index.ts"), { kind: "text", text: "", stamp })).toBe("code");
  });

  it("previews PDFs and images, and offers the way out for anything else", () => {
    expect(fileViewOf(path("a.pdf"), { kind: "binary", mime: "application/pdf", stamp })).toBe("pdf");
    expect(fileViewOf(path("a.png"), { kind: "binary", mime: "image/png", stamp })).toBe("image");
    expect(fileViewOf(path("a.zip"), { kind: "binary", mime: "application/octet-stream", stamp })).toBe("other");
    expect(fileViewOf(path("big.log"), { kind: "too-large", size: 9e6, stamp })).toBe("too-large");
  });
});

describe("the tree", () => {
  it("names directories with a trailing slash and opens the last file selected", () => {
    expect([entry("src", true), entry("src/a.ts")].map(treePathOf)).toEqual(["src/", "src/a.ts"]);
    expect(fileOfSelection(["src/", "src/a.ts", "docs/"])).toBe("src/a.ts");
    expect(fileOfSelection(["src/"])).toBeNull();
  });

  it("brings a folder's children to a fresh listing: adds the new, removes the gone, a folder with all under it", () => {
    const { ops, children } = folderOps(new Set(["src/a.ts", "src/old/", "src/b.ts"]), [entry("src/a.ts"), entry("src/c.ts"), entry("src/new", true)]);
    expect(ops).toEqual([
      { type: "remove", path: "src/old/", recursive: true },
      { type: "remove", path: "src/b.ts", recursive: false },
      { type: "add", path: "src/c.ts" },
      { type: "add", path: "src/new/" },
    ]);
    expect([...children]).toEqual(["src/a.ts", "src/c.ts", "src/new/"]);
  });

  it("re-lists only the folders a change names, and every listed one on a reset", () => {
    expect(foldersTouched({ node, kind: "paths", paths: [path("src/a.ts"), path("src/b.ts"), path("top.md")] })).toEqual(["src", ROOT_PATH]);
    expect(foldersTouched({ node, kind: "reset" })).toBe("all");
    expect(changeTouches({ node, kind: "paths", paths: [path("a.ts")] }, node, path("a.ts"))).toBe(true);
    expect(changeTouches({ node: asNodeId("other"), kind: "reset" }, node, path("a.ts"))).toBe(false);
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
    const read = await files.read(ref, path("a.ts"));
    if (!read.ok || read.value.kind !== "text") throw new Error("expected text");
    files.touch(node, "a.ts", "changed elsewhere");
    expect(await files.write(ref, path("a.ts"), "mine", read.value.stamp)).toEqual({ ok: false, error: "stale" });
    const fresh = await files.read(ref, path("a.ts"));
    if (!fresh.ok || fresh.value.kind !== "text") throw new Error("expected text");
    expect((await files.write(ref, path("a.ts"), "mine", fresh.value.stamp)).ok).toBe(true);
    expect(await files.read(ref, path("a.ts"))).toMatchObject({ ok: true, value: { text: "mine" } });
  });

  it("lists one folder at a time, folders first", async () => {
    const files = makeLocalFiles({ "b.md": "", "src/a.ts": "", "src/deep/x.ts": "" });
    const root = await files.list(ref, ROOT_PATH);
    expect(root.ok && root.value.map(treePathOf)).toEqual(["src/", "b.md"]);
    const src = await files.list(ref, path("src"));
    expect(src.ok && src.value.map(treePathOf)).toEqual(["src/deep/", "src/a.ts"]);
  });

  it("holds unsaved text per file until it is saved or dropped", () => {
    setFileDraft(node, path("a.ts"), { text: "draft", base: stamp });
    expect(dirtyPaths(node)).toEqual(["a.ts"]);
    expect(fileDraft(node, path("a.ts"))?.text).toBe("draft");
    setFileDraft(node, path("a.ts"), undefined);
    expect(dirtyPaths(node)).toEqual([]);
  });

  it("says every refusal in plain words, with no middle dot", () => {
    const errors = ["no-node", "elsewhere", "root-missing", "invalid-path", "outside-root", "not-found", "exists", "not-dir", "is-dir", "stale", "too-large", "denied", "failed"] as const;
    for (const error of errors) expect(filesErrorLine(error)).not.toContain(String.fromCharCode(0xb7));
  });
});
