import type { ArtifactMoveRun } from "@shared/artifact-move";
import { asNodeId } from "@shared/model";
import type { OverseerArgsFor, OverseerCaller, OverseerErrorBody } from "@shared/overseer-control";
import type { ActorRef } from "@shared/work-protocol";

/**
 * `artifact.move`: the operator's move, for an overseer (0.11/10 M3).
 *
 * The answer is main's, unchanged. An artifact that is refused is a row in
 * the run result, not a failure of the operation: one artifact that cannot
 * move does not hide what happened to the others. A target that is not an
 * Artifacts node fails the whole call, and nothing moves.
 */
export type OverseerArtifactMoveOutcome =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: OverseerErrorBody };

export const ARTIFACT_MOVE_MISSING = "moving artifacts is not available in this build";
/** Main failed instead of answering. Its own message is not repeated. */
export const ARTIFACT_MOVE_FAILED = "the move could not be carried out";

const answer = async (
  caller: OverseerCaller,
  args: OverseerArgsFor<"artifact.move">,
  actor: ActorRef,
  run: ArtifactMoveRun,
): Promise<OverseerArtifactMoveOutcome> => {
  const answered = await run(
    { canvasName: args.canvas ?? caller.canvasName, artifactIds: args.artifactIds, toNode: asNodeId(args.to) },
    // History names the overseer seat that moved them.
    { kind: "seat", seatId: actor.seatId, nodeId: asNodeId(caller.nodeId) },
  );
  if (!answered.ok) {
    return {
      ok: false,
      error: { type: answered.code === "not_found" ? "NotFound" : "InvalidArguments", message: answered.message },
    };
  }
  const { ok: _ok, ...result } = answered;
  return { ok: true, data: result };
};

export const executeOverseerArtifactMove = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"artifact.move">,
  actor: ActorRef,
  run: ArtifactMoveRun | undefined,
): Promise<OverseerArtifactMoveOutcome> =>
  run === undefined
    ? Promise.resolve({ ok: false, error: { type: "Unsupported", message: ARTIFACT_MOVE_MISSING } })
    : answer(caller, args, actor, run).catch(
        (): OverseerArtifactMoveOutcome => ({ ok: false, error: { type: "InternalError", message: ARTIFACT_MOVE_FAILED } }),
      );
