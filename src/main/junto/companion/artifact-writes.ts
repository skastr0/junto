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
import type { Artifact, ArtifactBody, ArtifactOp } from "@shared/wire/artifact";
import type { ContentRef } from "@shared/wire/content-ref";
import type { ItemId } from "@shared/wire/ids";
import { AppRuntime } from "../../runtime";
import { mainAuthoringGate } from "../main-authoring-gate";
import { applyArtifact, colourArtifactLabel, liveResourceIpcPorts } from "../work/resource-ipc";
import { WorkService } from "../work/service";
import { ContentService } from "../content/service";
import { claimStagedContent } from "../content/stage";
import { artifactStageSeat } from "./stage";

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
/** The content refs a body names: a file's bytes, or a link that points at stored content. */
const refsOfBody = (body: ArtifactBody): ReadonlyArray<ContentRef> =>
  body.type === "file" ? [body.content] : body.type === "link" && body.target.kind === "content" ? [body.target.content] : [];

/**
 * The staged-for-artifact bytes an op names (0.11.3, section 6): a create or a
 * whole-body replace carries them in its body; a pad edit carries them in its
 * `upsertImage` patches. Each ref staged under the artifact seat is claimed by
 * the apply — once, since the stage owner goes with the claim — and kept under
 * the artifact for good.
 */
const stagedRefsOf = (op: ArtifactOp): ReadonlyArray<ContentRef> => {
  if (op.op === "create") return refsOfBody(op.body);
  if (op.op !== "edit") return [];
  if (op.edit.kind === "replace") return refsOfBody(op.edit.body);
  if (op.edit.type === "pad")
    return op.edit.patches.flatMap((patch) => (patch.op === "upsert" && patch.layer === "image" ? [patch.image.ref] : []));
  return [];
};

/** Bind every artifact-staged ref an applied op named to the artifact's own owner; one never staged is just a ref. */
const claimFor = (args: ApplyArgs, artifactId: ItemId, version: number): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const content = yield* Effect.serviceOption(ContentService);
    if (Option.isNone(content)) return;
    for (const ref of stagedRefsOf(args.op)) {
      yield* claimStagedContent(content.value, {
        ...artifactStageSeat(args.canvasName),
        ref,
        owner: { kind: "artifact", canvasName: args.canvasName, nodeId: args.nodeId, recordId: `${artifactId}@${String(version)}` },
      }).pipe(Effect.ignore);
    }
  });

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
              // An applied write claims the staged bytes it named: once, under the version that holds them.
              if (outcome.kind === "applied" && Option.isSome(head))
                yield* claimFor(args, args.artifactId as ItemId, head.value.version);
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
