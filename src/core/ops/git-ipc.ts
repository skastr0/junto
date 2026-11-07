/**
 * The Git node's reads, in the core. They run `git` in the node's folder, and
 * a spawn belongs where the work is: main keeps the window and the channel,
 * the core runs the reads. The adapter is unchanged and read-only.
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
import type {
  GitCommitResult,
  GitLogResult,
  GitReviewResult,
  GitReviewView,
  GitShowResult,
  GitStatusResult,
  GitSummaryResult,
} from "@shared/git";
import { coreOps, type CoreOp } from "../ops";

declare module "../ops" {
  interface CoreOps {
    "git.status": CoreOp<{ readonly cwd: string }, GitStatusResult>;
    "git.log": CoreOp<{ readonly cwd: string; readonly limit: number }, GitLogResult>;
    "git.show": CoreOp<{ readonly cwd: string; readonly sha: string }, GitShowResult>;
    "git.commit": CoreOp<{ readonly cwd: string; readonly sha: string }, GitCommitResult>;
    "git.summary": CoreOp<{ readonly cwd: string }, GitSummaryResult>;
    "git.review": CoreOp<{ readonly cwd: string; readonly view: GitReviewView }, GitReviewResult>;
  }
}

coreOps({
  "git.status": ({ cwd }) => Effect.promise(() => readGitStatus(cwd)),
  "git.log": ({ cwd, limit }) => Effect.promise(() => readGitLog(cwd, limit)),
  "git.show": ({ cwd, sha }) => Effect.promise(() => readGitShow(cwd, sha)),
  "git.commit": ({ cwd, sha }) => Effect.promise(() => readGitCommit(cwd, sha)),
  "git.summary": ({ cwd }) => Effect.promise(() => readGitSummary(cwd)),
  "git.review": ({ cwd, view }) => Effect.promise(() => readGitReview(cwd, view)),
});
