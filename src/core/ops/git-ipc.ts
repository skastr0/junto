/**
 * The Git node's reads, in the core (src/contract/core/git.ts). They run
 * `git` in the node's folder, and a spawn belongs where the work is: main
 * keeps the window and the channel, the core runs the reads. The adapter is
 * unchanged and read-only.
 */
import { Effect } from "effect";
import {
  readGitCommit,
  readGitLog,
  readGitReview,
  readGitShow,
  readGitStatus,
  readGitSummary,
} from "../adapters/git";
import { GitRpcs } from "../../contract/core/git";

export const GitHandlers = GitRpcs.toLayer({
  GitStatus: ({ cwd }) => Effect.promise(() => readGitStatus(cwd)),
  GitLog: ({ cwd, limit }) => Effect.promise(() => readGitLog(cwd, limit)),
  GitShow: ({ cwd, sha }) => Effect.promise(() => readGitShow(cwd, sha)),
  GitCommit: ({ cwd, sha }) => Effect.promise(() => readGitCommit(cwd, sha)),
  GitSummary: ({ cwd }) => Effect.promise(() => readGitSummary(cwd)),
  GitReview: ({ cwd, view }) => Effect.promise(() => readGitReview(cwd, view)),
});
