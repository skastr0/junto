import { describe, expect, it } from "vitest";
import { getSingularPatch } from "@pierre/diffs";
import { unquoteGitPatchPaths } from "../src/shared/git";

const patchFor = (quotedName: string): string =>
  [
    `diff --git "a/${quotedName}" "b/${quotedName}"`,
    `--- "a/${quotedName}"`,
    `+++ "b/${quotedName}"`,
    "@@ -1 +1 @@",
    "-before",
    "+after",
    "",
  ].join("\n");

describe("unquoteGitPatchPaths", () => {
  it("unquotes a spaced git path before the diff library parses it", () => {
    const patch = patchFor("src/name with space.txt");
    expect(() => getSingularPatch(patch)).toThrow();
    const unquoted = unquoteGitPatchPaths(patch);
    expect(unquoted).toContain("diff --git a/src/name with space.txt b/src/name with space.txt");
    expect(getSingularPatch(unquoted).name).toBe("src/name with space.txt");
  });

  it("decodes a non-ASCII git path before the diff library parses it", () => {
    const patch = patchFor("src/caf\\303\\251.txt");
    expect(() => getSingularPatch(patch)).toThrow();
    const unquoted = unquoteGitPatchPaths(patch);
    expect(unquoted).toContain("diff --git a/src/café.txt b/src/café.txt");
    expect(getSingularPatch(unquoted).name).toBe("src/café.txt");
  });
});
