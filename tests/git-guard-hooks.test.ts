/**
 * The git guard's `core.hooksPath=/dev/null` (e9cc0324e), proven (0.11
 * release checklist, section 3). A read is not hook-free by itself: `git
 * status` rewrites the index when a file's stat moved, and that runs the
 * repository's `post-index-change` hook. The fixture shows a plain git runs
 * the hook; the git node's reads and the Files index run none, from the
 * repository's own hooks folder or from a hooksPath its config names.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitLog, readGitReview, readGitStatus, readGitSummary } from "../src/main/junto/adapters/git";
import { mainNameSources } from "../src/main/junto/files/git-spawn";

let dir: string;
let repo: string;
let marker: string;

const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { stdio: "ignore" });

const plantHook = (folder: string): void => {
  mkdirSync(folder, { recursive: true });
  for (const name of ["post-index-change", "post-checkout", "reference-transaction"]) {
    writeFileSync(join(folder, name), `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(join(folder, name), 0o755);
  }
};

/** Move the file's stat so the next status rewrites the index. */
const touchStat = (): void => {
  const later = new Date(Date.now() + 5_000);
  utimesSync(join(repo, "f.txt"), later, later);
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "junto-git-guard-hooks-")));
  repo = join(dir, "repo");
  marker = join(dir, "PWNED");
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "f.txt"), "a\n");
  git("add", "f.txt");
  git("commit", "-qm", "x");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("git guard: hooks", () => {
  for (const [where, plant] of [
    ["the repository's own hooks folder", () => plantHook(join(repo, ".git", "hooks"))],
    ["a hooksPath the repository's config names", () => {
      plantHook(join(dir, "elsewhere"));
      git("config", "core.hooksPath", join(dir, "elsewhere"));
    }],
  ] as const) {
    it(`a plain git status runs a hook from ${where}`, () => {
      plant();
      touchStat();
      git("status", "--porcelain");
      expect(existsSync(marker)).toBe(true);
    });

    it(`the git node's reads and the Files index run no hook from ${where}`, async () => {
      plant();
      touchStat();
      expect((await readGitStatus(repo)).ok).toBe(true);
      touchStat();
      expect((await readGitLog(repo, 5)).ok).toBe(true);
      expect((await readGitReview(repo, "working")).ok).toBe(true);
      await readGitSummary(repo);
      const signal = new AbortController().signal;
      touchStat();
      expect(await mainNameSources.isGitRoot(repo, signal)).toBe(true);
      await mainNameSources.gitNames(repo, () => undefined, signal);
      expect(existsSync(marker)).toBe(false);
    });
  }
});
