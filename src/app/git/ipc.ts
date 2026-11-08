/**
 * Main's handlers of the window's git group (src/contract/window/git.ts):
 * every read goes to the core's git group as it is, where a `git` spawn
 * belongs. `cwd` is the node's folder, validated there against the node.
 */
import { Effect } from "effect";
import { GitCore } from "../../contract/core/git";
import { GitWindowRpcs } from "../../contract/window/git";
import { forwardTo } from "../window/ipc";

export const GitWindowHandlers = GitWindowRpcs.toLayer(
  Effect.gen(function* () {
    return forwardTo(GitWindowRpcs, yield* GitCore);
  }),
);
