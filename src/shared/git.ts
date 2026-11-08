import { Schema } from "effect";

/** Abbreviated or full object name. Reject anything git would treat as a path. */
export const GIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/iu;

export const GitLocStats = Schema.Struct({
  files: Schema.Number,
  additions: Schema.Number,
  deletions: Schema.Number,
});
export type GitLocStats = typeof GitLocStats.Type;

export const GitCommit = Schema.Struct({
  sha: Schema.String,
  subject: Schema.String,
  author: Schema.String,
  authoredAt: Schema.String,
  stats: Schema.optionalKey(GitLocStats),
});
export type GitCommit = typeof GitCommit.Type;

export const GitStatus = Schema.Struct({
  cwd: Schema.String,
  branch: Schema.String,
  detached: Schema.Boolean,
  upstream: Schema.optionalKey(Schema.String),
  ahead: Schema.optionalKey(Schema.Number),
  behind: Schema.optionalKey(Schema.Number),
  head: Schema.optionalKey(GitCommit),
});
export type GitStatus = typeof GitStatus.Type;

export const GitStatusResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    status: GitStatus,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.String,
  }),
]);
export type GitStatusResult = typeof GitStatusResult.Type;

export const GitLogResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    commits: Schema.Array(GitCommit),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.String,
  }),
]);
export type GitLogResult = typeof GitLogResult.Type;

export const GitShowResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    sha: Schema.String,
    patch: Schema.String,
    /** Set when the patch was cut to the render budget: files in the commit. */
    files: Schema.optionalKey(Schema.Number),
    /** Files kept whole or in part; the last one may be cut at a hunk. */
    shownFiles: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.String,
  }),
]);
export type GitShowResult = typeof GitShowResult.Type;

/** One file a commit changed. A binary file has no line counts. */
export const GitCommitFile = Schema.Struct({
  path: Schema.String,
  additions: Schema.optionalKey(Schema.Number),
  deletions: Schema.optionalKey(Schema.Number),
});
export type GitCommitFile = typeof GitCommitFile.Type;

/**
 * One commit, read whole: who, when, where it sits, what it changed. A commit
 * that cannot be read says why in words a reader can act on; nothing here is
 * ever a stand-in.
 */
export const GitCommitResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    commit: GitCommit,
    /** The checked-out branch when it holds the commit, else another local branch that does. Absent when none does. */
    branch: Schema.optionalKey(Schema.String),
    files: Schema.Array(GitCommitFile),
    patch: Schema.String,
    /** Files whose diff is shown; set only when the patch was cut to the render budget. */
    shownFiles: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.String,
  }),
]);
export type GitCommitResult = typeof GitCommitResult.Type;

/** `git show --numstat -z` output after the format line: one record per file. */
export const parseNumstat = (stdout: string): ReadonlyArray<GitCommitFile> => {
  const files: GitCommitFile[] = [];
  const fields = stdout.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const match = fields[index]?.replace(/^\n+/u, "").match(/^(\d+|-)\t(\d+|-)\t(.*)$/su);
    if (!match) continue;
    let path = match[3] ?? "";
    // A rename leaves the path empty and names the old and the new one in the next two fields.
    if (path === "") {
      path = fields[index + 2] ?? "";
      index += 2;
    }
    if (path === "") continue;
    files.push({
      path,
      ...(match[1] === "-" ? {} : { additions: Number(match[1]), deletions: Number(match[2]) }),
    });
  }
  return files;
};

/** A git operation left unfinished in the working tree. */
export const GitOperation = Schema.Literals(["rebase", "merge", "cherry-pick", "revert", "bisect"]);
export type GitOperation = typeof GitOperation.Type;

/**
 * A repository at a glance: the branch, whether work is uncommitted, the
 * latest commit, and how the branch stands against the repository's base
 * branch. Every optional field is absent when it is not known; a reader
 * shows nothing for it and never a stand-in.
 */
