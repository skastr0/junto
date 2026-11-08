/**
 * The Git node's reads: status, log, one commit, the summary and the review.
 * They run `git` in the node's folder, and a spawn belongs where the work is,
 * so main asks the core. Every answer is the adapter's own result, which
 * says in its own words when a read could not be made, so none of these
 * calls has an error to act on beyond the core leaving.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import {
  GitCommitResult,
  GitLogResult,
  GitReviewResult,
  GitReviewView,
  GitShowResult,
  GitStatusResult,
  GitSummaryResult,
} from "../../shared/git";
import { coreClient } from "./link";

export const GitRpcs = RpcGroup.make(
  Rpc.make("GitStatus", { payload: { cwd: Schema.String }, success: GitStatusResult }),
  Rpc.make("GitLog", { payload: { cwd: Schema.String, limit: Schema.Number }, success: GitLogResult }),
  Rpc.make("GitShow", { payload: { cwd: Schema.String, sha: Schema.String }, success: GitShowResult }),
  Rpc.make("GitCommit", { payload: { cwd: Schema.String, sha: Schema.String }, success: GitCommitResult }),
  Rpc.make("GitSummary", { payload: { cwd: Schema.String }, success: GitSummaryResult }),
  Rpc.make("GitReview", { payload: { cwd: Schema.String, view: GitReviewView }, success: GitReviewResult }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the git group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class GitCore extends Context.Service<GitCore, RpcClient.FromGroup<typeof GitRpcs, RpcClientError.RpcClientError>>()(
  "@junto/contract/GitCore",
) {
  static readonly layer = Layer.effect(GitCore, coreClient(GitRpcs));
}
