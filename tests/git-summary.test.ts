/**
 * Git at a glance for a seat's folder: the parsing, the base branch choice,
 * the one line it becomes, and the reader in main against real repositories.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import {
  chooseGitBase,
  gitSummaryParts,
  isOwnGitBase,
  parseAheadBehind,
  porcelainHasChanges,
  type GitSummary,
} from "../src/shared/git";
import { GIT_SUMMARY_FRESH_MS, readGitSummary } from "../src/main/junto/adapters/git";
import { seatGitFolder } from "../src/renderer/lib/git-summary";

const text = (parts: ReturnType<typeof gitSummaryParts>): string => parts.map((part) => part.text).join(" ");
const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const head = (subject: string, minutesAgo: number) => ({
  sha: "0123456789abcdef0123456789abcdef01234567",
  subject,
  author: "Test",
  authoredAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
});

describe("git summary parsing", () => {
  it("reads behind then ahead from rev-list --left-right --count", () => {
    expect(parseAheadBehind("1\t2\n")).toEqual({ behind: 1, ahead: 2 });
    expect(parseAheadBehind("0 0")).toEqual({ behind: 0, ahead: 0 });
    expect(parseAheadBehind("fatal: bad revision")).toBeUndefined();
    expect(parseAheadBehind("")).toBeUndefined();
  });

  it("sees uncommitted work in porcelain v2, a new untracked file included", () => {
    expect(porcelainHasChanges("# branch.oid abc\n# branch.head main\n")).toBe(false);
    expect(porcelainHasChanges("# branch.head main\n1 .M N... 100644 100644 100644 a b file.txt\n")).toBe(true);
    expect(porcelainHasChanges("# branch.head main\n? new-file.txt\n")).toBe(true);
  });
});

describe("the base branch", () => {
  it("is what the remote calls its default, when it says", () => {
    expect(chooseGitBase({ originHead: "origin/trunk\n", existing: ["main", "origin/main"] })).toBe("origin/trunk");
  });
  it("else the first of origin/main, origin/master, main, master that exists", () => {
    expect(chooseGitBase({ existing: ["master", "main", "origin/master"] })).toBe("origin/master");
    expect(chooseGitBase({ existing: ["master", "main"] })).toBe("main");
    expect(chooseGitBase({ originHead: "", existing: ["master"] })).toBe("master");
  });
  it("is nothing when none exists", () => {
    expect(chooseGitBase({ existing: ["", "trunk"] })).toBeUndefined();
  });
  it("a branch is its own base only as that same local branch", () => {
    expect(isOwnGitBase("main", "main")).toBe(true);
    expect(isOwnGitBase("main", "origin/main")).toBe(false);
  });
});

describe("the one line", () => {
  const summary = (over: Partial<GitSummary>): GitSummary => ({
    root: "/repo",
    branch: "feat/git-line",
    detached: false,
    dirty: false,
    ...over,
  });

  it("reads branch, uncommitted mark, ahead and behind, lines, latest commit and its age", () => {
    const parts = gitSummaryParts(
      summary({
        dirty: true,
        head: head("Read the summary once per repository", 5),
        base: { ref: "origin/main", ahead: 2, behind: 1, additions: 7, deletions: 1 },
      }),
      NOW,
    );
    expect(text(parts)).toBe("feat/git-line * ↑2 ↓1 +7 -1 Read the summary once per repository 5m");
    expect(parts.find((part) => part.kind === "ahead")?.label).toBe("2 commits ahead of origin/main");
    expect(parts.find((part) => part.kind === "deletions")?.label).toBe("1 line removed since origin/main");
  });

  it("shows nothing for a number it does not have, and nothing for a zero", () => {
    // The diff ran out of time: ahead is known, lines are not.
    expect(text(gitSummaryParts(summary({ head: head("Wide change", 90), base: { ref: "main", ahead: 3, behind: 0 } }), NOW))).toBe(
      "feat/git-line ↑3 Wide change 1h",
    );
    // No base branch at all.
    expect(text(gitSummaryParts(summary({ head: head("First", 0) }), NOW))).toBe("feat/git-line First now");
    // Level with the base.
    expect(text(gitSummaryParts(summary({ base: { ref: "main", ahead: 0, behind: 0, additions: 0, deletions: 0 } }), NOW))).toBe(
      "feat/git-line",
    );
  });

  it("says a detached head and an unfinished operation plainly", () => {
    expect(text(gitSummaryParts(summary({ detached: true, branch: "HEAD", head: head("Tagged", 3 * 24 * 60) }), NOW))).toBe(
      "detached at 0123456 Tagged 3d",
    );
    expect(text(gitSummaryParts(summary({ operation: "rebase", dirty: true }), NOW))).toBe("feat/git-line rebase in progress *");
  });
});

describe("the folder that speaks for a seat", () => {
  const seat = (over: Record<string, unknown> = {}): CanvasNode =>
    ({ id: "seat", type: "text", text: "Atlas", x: 50, y: 50, width: 100, height: 60, ether: { entity: { kind: "agent" }, ...over } }) as unknown as CanvasNode;
  const doc = (node: CanvasNode): CanvasDoc =>
    ({
      nodes: [
        { id: "outer", type: "group", label: "Team", x: 0, y: 0, width: 1000, height: 1000, ether: { region: { defaults: { paths: { local: "/outer" } } } } },
        { id: "inner", type: "group", label: "Docs", x: 10, y: 10, width: 400, height: 400, ether: { region: { defaults: { paths: { local: "/inner", studio: "/remote" } } } } },
        node,
      ],
      edges: [],
    }) as unknown as CanvasDoc;

  it("is where it was launched, first", () => {
    const node = seat({ terminal: { harness: "claude", launch: { cwd: " /launched " } } });
    expect(seatGitFolder(doc(node), node)).toBe("/launched");
  });
  it("else its innermost region's folder for its host", () => {
    const node = seat({ terminal: { harness: "claude" } });
    expect(seatGitFolder(doc(node), node)).toBe("/inner");
  });
  it("is nothing for a seat on another host: its folder is not on this machine", () => {
    const node = seat({ host: "studio", terminal: { harness: "claude", launch: { cwd: "/launched" } } });
    expect(seatGitFolder(doc(node), node)).toBeUndefined();
  });
  it("is nothing with no launch folder and no region folder", () => {
    const node = { ...seat({ terminal: { harness: "claude" } }), x: 5000, y: 5000 } as CanvasNode;
    expect(seatGitFolder(doc(node), node)).toBeUndefined();
  });
});

describe("readGitSummary against real repositories", () => {
  let base = "";
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const git = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env }).trim();
  const commit = (repo: string, file: string, body: string, subject: string): void => {
    writeFileSync(join(repo, file), body);
    git(repo, "add", file);
    git(repo, "commit", "-q", "-m", subject);
  };
  const makeRepo = (name: string, branch: string): string => {
    const repo = join(base, name);
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", branch);
    commit(repo, "file.txt", "a\nb\nc\n", "Start");
    return repo;
  };
  // Each read asks for a time past the last one, so the per-repository cache never answers for a changed repo.
  let clock = 1_000_000;
  const fresh = () => {
    clock += GIT_SUMMARY_FRESH_MS + 1;
    return clock;
  };
  const read = async (folder: string): Promise<GitSummary> => {
    const result = await readGitSummary(folder, fresh);
    if (!result.ok) throw new Error(`expected a summary, got ${result.reason}`);
    return result.summary;
  };

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "junto-git-summary-")));
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("a branch two commits ahead of main reads its commits and its lines against main", async () => {
    const repo = makeRepo("ahead", "main");
    git(repo, "checkout", "-q", "-b", "feat/git-line");
    commit(repo, "file.txt", "a\nB\nc\nd\ne\nf\n", "Grow the file");
    commit(repo, "notes.txt", "one\ntwo\nthree\n", "Add the notes");
    git(repo, "checkout", "-q", "main");
    commit(repo, "other.txt", "x\n", "Move main on");
    git(repo, "checkout", "-q", "feat/git-line");

    const summary = await read(repo);
    expect(summary).toMatchObject({
      root: repo,
      branch: "feat/git-line",
      detached: false,
      dirty: false,
      base: { ref: "main", ahead: 2, behind: 1, additions: 7, deletions: 1 },
    });
    expect(summary.head?.subject).toBe("Add the notes");
    expect(text(gitSummaryParts(summary, Date.parse(summary.head!.authoredAt)))).toBe("feat/git-line ↑2 ↓1 +7 -1 Add the notes now");

    // A folder inside the repository is the same repository.
    mkdirSync(join(repo, "deep"));
    expect((await read(join(repo, "deep"))).root).toBe(repo);

    // Uncommitted tracked work.
    writeFileSync(join(repo, "notes.txt"), "one\ntwo\nthree\nfour\n");
    expect((await read(repo)).dirty).toBe(true);
    git(repo, "checkout", "-q", "--", "notes.txt");
    expect((await read(repo)).dirty).toBe(false);

    // A new untracked file is uncommitted work too, as git status has it; an ignored one is not.
    writeFileSync(join(repo, ".git", "info", "exclude"), "scratch.log\n");
    writeFileSync(join(repo, "scratch.log"), "noise\n");
    expect((await read(repo)).dirty).toBe(false);
    writeFileSync(join(repo, "brand-new.txt"), "hello\n");
    expect((await read(repo)).dirty).toBe(true);
    rmSync(join(repo, "brand-new.txt"));

    // On the base branch itself there is nothing to compare.
    git(repo, "checkout", "-q", "main");
    const onMain = await read(repo);
    expect(onMain.branch).toBe("main");
    expect("base" in onMain).toBe(false);

    // Detached: no branch, still compared against the base.
    git(repo, "checkout", "-q", "--detach", "feat/git-line");
    const detached = await read(repo);
    expect(detached).toMatchObject({ detached: true, base: { ref: "main", ahead: 2, behind: 1 } });

    // An unfinished merge is said.
    git(repo, "checkout", "-q", "feat/git-line");
    writeFileSync(join(repo, ".git", "MERGE_HEAD"), `${git(repo, "rev-parse", "main")}\n`);
    expect((await read(repo)).operation).toBe("merge");
  });

  it("prefers the remote's default branch as the base", async () => {
    const origin = makeRepo("origin-src", "trunk");
    const clone = join(base, "clone");
    execFileSync("git", ["clone", "-q", origin, clone], { env });
    git(clone, "checkout", "-q", "-b", "work");
    commit(clone, "w.txt", "1\n2\n", "Work");
    expect(await read(clone)).toMatchObject({ branch: "work", base: { ref: "origin/trunk", ahead: 1, behind: 0, additions: 2, deletions: 0 } });
  });

  it("a repository with no base branch reads its branch and commit, and compares nothing", async () => {
    const repo = makeRepo("no-base", "trunk");
    const summary = await read(repo);
    expect(summary.branch).toBe("trunk");
    expect("base" in summary).toBe(false);
    expect(text(gitSummaryParts(summary, Date.parse(summary.head!.authoredAt)))).toBe("trunk Start now");
  });

  it("answers once per repository while a read is fresh", async () => {
    const repo = makeRepo("cached", "main");
    const at = fresh();
    const first = await readGitSummary(repo, () => at);
    commit(repo, "more.txt", "m\n", "Later");
    const second = await readGitSummary(repo, () => at + GIT_SUMMARY_FRESH_MS - 1);
    expect(second).toBe(first);
    const third = await readGitSummary(repo, () => at + GIT_SUMMARY_FRESH_MS + 1);
    expect(third.ok && third.summary.head?.subject).toBe("Later");
  });

  it("has nothing to show for a folder that is not a repository, or is missing", async () => {
    const plain = join(base, "plain");
    mkdirSync(plain);
    expect(await readGitSummary(plain, fresh)).toEqual({ ok: false, reason: "not-a-repository" });
    expect(await readGitSummary(join(base, "gone"), fresh)).toEqual({ ok: false, reason: "no-folder" });
    expect(await readGitSummary("", fresh)).toEqual({ ok: false, reason: "no-folder" });
  });
});