export const GitSummary = Schema.Struct({
  /** The repository's top level: one repository, one summary, however many seats sit in it. */
  root: Schema.String,
  branch: Schema.String,
  detached: Schema.Boolean,
  /** The working tree differs from HEAD: staged, unstaged, or a new untracked file. Ignored files do not count. */
  dirty: Schema.Boolean,
  operation: Schema.optionalKey(GitOperation),
  head: Schema.optionalKey(GitCommit),
  /** Absent when the repository has no base branch, or the branch is the base. */
  base: Schema.optionalKey(
    Schema.Struct({
      /** The ref compared against, as git names it: "origin/main", "main". */
      ref: Schema.String,
      ahead: Schema.optionalKey(Schema.Number),
      behind: Schema.optionalKey(Schema.Number),
      /** Lines the branch adds and removes since it left the base. Absent when the diff ran out of time. */
      additions: Schema.optionalKey(Schema.Number),
      deletions: Schema.optionalKey(Schema.Number),
    }),
  ),
});
export type GitSummary = typeof GitSummary.Type;

export const GitSummaryResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), summary: GitSummary }),
  Schema.Struct({
    ok: Schema.Literal(false),
    /** Why there is nothing to show: no folder, not a repository, git is not installed, or git failed. */
    reason: Schema.Literals(["no-folder", "not-a-repository", "no-git", "failed"]),
  }),
]);
export type GitSummaryResult = typeof GitSummaryResult.Type;

/**
 * What a review reads. "working": everything in the folder that is not yet
 * committed, new files included. "base": everything the branch has committed
 * since it left the base branch, as one combined diff.
 */
export const GitReviewView = Schema.Literals(["working", "base"]);
export type GitReviewView = typeof GitReviewView.Type;

export const GitReviewResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    view: GitReviewView,
    patch: Schema.String,
    /** Set when the patch was cut to the render budget, as in GitShowResult. */
    files: Schema.optionalKey(Schema.Number),
    shownFiles: Schema.optionalKey(Schema.Number),
    branch: Schema.String,
    /** Short sha of HEAD when the diff was read; absent before the first commit. */
    head: Schema.optionalKey(Schema.String),
    /** The ref compared against, for the "base" view. Absent when the repository has no base, or the branch is it. */
    base: Schema.optionalKey(Schema.String),
    /** New untracked files left out because there were too many to read. */
    untrackedLeftOut: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);
export type GitReviewResult = typeof GitReviewResult.Type;

/**
 * What a review is of, said honestly. Git cannot tell which session wrote an
 * uncommitted line, so the working view names the folder, never a session.
 */
export const gitReviewTitle = (view: GitReviewView, base?: string): string =>
  view === "working" ? "Uncommitted changes in this folder" : base ? `Committed on this branch since ${base}` : "No base branch to compare with";

/** The state a review was read from, as one line a reader of the mail can act on. */
export const gitReviewedState = (review: {
  readonly view: GitReviewView;
  readonly branch: string;
  readonly head?: string | undefined;
  readonly base?: string | undefined;
}): string => {
  const at = review.head ? ` at ${review.head}` : "";
  return review.view === "working"
    ? `uncommitted changes in the folder, on ${review.branch}${at}`
    : `commits on ${review.branch}${at} since ${review.base ?? "the base branch"}`;
};

/** One commit under review, as the mail names it: its short id and what it says. */
export const gitReviewedCommit = (commit: { readonly sha: string; readonly subject?: string | undefined }): string => {
  const subject = commit.subject?.trim();
  return subject ? `commit ${commit.sha.slice(0, 7)}, "${subject}"` : `commit ${commit.sha.slice(0, 7)}`;
};

