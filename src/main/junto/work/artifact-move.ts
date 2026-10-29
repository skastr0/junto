/**
 * Moving artifacts to another Artifacts node (docs/plans/0.11/10-artifact-move.md):
 * the one entry point the overseer CLI and the window go through. Each
 * artifact is one `{ op: "move" }` command on the node it is on now, ruled
 * as any artifact write is, so the move syncs as a rename does and its
 * history is the `artifact.moved` fact. The target is checked once for the
 * whole call; each artifact answers its own row, in the order asked.
 */
import { Effect, Option } from "effect";
import {
  ARTIFACT_MOVE_MAX,
  ARTIFACT_MOVE_REFUSAL_REASON,
  summarizeArtifactMoveRun,
  type ArtifactMoveRun,
  type ArtifactMoveRunAnswer,
  type ArtifactMoveRunInput,
  type ArtifactMoveRunRow,
} from "@shared/artifact-move";
import { titleOf } from "@shared/model/title";
import { mintOpId, type ResourceActor } from "@shared/resource-command";
import { rulingContextOf } from "@shared/ruling-context";
import type { WorkErrorBody } from "@shared/work-control";
import type { ItemId } from "@shared/work-ids";
import type { ResourceIpcPorts } from "./resource-ipc";

export type ArtifactMovePorts = Pick<ResourceIpcPorts, "topology" | "artifacts">;

const failed = (artifactId: ItemId, title?: string): ArtifactMoveRunRow => ({
  artifactId,
  ...(title === undefined ? {} : { title }),
  ok: false,
  code: "failed",
  reason: ARTIFACT_MOVE_REFUSAL_REASON.failed,
});

/** Move each artifact to `toNode`, one ruling each; a bad target or list moves nothing. */
export const moveArtifacts = (
  ports: ArtifactMovePorts,
  input: ArtifactMoveRunInput,
  by: ResourceActor,
): Effect.Effect<ArtifactMoveRunAnswer> =>
  Effect.gen(function* () {
    const { canvasName, artifactIds, toNode } = input;
    if (artifactIds.length < 1 || artifactIds.length > ARTIFACT_MOVE_MAX) {
      return { ok: false, code: "invalid_input", message: `name 1 to ${ARTIFACT_MOVE_MAX} artifacts, not ${artifactIds.length}` } as const;
    }
    if (new Set(artifactIds).size !== artifactIds.length) {
      return { ok: false, code: "invalid_input", message: "name each artifact once" } as const;
    }
    const canvas = yield* Effect.result(ports.topology(canvasName));
    if (canvas._tag === "Failure") return { ok: false, code: "not_found", message: canvas.failure.message } as const;
    const target = canvas.success.nodes.get(toNode);
    if (target === undefined) return { ok: false, code: "not_found", message: `no node ${toNode} on ${canvasName}` } as const;
    if (target.kind !== "artifacts") {
      return { ok: false, code: "invalid_input", message: `${titleOf(target)} is not an Artifacts node` } as const;
    }
    const context = rulingContextOf(canvas.success, () => undefined);
    const rows: ArtifactMoveRunRow[] = [];
    for (const artifactId of artifactIds) {
      const row = yield* moveOne(ports, canvasName, artifactId, toNode, by, context).pipe(
        Effect.catch((_error: WorkErrorBody) => Effect.succeed(failed(artifactId))),
      );
      rows.push(row);
    }
    return { ok: true, ...summarizeArtifactMoveRun(rows) } as const;
  });

const moveOne = (
  ports: ArtifactMovePorts,
  canvasName: string,
  artifactId: ItemId,
  toNode: ArtifactMoveRunInput["toNode"],
  by: ResourceActor,
  context: ReturnType<typeof rulingContextOf>,
): Effect.Effect<ArtifactMoveRunRow, WorkErrorBody> =>
  Effect.gen(function* () {
    const head = yield* ports.artifacts.head(canvasName, artifactId);
    if (Option.isNone(head)) {
      return { artifactId, ok: false, code: "not-found", reason: ARTIFACT_MOVE_REFUSAL_REASON["not-found"] } as const;
    }
    const { title, nodeId: from } = head.value.artifact;
    if (from === toNode) return { artifactId, title, ok: true, outcome: "unchanged", from, to: toNode } as const;
    const outcome = yield* ports.artifacts.submit(
      {
        opId: mintOpId(),
        canvasName,
        actor: by,
        target: { kind: "artifact", nodeId: from, itemId: artifactId },
        basis: null,
        after: [],
        op: { op: "move", to: toNode },
      },
      context,
    );
    if (outcome.kind === "refused") return failed(artifactId, title);
    return { artifactId, title, ok: true, outcome: outcome.kind === "queued" ? "queued" : "moved", from, to: toNode } as const;
  });

let installed: ArtifactMoveRun | undefined;

/** Main installs the live run once its stores are up (ipc.ts). */
export const installArtifactMove = (run: ArtifactMoveRun): void => {
  installed = run;
};

/** The one entry point: every surface that moves artifacts calls this. */
export const runArtifactMove: ArtifactMoveRun = (input, by) =>
  installed === undefined
    ? Promise.resolve({ ok: true, ...summarizeArtifactMoveRun(input.artifactIds.map((artifactId) => failed(artifactId))) })
    : installed(input, by);
