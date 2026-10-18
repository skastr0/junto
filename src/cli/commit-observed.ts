/**
 * `junto commit-observed`: run by a seat's post-commit hook, never by an
 * agent. Reports HEAD and the repo's top level to Junto under the seat's
 * credential, so Junto knows which seat made the commit.
 *
 * It never changes the commit: success prints nothing, and any failure is
 * one line on stderr with a non-zero exit, inside a hard deadline.
 */
import { spawnSync } from "node:child_process";
import { Effect } from "effect";
import type { WorkOpName } from "../shared/work-control";
import { WorkSocket, WorkSocketLive } from "./core/socket";

/** The socket call's own bound, inside the process deadline. */
export const COMMIT_OBSERVED_CALL_MS = 1_500;
/** Nothing in this process outlives this, whatever hangs. */
export const COMMIT_OBSERVED_DEADLINE_MS = 2_500;

const COMMIT_OBSERVED_WORK_OP = "commit.observed" as WorkOpName;

const quiet = (reason: string): void => {
  process.stderr.write(`junto: this commit is not attributed to the seat: ${reason}\n`);
  process.exitCode = 1;
};

/** HEAD and the top level of the repo the hook runs in. */
export const readHead = (cwd: string = process.cwd()): { readonly sha: string; readonly repo: string } | undefined => {
  const run = spawnSync("git", ["rev-parse", "HEAD", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    timeout: 1_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (run.status !== 0) return undefined;
  const [sha, repo] = run.stdout.split("\n").map((line) => line.trim());
  return sha && repo ? { sha, repo } : undefined;
};

const reasonOf = (error: unknown): string => {
  const tag = (error as { readonly _tag?: unknown })?._tag;
  if (tag === "RuntimeDown") return "Junto is not running";
  if (tag === "AuthError") return "this process has no seat credential Junto accepts";
  const message = (error as { readonly message?: unknown })?.message;
  return typeof message === "string" && message.length > 0 ? message : "the report failed";
};

export const runCommitObserved = async (): Promise<void> => {
  const deadline = setTimeout(() => {
    quiet("the report timed out");
    process.exit(1);
  }, COMMIT_OBSERVED_DEADLINE_MS);
  deadline.unref();
  try {
    const head = readHead();
    if (head === undefined) return quiet("git could not name HEAD");
    await Effect.runPromise(
      Effect.gen(function* () {
        const socket = yield* WorkSocket;
        return yield* socket.call(COMMIT_OBSERVED_WORK_OP, head, COMMIT_OBSERVED_CALL_MS);
      }).pipe(Effect.provide(WorkSocketLive)),
    );
  } catch (error) {
    quiet(reasonOf(error));
  } finally {
    clearTimeout(deadline);
  }
};
