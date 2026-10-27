/**
 * A folder's own git config never runs code when Junto reads it: fsmonitor,
 * filter drivers and signature checks are overridden on every git main runs.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitLog, readGitReview, readGitStatus, readGitSummary } from "../src/main/junto/adapters/git";
import { filterDriverNames, filterGuardArgs } from "../src/main/junto/adapters/git-guard";
import { gitNames, isGitRoot } from "../src/main/junto/files/sources";

let dir: string;
let marker: string;

const git = (...args: string[]) =>
  execFileSync("git", ["-C", join(dir, "repo"), "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    stdio: "ignore",
  });

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "junto-git-guard-")));
  marker = join(dir, "PWNED");
  execFileSync("git", ["init", "-q", join(dir, "repo")]);
  writeFileSync(join(dir, "repo", "f.txt"), "a\n");
  git("add", "f.txt");
  git("commit", "-qm", "x");
  writeFileSync(join(dir, "repo", ".gitattributes"), "* filter=evil.one\n");
  // Every command the folder's config can name, each leaving the marker.
  git("config", "core.fsmonitor", `touch ${marker}`);
  git("config", "filter.evil.one.clean", `touch ${marker}; cat`);
  git("config", "filter.evil.one.smudge", `touch ${marker}; cat`);
  git("config", "filter.evil.one.process", `touch ${marker}; false`);
  git("config", "log.showSignature", "true");
  git("config", "gpg.program", `touch ${marker}; false`);
  appendFileSync(join(dir, "repo", "f.txt"), "b\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("git guard", () => {
  it("the fixture really runs code under a plain git", () => {
    git("status", "--porcelain");
    expect(existsSync(marker)).toBe(true);
  });

  it("the git node's reads run nothing the folder names", async () => {
    const repo = join(dir, "repo");
    expect((await readGitStatus(repo)).ok).toBe(true);
    expect((await readGitLog(repo, 5)).ok).toBe(true);
    expect((await readGitReview(repo, "working")).ok).toBe(true);
    await readGitSummary(repo);
    expect(existsSync(marker)).toBe(false);
  });

  it("the Files index runs nothing the folder names", async () => {
    const repo = join(dir, "repo");
    const signal = new AbortController().signal;
    expect(await isGitRoot(repo, signal)).toBe(true);
    const names: string[] = [];
    await gitNames(repo, (batch) => names.push(...batch), signal);
    expect(names.sort()).toEqual([".gitattributes", "f.txt"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("reads driver names with dots and empties each command", () => {
    const output = "filter.lfs.clean\ngit-lfs clean\0filter.evil.one.process\nx\0core.bare\nfalse\0";
    expect(filterDriverNames(output)).toEqual(["lfs", "evil.one"]);
    expect(filterGuardArgs(["lfs"])).toEqual([
      "-c", "filter.lfs.clean=",
      "-c", "filter.lfs.smudge=",
      "-c", "filter.lfs.process=",
      "-c", "filter.lfs.required=false",
    ]);
  });
});
