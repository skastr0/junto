import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readGitShow } from "../src/main/junto/adapters/git";
import { getSingularPatch } from "@pierre/diffs";
import { GIT_PATCH_RENDER_BUDGET, capPatchForRender, splitPatchFiles } from "../src/shared/git";

// A throwaway repository with three commits: one small, one past the render
// budget spread over many files, one that is a single huge file.
let repo = "";
const shas: Record<"small" | "wide" | "tall", string> = { small: "", wide: "", tall: "" };

const git = (...args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  }).trim();

const lines = (count: number, tag: string): string =>
  Array.from({ length: count }, (_, i) => `${tag} line ${String(i)} ${"x".repeat(40)}`).join("\n") + "\n";

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "junto-git-show-"));
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "hello.txt"), "hello from the commit browser\n");
  git("add", "hello.txt");
  git("commit", "-q", "-m", "small");
  shas.small = git("rev-parse", "HEAD");

  for (let file = 0; file < 60; file += 1) {
    writeFileSync(join(repo, `wide-${String(file).padStart(2, "0")}.txt`), lines(200, `wide ${String(file)}`));
  }
  git("add", ".");
  git("commit", "-q", "-m", "wide");
  shas.wide = git("rev-parse", "HEAD");

  writeFileSync(join(repo, "tall.txt"), lines(20_000, "tall"));
  git("add", "tall.txt");
  git("commit", "-q", "-m", "tall");
  shas.tall = git("rev-parse", "HEAD");
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("git show for the commit browser", () => {
  it("shows the selected commit's patch, not an empty HEAD pathspec", async () => {
    const shown = await readGitShow(repo, shas.small);
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    expect(shown.patch).toContain("diff --git a/hello.txt b/hello.txt");
    expect(shown.patch).toContain("+hello from the commit browser");
    expect(shown.shownFiles).toBeUndefined();
  });

  it("shows an older commit, not HEAD", async () => {
    const shown = await readGitShow(repo, shas.small.slice(0, 12));
    expect(shown.ok && shown.patch.includes("hello.txt")).toBe(true);
    expect(shown.ok && shown.patch.includes("tall.txt")).toBe(false);
  });

  it("never runs a repository's external diff driver", async () => {
    const marker = join(repo, "ext-diff-ran");
    git("config", "diff.external", `sh -c 'touch ${marker}'`);
    try {
      const shown = await readGitShow(repo, shas.small);
      expect(shown.ok && shown.patch.includes("+hello from the commit browser")).toBe(true);
      expect(() => execFileSync("test", ["-e", marker])).toThrow();
    } finally {
      git("config", "--unset", "diff.external");
    }
  });

  it("cuts a wide commit to whole files within the render budget", async () => {
    const shown = await readGitShow(repo, shas.wide);
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    expect(shown.patch.length).toBeLessThanOrEqual(GIT_PATCH_RENDER_BUDGET.maxBytes);
    expect(shown.patch.split("\n").length).toBeLessThanOrEqual(GIT_PATCH_RENDER_BUDGET.maxLines);
    expect(shown.files).toBe(60);
    expect(shown.shownFiles).toBeGreaterThan(0);
    expect(shown.shownFiles).toBeLessThan(60);
    expect(shown.patch.split("\n").filter((line) => line.startsWith("diff --git ")).length).toBe(shown.shownFiles);
  });

  it("hands the diff view one parseable file at a time", async () => {
    // The view throws on a patch that is not exactly one file, which takes
    // the whole window down; every commit with two files would do that.
    const shown = await readGitShow(repo, shas.wide);
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    expect(() => getSingularPatch(shown.patch)).toThrow();
    const files = splitPatchFiles(shown.patch);
    expect(files).toHaveLength(shown.shownFiles ?? 0);
    for (const file of files) expect(() => getSingularPatch(file)).not.toThrow();
  });

  it("shows the first part of one huge file", async () => {
    const shown = await readGitShow(repo, shas.tall);
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    expect(shown.patch.split("\n").length).toBeLessThanOrEqual(GIT_PATCH_RENDER_BUDGET.maxLines);
    expect(shown.files).toBe(1);
    expect(shown.shownFiles).toBe(1);
    expect(shown.patch).toContain("+tall line 0 ");
    expect(shown.patch).not.toContain("+tall line 19999 ");
  });
});

