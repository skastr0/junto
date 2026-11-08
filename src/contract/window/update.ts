/**
 * Updates (Mac and Linux, readiness-gated install): the window reads where
 * this machine's update stands, asks for a check, and asks to restart into a
 * staged release. Main holds the update service and serves this group itself.
 *
 * The template every window group follows:
 * - the contract is an `RpcGroup` whose payloads, successes and errors are
 *   Schemas, decoded closed on both ends: `annotateRpcs`, never `annotate`,
 *   because Effect's server and client read each rpc's own parse options;
 * - main serves it with handlers from `toLayer`, a required record, so a
 *   missing or mistyped handler fails main's compile (`src/app/update/ipc.ts`);
 * - the window reaches it through the client service below.
 *
 * A refused check or install is an answer (an `UpdateStatus` in phase
 * `error`, with its code), not a failure: the window shows it as it does any
 * other status.
 */
import { Context, Layer } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { UpdateStatus } from "../../shared/update";
import { windowClient } from "./link";

export const UpdateWindowRpcs = RpcGroup.make(
  /**
   * Where the update stands now, then every change after it: whole statuses,
   * so a window that falls behind skips to the latest.
   */
  Rpc.make("UpdateStates", { success: UpdateStatus, stream: true }),
  /** Ask the feed now; answers the status the check ended in. */
  Rpc.make("UpdateCheck", { success: UpdateStatus }),
  /**
   * Validate the staged release, quiesce, and restart into it. Answers only
   * when the install was refused or failed; on success this process exits.
   */
  Rpc.make("UpdateRestartAndInstall", { success: UpdateStatus }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** The window's client of the update group. A call fails with `RpcClientError` when the link is gone. */
export class UpdateWindow extends Context.Service<UpdateWindow, RpcClient.FromGroup<typeof UpdateWindowRpcs, RpcClientError.RpcClientError>>()(
  "@junto/contract/UpdateWindow",
) {
  static readonly layer = Layer.effect(UpdateWindow, windowClient(UpdateWindowRpcs));
}
