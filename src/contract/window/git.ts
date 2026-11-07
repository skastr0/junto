/**
 * The Git node's reads, as the window reaches them: the core's own git group
 * (src/contract/core/git.ts), every call forwarded by main unchanged. So a
 * change to a git rpc's payload or answer fails main's forward and the
 * window's callers in one compile, with no second contract. Each answer is
 * the adapter's own result, which says in its own words when a read could
 * not be made; a payload the core's schema refuses is refused at main's edge.
 */
import { Context, Layer } from "effect";
import type { RpcClient, RpcClientError } from "effect/rpc";
import { GitRpcs } from "../core/git";
import { windowClient } from "./link";

/** The core's group as it is: each of its rpcs already refuses an excess field. */
export const GitWindowRpcs = GitRpcs;

/** The window's client of the git group. A call fails with `RpcClientError` when the link is gone. */
export class GitWindow extends Context.Service<GitWindow, RpcClient.FromGroup<typeof GitWindowRpcs, RpcClientError.RpcClientError>>()(
  "@junto/contract/GitWindow",
) {
  static readonly layer = Layer.effect(GitWindow, windowClient(GitWindowRpcs));
}
