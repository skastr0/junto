/**
 * The seat commits store: which seat made each commit, as Junto observed it
 * (`seat_commits`, state migration 21 -> 22). Written when a seat's
 * post-commit hook reports HEAD under the seat's credential; read at a
 * session's close for its record. Git stays the record of the commit itself:
 * the store holds only who reported it, from which session, and when.
 */
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export type SeatCommit = {
  readonly repo: string;
  readonly sha: string;
  readonly canvasName: string;
  readonly seatId: string;
  readonly sessionId: string | null;
  readonly observedAt: number;
};

/** A full commit id, lowercase hex: SHA-1 (40) or SHA-256 (64). */
export const isCommitSha = (value: string): boolean => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);

/** How long main waits on git when it checks a reported commit. */
const GIT_TIMEOUT_MS = 2_000;

const git = (repo: string, args: ReadonlyArray<string>): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["-C", repo, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });

/**
 * Whether `sha` is a commit in the repo at `repo`, whose top level is `repo`.
 * A report names a commit Junto can find, or it is not recorded.
 */
export const commitExists = async (repo: string, sha: string): Promise<boolean> => {
  if (!isAbsolute(repo) || !isCommitSha(sha)) return false;
  const [type, top] = await Promise.all([
    git(repo, ["cat-file", "-t", sha]),
    git(repo, ["rev-parse", "--show-toplevel"]),
  ]);
  return type?.trim() === "commit" && top?.trim() === repo;
};

/**
 * Record a commit for a seat. The first seat to report a commit keeps it; a
 * second report changes nothing. Returns the row that holds the commit.
 */
export const recordSeatCommit = (commit: SeatCommit) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO seat_commits(repo, sha, canvas_name, seat_id, session_id, observed_at)
      VALUES (${commit.repo}, ${commit.sha}, ${commit.canvasName}, ${commit.seatId}, ${commit.sessionId}, ${commit.observedAt})
      ON CONFLICT(repo, sha) DO NOTHING
    `;
    const rows = yield* sql<CommitRow>`
      SELECT repo, sha, canvas_name, seat_id, session_id, observed_at FROM seat_commits
      WHERE repo = ${commit.repo} AND sha = ${commit.sha}
    `;
    return rows[0] === undefined ? commit : fromRow(rows[0]);
  });

type CommitRow = {
  readonly repo: string;
  readonly sha: string;
  readonly canvas_name: string;
  readonly seat_id: string;
  readonly session_id: string | null;
  readonly observed_at: number | bigint;
};

const fromRow = (row: CommitRow): SeatCommit => ({
  repo: row.repo,
  sha: row.sha,
  canvasName: row.canvas_name,
  seatId: row.seat_id,
  sessionId: row.session_id,
  observedAt: Number(row.observed_at),
});

/**
 * The commits a seat session made: reported under that session's id, or,
 * while Junto did not know the id yet, reported by the seat while the
 * session ran. Oldest first.
 */
export const seatSessionCommits = (input: {
  readonly canvasName: string;
  readonly seatId: string;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly endedAt: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<CommitRow>`
      SELECT repo, sha, canvas_name, seat_id, session_id, observed_at FROM seat_commits
      WHERE canvas_name = ${input.canvasName} AND seat_id = ${input.seatId}
        AND (
          session_id = ${input.sessionId}
          OR (session_id IS NULL AND observed_at >= ${input.startedAt} AND observed_at <= ${input.endedAt})
        )
      ORDER BY observed_at, sha
    `;
    return rows.map(fromRow);
  });

/** A commit's subject and committer time, read from git; undefined when git no longer has it. */
export const commitSubject = async (
  repo: string,
  sha: string,
): Promise<{ readonly subject: string; readonly committedAt: string } | undefined> => {
  const out = await git(repo, ["log", "-1", "--no-show-signature", "--format=%cI%x00%s", sha, "--"]);
  if (out === undefined) return undefined;
  const [committedAt, subject] = out.replace(/\n$/, "").split("\u0000");
  return committedAt === undefined || subject === undefined ? undefined : { subject, committedAt };
};
