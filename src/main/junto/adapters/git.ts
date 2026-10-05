import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { realpath, stat } from "node:fs/promises";
import {
  GIT_BASE_CANDIDATES,
  GIT_LOG_FORMAT,
  GIT_LOG_LIMIT_DEFAULT,
  GIT_LOG_LIMIT_MAX,
  GIT_PATCH_MAX_BYTES,
  capPatchForRender,
  chooseGitBase,
  isGitSha,
  isOwnGitBase,
  parseAheadBehind,
  parseGitLog,
  parsePorcelainV2Branch,
  parseShortstat,
  porcelainHasChanges,
  type GitCommit,
  type GitLogResult,
  type GitOperation,
  type GitShowResult,
  type GitStatus,
  type GitStatusResult,
  type GitSummary,
  type GitSummaryResult,
} from "@shared/git";
import { runCli } from "./exec";

const expandHome = (input: string): string => {
  const requested = input.trim();
  if (!requested || requested === "~") return homedir();
  if (requested.startsWith("~/")) return join(homedir(), requested.slice(2));
  return requested;
};

const resolveRepoCwd = async (input: string): Promise<string> => {
  const requested = input.trim();
  if (requested.length === 0) {
    throw new Error("git path is empty");
  }
  if (requested.includes("\0")) {
    throw new Error("git path is invalid");
  }
  const expanded = expandHome(requested);
  if (!isAbsolute(expanded)) {
    throw new Error("git path must be absolute or start with ~");
  }
  const root = await realpath(expanded);
  const info = await stat(root);
  if (!info.isDirectory()) {
    throw new Error("git path does not name a directory");
  }
  return root;
};

const git = (cwd: string, args: ReadonlyArray<string>, timeoutMs?: number) =>
  runCli("git", ["-C", cwd, ...args], timeoutMs);

const fail = (error: string): { readonly ok: false; readonly error: string } => ({
  ok: false,
  error,
});

export const readGitStatus = async (cwdInput: string): Promise<GitStatusResult> => {
  let cwd: string;
  try {
    cwd = await resolveRepoCwd(cwdInput);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "git path is invalid");
  }
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return fail("not a git repository");
  }
  const porcelain = await git(cwd, [
    "status",
    "--porcelain=v2",
    "--branch",
    "--untracked-files=no",
  ]);
  if (!porcelain.ok) {
    return fail(porcelain.error ?? "git status failed");
  }
  const branch = parsePorcelainV2Branch(porcelain.stdout);
  const headLog = await git(cwd, [
    "log",
    "-1",
    `--format=${GIT_LOG_FORMAT}`,
    "--shortstat",
  ]);
  const head = headLog.ok ? parseGitLog(headLog.stdout)[0] : undefined;
  const status: GitStatus = {
    cwd,
    branch: branch.head ?? "HEAD",
    detached: branch.detached,
    ...(branch.upstream ? { upstream: branch.upstream } : {}),
    ...(branch.ahead !== undefined ? { ahead: branch.ahead } : {}),
    ...(branch.behind !== undefined ? { behind: branch.behind } : {}),
    ...(head ? { head } : {}),
  };
  return { ok: true, status };
};

export const readGitLog = async (
  cwdInput: string,
  limit: number = GIT_LOG_LIMIT_DEFAULT,
): Promise<GitLogResult> => {
  let cwd: string;
  try {
    cwd = await resolveRepoCwd(cwdInput);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "git path is invalid");
  }
  const capped = Math.min(GIT_LOG_LIMIT_MAX, Math.max(1, Math.floor(limit)));
  const result = await git(cwd, [
    "log",
    `-${capped}`,
    `--format=${GIT_LOG_FORMAT}`,
    "--shortstat",
  ]);
  if (!result.ok) {
    return fail(result.error ?? "git log failed");
  }
  return { ok: true, commits: parseGitLog(result.stdout) };
};

export const readGitShow = async (
  cwdInput: string,
  shaInput: string,
): Promise<GitShowResult> => {
  const sha = shaInput.trim();
  if (!isGitSha(sha)) {
    return fail("invalid commit");
  }
  let cwd: string;
  try {
    cwd = await resolveRepoCwd(cwdInput);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "git path is invalid");
  }
  // The sha is the revision, so it goes before `--`; after it git reads a
  // pathspec and shows HEAD filtered to a file named like the sha (nothing).
  // No external diff drivers or textconv: a repo's config never runs code here.
  const result = await git(cwd, [
    "show",
    "--format=",
    "--patch",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    sha,
    "--",
  ]);
  if (!result.ok) {
    return fail(result.error ?? "git show failed");
  }
  const read =
    result.stdout.length > GIT_PATCH_MAX_BYTES
      ? result.stdout.slice(0, GIT_PATCH_MAX_BYTES)
      : result.stdout;
  const capped = capPatchForRender(read);
  return {
    ok: true,
    sha,
    patch: capped.patch,
    ...(capped.truncated ? { files: capped.files, shownFiles: capped.shownFiles } : {}),
  };
};

/** A summary read stays good this long: many seats in one repository share one read. */
export const GIT_SUMMARY_FRESH_MS = 4_000;
/** Each quick git call gets this long. */
const GIT_SUMMARY_STEP_MS = 3_000;
/** The diff against the base can be slow on a large repository; past this the line shows without it. */
export const GIT_SUMMARY_DIFF_MS = 1_500;

