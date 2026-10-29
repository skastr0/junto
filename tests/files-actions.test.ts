import { describe, expect, it } from "vitest";
import { parseFilePath, ROOT_PATH, type FilePath } from "../src/shared/files";
import { folderOfRow, isWithin, moveTargets, rowOf, typedFolder } from "../src/renderer/components/files/files-actions";

const path = (raw: string): FilePath => parseFilePath(raw)!;

describe("files actions (0.11, F2)", () => {
  it("a new entry from a folder row goes in it, from a file row beside it", () => {
    expect(folderOfRow(path("src"), true)).toBe("src");
    expect(folderOfRow(path("src/a.ts"), false)).toBe("src");
    expect(folderOfRow(path("README.md"), false)).toBe(ROOT_PATH);
  });

  it("reads a tree path as an entry, a trailing slash a folder", () => {
    expect(rowOf("src/")).toEqual({ path: "src", dir: true });
    expect(rowOf("src/a.ts")).toEqual({ path: "src/a.ts", dir: false });
    expect(rowOf(null)).toBeUndefined();
    expect(rowOf("")).toBeUndefined();
  });

  it("a typed folder drops slashes and spaces; nothing is the root", () => {
    expect(typedFolder(" /docs/notes/ ")).toBe("docs/notes");
    expect(typedFolder("/")).toBe(ROOT_PATH);
    expect(typedFolder("")).toBe(ROOT_PATH);
    expect(typedFolder("../out")).toBeUndefined();
  });

  it("a move never lands in its own folder, itself, or under itself", () => {
    const folders = [ROOT_PATH, path("src"), path("src/lib"), path("src/lib/deep"), path("docs"), path("srcs")];
    expect(moveTargets(folders, path("src/lib"))).toEqual([ROOT_PATH, path("docs"), path("srcs")]);
    expect(moveTargets(folders, path("README.md"))).toEqual(folders.slice(1));
  });

  it("within is the entry itself or under it, never a sibling sharing a prefix", () => {
    expect(isWithin(path("src/a.ts"), path("src"))).toBe(true);
    expect(isWithin(path("src"), path("src"))).toBe(true);
    expect(isWithin(path("srcs/a.ts"), path("src"))).toBe(false);
  });
});