describe("capPatchForRender", () => {
  const file = (name: string, hunks: ReadonlyArray<number>): string =>
    [
      `diff --git a/${name} b/${name}`,
      `--- a/${name}`,
      `+++ b/${name}`,
      ...hunks.flatMap((size, index) => [
        `@@ -${String(index * 100 + 1)},0 +${String(index * 100 + 1)},${String(size)} @@`,
        ...Array.from({ length: size }, (_, i) => `+${name} hunk ${String(index)} line ${String(i)}`),
      ]),
    ].join("\n");

  it("returns a patch inside the budget untouched", () => {
    const patch = `${file("a", [3])}\n${file("b", [2])}\n`;
    expect(capPatchForRender(patch, { maxBytes: 10_000, maxLines: 1_000, maxFileLines: 10_000 })).toEqual({
      patch,
      files: 2,
      shownFiles: 2,
      truncated: false,
    });
  });

  it("keeps whole files, whole hunks, then the first lines of the hunk that crosses", () => {
    const patch = [file("a", [5]), file("b", [5, 5, 50])].join("\n");
    const capped = capPatchForRender(patch, { maxBytes: 100_000, maxLines: 30, maxFileLines: 10_000 });
    expect(capped.truncated).toBe(true);
    expect(capped.files).toBe(2);
    expect(capped.shownFiles).toBe(2);
    expect(capped.patch.split("\n").length).toBe(30);
    expect(capped.patch).toContain("+b hunk 1 line 4");
    // The crossing hunk keeps 5 lines and its header says so.
    expect(capped.patch).toContain("@@ -201,0 +201,5 @@");
    expect(capped.patch).toContain("+b hunk 2 line 4");
    expect(capped.patch).not.toContain("+b hunk 2 line 5");
  });

  it("rewrites both counts of a cut hunk with context and removals", () => {
    const patch = [
      "diff --git a/c b/c",
      "--- a/c",
      "+++ b/c",
      "@@ -10,6 +10,6 @@ fn()",
      " keep",
      "-old one",
      "+new one",
      " keep two",
      "-old two",
      "+new two",
    ].join("\n");
    const capped = capPatchForRender(patch, { maxBytes: 100_000, maxLines: 8, maxFileLines: 10_000 });
    expect(capped.patch.split("\n").slice(3)).toEqual([
      "@@ -10,3 +10,3 @@ fn()",
      " keep",
      "-old one",
      "+new one",
      " keep two",
    ]);
  });

  it("cuts a long file to its share and still shows the files after it", () => {
    const patch = [file("a", [5]), file("b", [300]), file("c", [5])].join("\n");
    const capped = capPatchForRender(patch, { maxBytes: 100_000, maxLines: 1_000, maxFileLines: 50 });
    expect(capped.truncated).toBe(true);
    expect(capped.shownFiles).toBe(3);
    expect(capped.patch).toContain("@@ -1,0 +1,46 @@");
    expect(capped.patch).not.toContain("+b hunk 0 line 46");
    expect(capped.patch).toContain("+c hunk 0 line 4");
  });

  it("drops the crossing file when not one line of it fits", () => {
    const patch = [file("a", [5]), file("b", [500])].join("\n");
    const capped = capPatchForRender(patch, { maxBytes: 100_000, maxLines: 10, maxFileLines: 10_000 });
    expect(capped.shownFiles).toBe(1);
    expect(capped.patch).not.toContain("diff --git a/b");
  });

  it("counts bytes as well as lines", () => {
    const patch = [file("a", [5]), file("b", [5])].join("\n");
    const capped = capPatchForRender(patch, { maxBytes: 150, maxLines: 10_000, maxFileLines: 10_000 });
    expect(capped.shownFiles).toBe(1);
    expect(capped.patch.length).toBeLessThanOrEqual(150);
  });
});
