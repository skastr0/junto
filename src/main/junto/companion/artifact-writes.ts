/**
 * The phone's artifact writes (`artifact.apply`), through the desktop's own
 * paths: `applyArtifact` for every item op and `colourArtifactLabel` for the
 * one node op, so a phone write is ruled exactly as a desktop one — the same
 * ruler, and the same writer (the operator), so a replayed opId across
 * connections answers as the first did and never makes a second version.
 *
 * The ruling answers applied with the head as it now stands, queued while the
 * editing machine is elsewhere, or a refusal the phone reads by section 5:
 * `stale` and `rebase_conflict` cross as `conflict` carrying the head; every
 * other refusal is `invalid` with the ruler's sentence.
 */
import { Effect, Option, Result } from "effect";
import type { WorkErrorBody } from "@shared/work-control";
import { outcomeFail, outcomeOk, type CompanionBackend, type CompanionOutcome } from "@shared/companion-core";
import type { CompanionArgsByOp, CompanionResultByOp } from "@shared/wire/companion-protocol";
import type { Artifact } from "@shared/wire/artifact";
import type { ItemId } from "@shared/wire/ids";
import { AppRuntime } from "../../runtime";
import { mainAuthoringGate } from "../main-authoring-gate";
import { applyArtifact, colourArtifactLabel, liveResourceIpcPorts } from "../work/resource-ipc";
import { WorkService } from "../work/service";

/** The ports the desktop's own resource writes use, over this app's work plane. */
const ports = liveResourceIpcPorts(
  (canvasName) =>
    Effect.tryPromise({
      try: () => AppRuntime.runPromise(Effect.flatMap(WorkService, (work) => work.readTopology(canvasName))),
      catch: (): WorkErrorBody => ({
        type: "InternalError",
        message: `canvas ${canvasName} could not be read`,
        details: { retryable: true },
      }),
    }).pipe(Effect.map((read) => read.canvas)),
  (canvasName, nodeId) =>
    Effect.tryPromise({
      try: () => AppRuntime.runPromise(Effect.flatMap(WorkService, (work) => work.readMailbox(canvasName, nodeId))),
      catch: (): WorkErrorBody => ({
        type: "InternalError",
        message: `the artifacts on ${nodeId} could not be read`,
        details: { retryable: true },
      }),
    }),
);

type ApplyArgs = CompanionArgsByOp["artifact.apply"];
type ApplyResult = CompanionResultByOp["artifact.apply"];

/** The artifact's head, wherever it has moved to; absent when the canvas holds no such artifact. */
const headOf = (canvasName: string, artifactId: ItemId) =>
  ports.artifacts.head(canvasName, artifactId).pipe(Effect.map(Option.map((head) => head.artifact)));

/**
 * The refusal as the phone resolves it (docs/artifacts-proposal.md section
 * 5, 2): `stale` and `rebase_conflict` are `conflict` carrying the reason and
 * the artifact at head; every other refusal is `invalid` with the ruler's
 * sentence.
 */
const refused = (error: WorkErrorBody, head: Option.Option<Artifact>): CompanionOutcome<ApplyResult> => {
  const reason = error.details?.reason;
  if (reason !== "stale" && reason !== "rebase_conflict") return outcomeFail("invalid", error.message.slice(0, 500));
  return {
    ok: false,
    error: {
      code: "conflict",
      message: error.message.slice(0, 500),
      reason,
      ...(Option.isSome(head) ? { artifact: head.value } : {}),
    },
  };
};

export const companionArtifactWriteBackend: Pick<CompanionBackend, "artifactApply"> = {
  artifactApply: async (args) => {
    const itemOp = args.op.op !== "labelColour";
    if (itemOp && args.artifactId === undefined) return outcomeFail("invalid", "An artifact write names its artifact.");
    const written = await mainAuthoringGate
      .run("companion.artifact.apply", () =>
        AppRuntime.runPromise(
          Effect.result(
            Effect.gen(function* () {
              const outcome =
                args.op.op === "labelColour"
                  ? yield* colourArtifactLabel(ports, args.canvasName, args.nodeId, args.opId, args.op.label, args.op.colour)
                  : yield* applyArtifact(ports, args.canvasName, args.nodeId, args.artifactId as ItemId, args.opId, args.op);
              // The head answers an applied write, and a conflict refusal, the same way.
              const head =
                itemOp && (outcome.kind === "applied" || outcome.kind === "refused")
                  ? yield* headOf(args.canvasName, args.artifactId as ItemId)
                  : Option.none<Artifact>();
              return { outcome, head };
            }),
          ),
        ),
      )
      .catch(() => undefined);
    if (written === undefined) return outcomeFail("internal", "That write could not be ruled.");
    if (Result.isFailure(written)) return outcomeFail("invalid", written.failure.message.slice(0, 500));
    const { outcome, head } = written.success;
    switch (outcome.kind) {
      case "queued":
        return outcomeOk({ disposition: "queued", opId: outcome.opId });
      case "applied":
        return outcomeOk({
          disposition: "applied",
          ...(Option.isSome(head) ? { artifact: head.value, version: head.value.version } : {}),
        });
      case "refused":
        return refused(outcome.error, head);
    }
  },
};