/** What each unfinished operation leaves in the git directory. */
const OPERATION_MARKERS: ReadonlyArray<readonly [string, GitOperation]> = [
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["BISECT_LOG", "bisect"],
];

const operationIn = async (gitDir: string): Promise<GitOperation | undefined> => {
  for (const [marker, operation] of OPERATION_MARKERS) {
    const present = await stat(join(gitDir, marker)).then(
      () => true,
      () => false,
    );
    if (present) return operation;
  }
  return undefined;
};

/** A spawn that never found the binary: git is not installed, or not on PATH. */
const gitMissing = (error: string | undefined): boolean => /ENOENT|not found/iu.test(error ?? "");

const summarize = async (cwd: string, root: string, gitDir: string): Promise<GitSummaryResult> => {
  // Untracked files count, as git status counts them: an agent's most common
  // change is a new file. Ignored files do not.
  const porcelain = await git(cwd, ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"], GIT_SUMMARY_STEP_MS);
  if (!porcelain.ok) return { ok: false, reason: "failed" };
  const branch = parsePorcelainV2Branch(porcelain.stdout);
  const [headLog, originHead, candidates, operation] = await Promise.all([
    git(cwd, ["log", "-1", `--format=${GIT_LOG_FORMAT}`], GIT_SUMMARY_STEP_MS),
    git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], GIT_SUMMARY_STEP_MS),
    git(
      cwd,
      [
        "for-each-ref",
        "--format=%(refname:short)",
        ...GIT_BASE_CANDIDATES.map((ref) => (ref.startsWith("origin/") ? `refs/remotes/${ref}` : `refs/heads/${ref}`)),
      ],
      GIT_SUMMARY_STEP_MS,
    ),
    operationIn(gitDir),
  ]);
  const head = headLog.ok ? parseGitLog(headLog.stdout)[0] : undefined;
  const name = branch.head ?? "HEAD";
  const baseRef = chooseGitBase({
    originHead: originHead.ok ? originHead.stdout : undefined,
    existing: candidates.ok ? candidates.stdout.split("\n") : [],
  });

  let base: GitSummary["base"];
  // Nothing to compare before the first commit, or when the branch is the base itself.
  if (baseRef !== undefined && head !== undefined && (branch.detached || !isOwnGitBase(name, baseRef))) {
    const range = `${baseRef}...HEAD`;
    const [counts, diff] = await Promise.all([
      git(cwd, ["rev-list", "--left-right", "--count", range], GIT_SUMMARY_STEP_MS),
      // What the branch changed since it left the base. No external diff or
      // textconv: a repository's config never runs code here.
      git(cwd, ["diff", "--shortstat", "--no-ext-diff", "--no-textconv", range], GIT_SUMMARY_DIFF_MS),
    ]);
    const aheadBehind = counts.ok ? parseAheadBehind(counts.stdout) : undefined;
    // An empty diff prints nothing: that is zero lines, known. A failed or
    // timed out diff is unknown, and its numbers stay out.
    const lines = diff.ok ? (parseShortstat(diff.stdout) ?? { files: 0, additions: 0, deletions: 0 }) : undefined;
    base = {
      ref: baseRef,
      ...(aheadBehind ? { ahead: aheadBehind.ahead, behind: aheadBehind.behind } : {}),
      ...(lines ? { additions: lines.additions, deletions: lines.deletions } : {}),
    };
  }

  return {
    ok: true,
    summary: {
      root,
      branch: name,
      detached: branch.detached,
      dirty: porcelainHasChanges(porcelain.stdout),
      ...(operation ? { operation } : {}),
      ...(head ? { head } : {}),
      ...(base ? { base } : {}),
    },
  };
};

type SummaryEntry = { readonly at: number; readonly result: Promise<GitSummaryResult> };
/** One read per repository, shared by everyone who asks while it is fresh or in flight. */
const summaries = new Map<string, SummaryEntry>();

/**
 * A repository at a glance, for the folder a seat runs in. Reads are keyed by
 * the repository's top level, so seats in one repository, in any of its
 * folders, cost one read between them.
 */
export const readGitSummary = async (cwdInput: string, now: () => number = Date.now): Promise<GitSummaryResult> => {
  let cwd: string;
  try {
    cwd = await resolveRepoCwd(cwdInput);
  } catch {
    return { ok: false, reason: "no-folder" };
  }
  const where = await git(cwd, ["rev-parse", "--is-inside-work-tree", "--show-toplevel", "--absolute-git-dir"], GIT_SUMMARY_STEP_MS);
  if (!where.ok) return { ok: false, reason: gitMissing(where.error) ? "no-git" : "not-a-repository" };
  const [inside, root, gitDir] = where.stdout.split("\n").map((line) => line.trim());
  if (inside !== "true" || !root || !gitDir) return { ok: false, reason: "not-a-repository" };

  const cached = summaries.get(root);
  if (cached !== undefined && now() - cached.at < GIT_SUMMARY_FRESH_MS) return cached.result;
  const result = summarize(cwd, root, gitDir).catch((): GitSummaryResult => ({ ok: false, reason: "failed" }));
  summaries.set(root, { at: now(), result });
  // Drop the entry once it is stale so a closed repository leaves nothing behind.
  void result.finally(() => {
    setTimeout(() => {
      if (summaries.get(root)?.result === result) summaries.delete(root);
    }, GIT_SUMMARY_FRESH_MS).unref?.();
  });
  return result;
};

export type { GitCommit };
