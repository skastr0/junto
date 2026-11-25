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

  it("keeps a decoded name with a newline or carriage return quoted as-is", () => {
    for (const escaped of ["src/a\\nb.txt", "src/a\\rb.txt"]) {
      const patch = patchFor(escaped);
      expect(unquoteGitPatchPaths(patch)).toContain(`diff --git "a/${escaped}" "b/${escaped}"`);
    }
  });

  it("unquotes rename from and rename to names the same way", () => {
    const patch = [
      'diff --git "a/src/caf\\303\\251 old.txt" "b/src/caf\\303\\251.txt"',
      'rename from "src/caf\\303\\251 old.txt"',
      'rename to "src/caf\\303\\251.txt"',
      "",
    ].join("\n");
    const unquoted = unquoteGitPatchPaths(patch);
    expect(unquoted).toContain("rename from src/café old.txt");
    expect(unquoted).toContain("rename to src/café.txt");
  });
});
