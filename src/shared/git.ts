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
