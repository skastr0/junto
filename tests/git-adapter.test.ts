import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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

  it("shows a patch for HEAD", async () => {
    const status = await readGitStatus(repoRoot);
    expect(status.ok).toBe(true);
    if (!status.ok || !status.status.head) return;
    const shown = await readGitShow(repoRoot, status.status.head.sha);
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    expect(shown.sha).toBe(status.status.head.sha);
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
