import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readGitLog, readGitShow, readGitStatus } from "../src/main/junto/adapters/git";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("git adapter", () => {
  it("reads status for this repository", async () => {
    const result = await readGitStatus(repoRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status.cwd).toBeTruthy();
    expect(result.status.branch.length).toBeGreaterThan(0);
    expect(result.status.head?.sha).toMatch(/^[0-9a-f]{40}$/iu);
    expect(result.status.head?.subject.length).toBeGreaterThan(0);
  });

  it("lists commits with authors", async () => {
    const result = await readGitLog(repoRoot, 5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commits.length).toBeGreaterThan(0);
    expect(result.commits[0]?.author.length).toBeGreaterThan(0);
  });

  // Its own two-commit repository: in a shallow checkout HEAD has no parent,
  // so its patch is the whole tree and runs past the adapter's output limit.
  it("shows a patch for a commit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junto-git-show-"));
    try {
      const run = (...args: string[]) =>
        execFileSync(
          "git",
          ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
          { stdio: "ignore" },
        );
      run("init", "-q");
      writeFileSync(join(dir, "note.txt"), "one\n");
      run("add", "note.txt");
      run("commit", "-q", "-m", "first");
      writeFileSync(join(dir, "note.txt"), "two\n");
      run("commit", "-q", "-am", "second");
      const status = await readGitStatus(dir);
      expect(status.ok).toBe(true);
      if (!status.ok || !status.status.head) throw new Error("no head");
      const shown = await readGitShow(dir, status.status.head.sha);
      expect(shown.ok).toBe(true);
      if (!shown.ok) return;
      expect(shown.sha).toBe(status.status.head.sha);
      expect(JSON.stringify(shown)).toContain("+two");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a non-repo directory", async () => {
    const result = await readGitStatus("/tmp");
    expect(result.ok).toBe(false);
  });

  it("refuses a path-like sha", async () => {
    const result = await readGitShow(repoRoot, "../HEAD");
    expect(result.ok).toBe(false);
  });
});
