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
  parseNumstat,
  parsePorcelainV2Branch,
  parseShortstat,
  porcelainHasChanges,
  type GitCommit,
  type GitCommitResult,
  type GitLogResult,
  type GitOperation,
  type GitReviewResult,
  type GitReviewView,
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
/**
 * One commit for a read only preview: its facts, the files it changed with
 * their counts, and its diff. The folder is never the agent's word; the
 * caller resolved it from the seat.
 */
export const readGitCommit = async (cwdInput: string, shaInput: string): Promise<GitCommitResult> => {
  const sha = shaInput.trim();
  if (!isGitSha(sha)) return fail("This is not a commit id.");
  let cwd: string;
  try {
    cwd = await resolveRepoCwd(cwdInput);
  } catch {
    return fail("The agent's folder cannot be opened.");
  }
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) return fail("The agent's folder is not a git repository.");
  // `^{commit}` so a tag or a tree is refused; `--` so the sha is never read as a path.
  const known = await git(cwd, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`, "--"]);
  if (!known.ok) return fail("This commit is not in the agent's folder.");
  const safe = ["--no-color", "--no-ext-diff", "--no-textconv"];
  const [facts, counts, shown, branches, current] = await Promise.all([
    git(cwd, ["show", "--no-patch", `--format=${GIT_LOG_FORMAT}`, sha, "--"]),
    git(cwd, ["show", "--format=", "--numstat", "-z", ...safe, sha, "--"]),
    readGitShow(cwd, sha),
    git(cwd, ["branch", "--contains", sha, "--format=%(refname:short)"]),
    git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
  ]);
  const commit = facts.ok ? parseGitLog(facts.stdout)[0] : undefined;
  if (!commit || !counts.ok || !shown.ok) return fail("This commit could not be read.");
  const holding = branches.ok ? branches.stdout.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("(")) : [];
  const head = current.ok ? current.stdout.trim() : "";
  const branch = holding.includes(head) ? head : holding[0];
  return {
    ok: true,
    commit,
    ...(branch ? { branch } : {}),
    files: parseNumstat(counts.stdout),
    patch: shown.patch,
    ...(shown.shownFiles !== undefined ? { shownFiles: shown.shownFiles } : {}),
  };
};

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

/** A review reads at most this many new untracked files; the rest are counted, not read. */
export const GIT_REVIEW_UNTRACKED_MAX = 40;
const GIT_REVIEW_DIFF_MS = 10_000;

// No external diff drivers or textconv: a repository's config never runs code
// here. The a/ and b/ prefixes are pinned, so a user's diff.mnemonicPrefix or
// diff.noprefix cannot change the paths a patch names.
const PATCH_FLAGS = [
  "--patch",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--src-prefix=a/",
  "--dst-prefix=b/",
] as const;

/**
 * The diff a reviewer reads for a folder: what is not committed yet (new
 * files included), or what the branch has committed since the base. Part of
 * the one git reader; capped like a commit's patch.
 */
export const readGitReview = async (cwdInput: string, view: GitReviewView): Promise<GitReviewResult> => {
  let cwd: string;
  try {
    cwd = await resolveRepoCwd(cwdInput);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "git path is invalid");
  }
  const where = await git(cwd, ["rev-parse", "--is-inside-work-tree", "--show-toplevel"], GIT_SUMMARY_STEP_MS);
  const [inside, root] = where.stdout.split("\n").map((line) => line.trim());
  if (!where.ok || inside !== "true" || !root) return fail("not a git repository");

  const [porcelain, headSha] = await Promise.all([
    git(root, ["status", "--porcelain=v2", "--branch", "--untracked-files=no"], GIT_SUMMARY_STEP_MS),
    git(root, ["rev-parse", "--short", "HEAD"], GIT_SUMMARY_STEP_MS),
  ]);
  const branch = porcelain.ok ? parsePorcelainV2Branch(porcelain.stdout) : { detached: false };
  const name = branch.head ?? "HEAD";
  const head = headSha.ok ? headSha.stdout.trim() : "";
  const common = { branch: name, ...(head ? { head } : {}) };
  const finish = (patch: string, extra: { readonly base?: string; readonly untrackedLeftOut?: number } = {}): GitReviewResult => {
    const read = patch.length > GIT_PATCH_MAX_BYTES ? patch.slice(0, GIT_PATCH_MAX_BYTES) : patch;
    const capped = capPatchForRender(read);
    return {
      ok: true,
      view,
      patch: capped.patch,
      ...(capped.truncated ? { files: capped.files, shownFiles: capped.shownFiles } : {}),
      ...common,
      ...extra,
    };
  };

  if (view === "base") {
    const [originHead, candidates] = await Promise.all([
      git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], GIT_SUMMARY_STEP_MS),
      git(
        root,
        [
          "for-each-ref",
          "--format=%(refname:short)",
          ...GIT_BASE_CANDIDATES.map((ref) => (ref.startsWith("origin/") ? `refs/remotes/${ref}` : `refs/heads/${ref}`)),
        ],
        GIT_SUMMARY_STEP_MS,
      ),
    ]);
    const base = chooseGitBase({
      originHead: originHead.ok ? originHead.stdout : undefined,
      existing: candidates.ok ? candidates.stdout.split("\n") : [],
    });
    // No base, no first commit, or the branch is the base: nothing to compare, said by an absent base.
    if (base === undefined || !head || (!branch.detached && isOwnGitBase(name, base))) return finish("");
    const diff = await git(root, ["diff", ...PATCH_FLAGS, `${base}...HEAD`, "--"], GIT_REVIEW_DIFF_MS);
    if (!diff.ok) return fail(diff.error ?? "git diff failed");
    return finish(diff.stdout, { base });
  }

  // Tracked work against HEAD (staged or not); before the first commit, against the empty tree.
  const tracked = await git(
    root,
    head ? ["diff", ...PATCH_FLAGS, "HEAD", "--"] : ["diff", ...PATCH_FLAGS, "--cached", "--"],
    GIT_REVIEW_DIFF_MS,
  );
  if (!tracked.ok) return fail(tracked.error ?? "git diff failed");
  // New files git does not track yet: an agent's most common change. Each is
  // read as a whole-file addition; ignored files are not listed.
  const others = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"], GIT_SUMMARY_STEP_MS);
  const untracked = others.ok ? others.stdout.split("\0").filter((path) => path.length > 0) : [];
  const read = untracked.slice(0, GIT_REVIEW_UNTRACKED_MAX);
  // `--no-index` exits 1 when the files differ, which is every time here: its output is the patch.
  const added = await Promise.all(
    read.map((path) => git(root, ["diff", ...PATCH_FLAGS, "--no-index", "--", "/dev/null", path], GIT_SUMMARY_STEP_MS)),
  );
  const patch = [tracked.stdout, ...added.map((result) => result.stdout)].filter((part) => part.length > 0).join("");
  return finish(patch, untracked.length > read.length ? { untrackedLeftOut: untracked.length - read.length } : {});
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
  if (!where.ok) {
    if (gitMissing(where.error)) return { ok: false, reason: "no-git" };
    // git answers "not a repository" at once; a call that ran out of time said nothing of the kind.
    return { ok: false, reason: /timed out/iu.test(where.error ?? "") ? "failed" : "not-a-repository" };
  }
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
