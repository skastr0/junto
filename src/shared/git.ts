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
