/**
 * The git group (src/contract/core/git.ts) answered by its handlers, called
 * through the group's own client: the reads of a node's folder, over a
 * repository of this test's making. The wire (ports, codecs) is proved once
 * for every group in tests/core-link-view-state.test.ts.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { RpcTest } from "effect/rpc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitRpcs } from "../src/contract/core/git";
import { GitHandlers } from "../src/core/ops/git-ipc";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "junto-git-rpc-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const git = (...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    stdio: "ignore",
  });

const twoCommits = () => {
  git("init", "-q");
  writeFileSync(join(dir, "note.txt"), "one\n");
  git("add", "note.txt");
  git("commit", "-q", "-m", "first");
  writeFileSync(join(dir, "note.txt"), "two\n");
  git("commit", "-q", "-am", "second");
};

describe("the git group", () => {
  it("reads status, the log and a commit's patch from a node's folder", async () => {
    twoCommits();
    const read = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(GitRpcs);
          const status = yield* client.GitStatus({ cwd: dir });
          const log = yield* client.GitLog({ cwd: dir, limit: 5 });
          const sha = status.ok ? status.status.head?.sha : undefined;
          const shown = yield* client.GitShow({ cwd: dir, sha: sha ?? "" });
          const commit = yield* client.GitCommit({ cwd: dir, sha: sha ?? "" });
          const summary = yield* client.GitSummary({ cwd: dir });
          return { status, log, shown, commit, summary };
        }),
      ).pipe(Effect.provide(GitHandlers)),
    );
    expect(read.status.ok).toBe(true);
    if (!read.status.ok || !read.log.ok || !read.shown.ok) throw new Error("a read was refused");
    expect(read.log.commits.map((commit) => commit.subject)).toEqual(["second", "first"]);
    expect(read.shown.sha).toBe(read.status.status.head?.sha);
    expect(read.shown.patch).toContain("+two");
    expect(read.commit.ok).toBe(true);
    expect(read.summary.ok).toBe(true);
  });

  it("answers a folder that is no repository in the adapter's words, and a path-like sha as a refusal", async () => {
    const read = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(GitRpcs);
          return {
            status: yield* client.GitStatus({ cwd: dir }),
            shown: yield* client.GitShow({ cwd: dir, sha: "../HEAD" }),
            review: yield* client.GitReview({ cwd: dir, view: "working" }),
          };
        }),
      ).pipe(Effect.provide(GitHandlers)),
    );
    expect(read.status.ok).toBe(false);
    expect(read.shown.ok).toBe(false);
    expect(read.review.ok).toBe(false);
  });
});