/** The path a file section of a patch is about: the new side, or the old side for a deleted file. */
export const patchFilePath = (section: string): string => {
  const next = section.match(/^\+\+\+ (?:b\/)?(.+)$/mu)?.[1]?.trim();
  if (next && next !== "/dev/null") return next;
  const previous = section.match(/^--- (?:a\/)?(.+)$/mu)?.[1]?.trim();
  if (previous && previous !== "/dev/null") return previous;
  return section.match(/^diff --git a\/(.+?) b\//mu)?.[1] ?? "file";
};

/** `git status --porcelain=v2`: any entry line, a new untracked file included, means work is uncommitted. */
export const porcelainHasChanges = (stdout: string): boolean =>
  stdout.split("\n").some((line) => line.length > 0 && !line.startsWith("# "));

/** `git rev-list --left-right --count base...HEAD` prints "<behind>\t<ahead>". */
export const parseAheadBehind = (stdout: string): { readonly ahead: number; readonly behind: number } | undefined => {
  const match = stdout.trim().match(/^(\d+)\s+(\d+)$/u);
  return match ? { behind: Number(match[1]), ahead: Number(match[2]) } : undefined;
};

/** The candidates a repository's base branch is chosen from, most trusted first. */
export const GIT_BASE_CANDIDATES = ["origin/main", "origin/master", "main", "master"] as const;

/**
 * The repository's base branch: what the remote calls its default
 * (`origin/HEAD`), else the first of origin/main, origin/master, main, master
 * that exists. None of them: no base, and nothing is compared.
 */
export const chooseGitBase = (input: {
  /** `git symbolic-ref --short refs/remotes/origin/HEAD`, when it resolves. */
  readonly originHead?: string | undefined;
  /** Which of GIT_BASE_CANDIDATES exist, by short name. */
  readonly existing: ReadonlyArray<string>;
}): string | undefined => {
  const originHead = input.originHead?.trim();
  if (originHead) return originHead;
  const present = new Set(input.existing.map((ref) => ref.trim()));
  return GIT_BASE_CANDIDATES.find((candidate) => present.has(candidate));
};

/** A branch is its own base when the base is that same local branch. */
export const isOwnGitBase = (branch: string, base: string): boolean => base === branch;

/** One readable piece of the summary line. */
export type GitSummaryPart = {
  readonly kind: "branch" | "dirty" | "operation" | "ahead" | "behind" | "additions" | "deletions" | "subject" | "age";
  readonly text: string;
  /** What the piece means, for a tooltip and a screen reader. */
  readonly label: string;
};

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

const commitAge = (nowMs: number, iso: string): string | undefined => {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return undefined;
  const delta = Math.max(0, nowMs - at);
  if (delta < 60_000) return "now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
};

/**
 * The summary as the pieces of one line, in reading order. A piece is left
 * out when its value is unknown or says nothing (zero ahead, zero lines): the
 * line never shows a number it does not have.
 */
export const gitSummaryParts = (summary: GitSummary, nowMs: number): ReadonlyArray<GitSummaryPart> => {
  const parts: GitSummaryPart[] = [];
  const shortHead = summary.head?.sha.slice(0, 7);
  parts.push(
    summary.detached
      ? { kind: "branch", text: shortHead ? `detached at ${shortHead}` : "detached", label: "No branch is checked out" }
      : { kind: "branch", text: summary.branch, label: `Branch ${summary.branch}` },
  );
  if (summary.operation) {
    parts.push({ kind: "operation", text: `${summary.operation} in progress`, label: `A ${summary.operation} is unfinished` });
  }
  if (summary.dirty) parts.push({ kind: "dirty", text: "*", label: "Uncommitted changes" });
  const base = summary.base;
  if (base) {
    if (base.ahead !== undefined && base.ahead > 0) {
      parts.push({ kind: "ahead", text: `↑${base.ahead}`, label: `${plural(base.ahead, "commit", "commits")} ahead of ${base.ref}` });
    }
    if (base.behind !== undefined && base.behind > 0) {
      parts.push({ kind: "behind", text: `↓${base.behind}`, label: `${plural(base.behind, "commit", "commits")} behind ${base.ref}` });
    }
    if (base.additions !== undefined && base.additions > 0) {
      parts.push({ kind: "additions", text: `+${base.additions}`, label: `${plural(base.additions, "line", "lines")} added since ${base.ref}` });
    }
    if (base.deletions !== undefined && base.deletions > 0) {
      parts.push({ kind: "deletions", text: `-${base.deletions}`, label: `${plural(base.deletions, "line", "lines")} removed since ${base.ref}` });
    }
  }
  if (summary.head) {
    const subject = summary.head.subject.trim();
    if (subject) parts.push({ kind: "subject", text: subject, label: `Latest commit: ${subject}` });
    const age = commitAge(nowMs, summary.head.authoredAt);
    if (age) {
      const when = new Date(summary.head.authoredAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      parts.push({ kind: "age", text: age, label: `Committed ${when}` });
    }
  }
  return parts;
};

const RECORD = "\x1e";
const FIELD = "\x00";

export const isGitSha = (value: string): boolean => GIT_SHA_PATTERN.test(value.trim());

export const parseShortstat = (text: string): GitLocStats | undefined => {
  const match = text.match(
    /(\d+) files? changed(?:.*?(\d+) insertions?\(\+\))?(?:.*?(\d+) deletions?\(-\))?/u,
  );
  if (!match?.[1]) return undefined;
  return {
    files: Number(match[1]),
    additions: Number(match[2] ?? 0),
    deletions: Number(match[3] ?? 0),
  };
};

export const parseGitLogRecord = (record: string): GitCommit | undefined => {
  const fields = record.split(FIELD);
  if (fields.length < 4) return undefined;
  const sha = fields[0]?.trim() ?? "";
  if (!isGitSha(sha)) return undefined;
  const rest = fields.slice(3).join(FIELD);
  const authoredAt = rest.split("\n")[0]?.trim() ?? "";
  const stats = parseShortstat(rest);
  return {
    sha,
    subject: fields[1] ?? "",
    author: fields[2] ?? "",
    authoredAt,
    ...(stats ? { stats } : {}),
  };
};

export const parseGitLog = (stdout: string): ReadonlyArray<GitCommit> => {
  const commits: GitCommit[] = [];
  for (const chunk of stdout.split(RECORD)) {
    const parsed = parseGitLogRecord(chunk);
    if (parsed) commits.push(parsed);
  }
  return commits;
};

export type PorcelainBranch = {
  readonly oid?: string;
  readonly head?: string;
  readonly detached: boolean;
  readonly upstream?: string;
  readonly ahead?: number;
  readonly behind?: number;
};

export const parsePorcelainV2Branch = (stdout: string): PorcelainBranch => {
  let oid: string | undefined;
  let head: string | undefined;
  let detached = false;
  let upstream: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  for (const raw of stdout.split("\n")) {
    if (!raw.startsWith("# ")) continue;
    const body = raw.slice(2);
    if (body.startsWith("branch.oid ")) {
      const value = body.slice("branch.oid ".length).trim();
      if (value && value !== "(initial)") oid = value;
      continue;
    }
    if (body.startsWith("branch.head ")) {
      const value = body.slice("branch.head ".length).trim();
      if (value === "(detached)") {
        detached = true;
        head = "HEAD";
      } else if (value.length > 0) {
        head = value;
      }
      continue;
    }
    if (body.startsWith("branch.upstream ")) {
      const value = body.slice("branch.upstream ".length).trim();
      if (value.length > 0) upstream = value;
      continue;
    }
    if (body.startsWith("branch.ab ")) {
      const match = body.slice("branch.ab ".length).trim().match(/^\+(\d+) -(\d+)$/u);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    }
  }
  return {
    ...(oid ? { oid } : {}),
    ...(head ? { head } : {}),
    detached,
    ...(upstream ? { upstream } : {}),
    ...(ahead !== undefined ? { ahead } : {}),
    ...(behind !== undefined ? { behind } : {}),
  };
};

export const GIT_LOG_FORMAT = "%x1e%H%x00%s%x00%an%x00%aI";
export const GIT_LOG_LIMIT_DEFAULT = 80;
export const GIT_LOG_LIMIT_MAX = 200;
export const GIT_PATCH_MAX_BYTES = 2 * 1024 * 1024;

/**
 * What the commit browser may hand the diff view. The view highlights on the
 * renderer thread, so this bounds how long one opened commit can hold it: a
 * patch past the budget is cut at file and hunk boundaries, never mid-hunk.
 */
export type GitPatchRenderBudget = {
  readonly maxBytes: number;
  readonly maxLines: number;
  /** One file's share: the view highlights a file in one task, so this bounds that task. */
  readonly maxFileLines: number;
};

export const GIT_PATCH_RENDER_BUDGET: GitPatchRenderBudget = {
  maxBytes: 160 * 1024,
  maxLines: 3_000,
  maxFileLines: 400,
};

export type CappedPatch = {
  readonly patch: string;
  /** Files in the whole patch. */
  readonly files: number;
  /** Files kept, the last possibly in part. Equal to files when nothing was cut. */
  readonly shownFiles: number;
  readonly truncated: boolean;
};

const FILE_HEADER = "diff --git ";
const HUNK_HEADER = "@@";

const splitBefore = (lines: ReadonlyArray<string>, starts: string): string[][] => {
  const sections: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith(starts) && current.length > 0) {
      sections.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) sections.push(current);
  return sections;
};

/**
 * One patch per file, each starting at its `diff --git` line. The diff view
 * takes exactly one file per patch; anything before the first file (a commit
 * header) is dropped.
 */
export const splitPatchFiles = (patch: string): ReadonlyArray<string> =>
  splitBefore(patch.split("\n"), FILE_HEADER)
    .filter((section) => section[0]?.startsWith(FILE_HEADER) === true)
    .map((section) => section.join("\n"));

const sectionBytes = (lines: ReadonlyArray<string>): number =>
  lines.reduce((sum, line) => sum + line.length + 1, 0);

const HUNK_RANGE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/u;

/**
 * The first lines of one hunk that fit, with the header's counts rewritten
 * to match so the cut hunk is still a valid one. Empty when not one body
 * line fits or the header does not parse.
 */
const cutHunk = (
  hunk: ReadonlyArray<string>,
  budget: { readonly maxBytes: number; readonly maxLines: number },
): string[] => {
  const [head = "", ...body] = hunk;
  const range = HUNK_RANGE.exec(head);
  if (!range) return [];
  const kept: string[] = [];
  let bytes = head.length + 1;
  let oldCount = 0;
  let newCount = 0;
  for (const line of body) {
    if (bytes + line.length + 1 > budget.maxBytes || kept.length + 2 > budget.maxLines) break;
    kept.push(line);
    bytes += line.length + 1;
    if (line.startsWith("-")) oldCount += 1;
    else if (line.startsWith("+")) newCount += 1;
    else if (!line.startsWith("\\")) {
      oldCount += 1;
      newCount += 1;
    }
  }
  if (kept.length === 0) return [];
  return [`@@ -${range[1]},${String(oldCount)} +${range[2]},${String(newCount)} @@${range[3]}`, ...kept];
};

/**
 * Cut a unified patch to the render budget. Files are kept in order; a file
 * longer than its share keeps its first maxFileLines (whole hunks, then the
 * first lines of the hunk that crosses) and the next file still gets its
 * turn. When the whole budget runs out the file that crossed is cut the same
 * way and the rest are left out. Bytes are counted as UTF-16 code units,
 * which is what the view pays for.
 */
export const capPatchForRender = (
  patch: string,
  budget: GitPatchRenderBudget = GIT_PATCH_RENDER_BUDGET,
): CappedPatch => {
  const lines = patch.split("\n");
  const sections = splitBefore(lines, FILE_HEADER);
  const preamble = sections[0]?.[0]?.startsWith(FILE_HEADER) ? [] : (sections.shift() ?? []);
  const files = sections.length;

  const kept: string[] = [...preamble];
  let bytes = sectionBytes(preamble);
  let shownFiles = 0;
  let truncated = false;
  for (const section of sections) {
    const linesLeft = budget.maxLines - kept.length;
    const bytesLeft = budget.maxBytes - bytes;
    const fileLines = Math.min(budget.maxFileLines, linesLeft);
    const size = sectionBytes(section);
    if (section.length <= fileLines && size <= bytesLeft) {
      kept.push(...section);
      bytes += size;
      shownFiles += 1;
      continue;
    }
    truncated = true;
    const cut = cutSection(section, { maxLines: fileLines, maxBytes: bytesLeft });
    if (cut.length > 0) {
      kept.push(...cut);
      bytes += sectionBytes(cut);
      shownFiles += 1;
    }
    // Cut for its own length: the next file still gets its turn. Cut for
    // the whole budget: nothing after it fits either.
    const spentBudget = fileLines < budget.maxFileLines || size > bytesLeft;
    if (spentBudget) break;
  }
  if (!truncated) return { patch, files, shownFiles: files, truncated: false };
  return { patch: kept.join("\n"), files, shownFiles, truncated: true };
};

/**
 * One file's header, the whole hunks that fit and the first lines of the
 * hunk that crosses. Empty when not one body line fits.
 */
const cutSection = (
  section: ReadonlyArray<string>,
  budget: { readonly maxBytes: number; readonly maxLines: number },
): string[] => {
  const [header = [], ...hunks] = splitBefore(section, HUNK_HEADER);
  const partial: string[] = [];
  let partialBytes = sectionBytes(header);
  for (const hunk of hunks) {
    const hunkSize = sectionBytes(hunk);
    if (
      partialBytes + hunkSize <= budget.maxBytes &&
      header.length + partial.length + hunk.length <= budget.maxLines
    ) {
      partial.push(...hunk);
      partialBytes += hunkSize;
      continue;
    }
    partial.push(
      ...cutHunk(hunk, {
        maxBytes: budget.maxBytes - partialBytes,
        maxLines: budget.maxLines - header.length - partial.length,
      }),
    );
    break;
  }
  return partial.length > 0 ? [...header, ...partial] : [];
};
