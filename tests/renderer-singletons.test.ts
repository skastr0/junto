import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  RENDERER_SINGLETONS,
  describeDuplicatedSingletons,
  duplicatedSingletons,
  packageFolderOf,
} from "../scripts/renderer-singletons";

const root = join("/repo");
const nm = (...parts: string[]): string => join(root, "node_modules", ...parts);

describe("renderer singletons", () => {
  it("dedupes every CodeMirror and Lezer package the editors share, and React", () => {
    for (const name of ["react", "react-dom", "@codemirror/state", "@codemirror/view", "@codemirror/language", "@lezer/common"]) {
      expect(RENDERER_SINGLETONS).toContain(name);
    }
  });

  it("names a bundled module's package and the folder it came from", () => {
    expect(packageFolderOf(nm("@codemirror", "state", "dist", "index.js"))).toEqual({
      name: "@codemirror/state",
      folder: nm("@codemirror", "state"),
    });
    expect(packageFolderOf(nm("@codemirror", "language", "node_modules", "@codemirror", "state", "dist", "index.js"))).toEqual({
      name: "@codemirror/state",
      folder: nm("@codemirror", "language", "node_modules", "@codemirror", "state"),
    });
    expect(packageFolderOf(`${nm("style-mod", "src", "style-mod.js")}?commonjs-proxy`)?.name).toBe("style-mod");
    expect(packageFolderOf(join(root, "src", "window", "App.tsx"))).toBeUndefined();
  });

  it("passes one copy of each singleton, however many of its files are bundled", () => {
    const ids = [
      nm("@codemirror", "state", "dist", "index.js"),
      nm("@codemirror", "view", "dist", "index.js"),
      nm("@codemirror", "view", "dist", "other.js"),
      join(root, "src", "window", "components", "artifacts", "LiveMarkdownField.tsx"),
    ];
    expect(duplicatedSingletons(ids).size).toBe(0);
  });

  it("catches the 0.12.1 crash: @codemirror/state bundled from two folders", () => {
    const nested = nm("@codemirror", "language", "node_modules", "@codemirror", "state");
    const ids = [nm("@codemirror", "state", "dist", "index.js"), join(nested, "dist", "index.js")];
    const duplicated = duplicatedSingletons(ids);
    expect([...duplicated.keys()]).toEqual(["@codemirror/state"]);
    expect(duplicated.get("@codemirror/state")).toEqual([nested, nm("@codemirror", "state")].sort());
    expect(describeDuplicatedSingletons(root, duplicated)).toContain(
      "@codemirror/state from node_modules/@codemirror/language/node_modules/@codemirror/state and node_modules/@codemirror/state",
    );
  });

  it("leaves a package that is not a singleton to keep its nested version", () => {
    const ids = [nm("semver", "index.js"), nm("tool", "node_modules", "semver", "index.js")];
    expect(duplicatedSingletons(ids).size).toBe(0);
  });
});
