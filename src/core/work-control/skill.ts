/**
 * The core's handlers for the work socket's artifact.*, automation.*, references.* and content.stage ops (`SkillRpcs`). Owned by
 * cli-skill. Each reads the seat its call was admitted as (`WorkSeat`), as
 * `src/core/work-control/msg.ts` does, and refuses with the v1 error body as
 * a `WorkFailure`.
 *
 * The verbs themselves stay in `artifact-control.ts`, `automation-control.ts`,
 * `content-stage.ts` and `references/seat-reads.ts`, which the window and
 * the overseer plane share; each handler hands its op there with the seat as
 * that verb takes it. Those verbs answer `unknown`: the contract types each
 * answer against the verb's own result type, and the server's encode refuses
 * one that is not it.
 */
import { Effect, Result } from "effect";
import type { Rpc, RpcGroup } from "effect/rpc";
import { asNodeId } from "@shared/model";
import type { ArtifactControlOp } from "@shared/artifact-control";
import type { AutomationReadOp } from "@shared/automation-control";
import { SkillRpcs } from "../../contract/work/skill";
import { workFailure } from "../../contract/work/failure";
import { handleArtifactOp, liveArtifactPorts } from "../work/artifact-control";
import { handleAutomationRead, liveAutomationPorts } from "../work/automation-control";
import { handleContentStage } from "../work/content-stage";
import { pendingMarksOf } from "../work/op-control";
import { handleSeatReferences } from "../references/seat-reads";
import { WorkAdmission, WorkSeat } from "./seat";

type SkillOp = Rpc.Tag<RpcGroup.Rpcs<typeof SkillRpcs>>;
type Answer<Op extends SkillOp> = Rpc.Success<Rpc.ExtractTag<RpcGroup.Rpcs<typeof SkillRpcs>, Op>>;

/** The seat as the artifact and automation verbs take it: the one actor its process is bound to. */
const seatActor = Effect.gen(function* () {
  const { caller, board, actor } = yield* WorkSeat;
  if (Result.isFailure(actor)) return yield* Effect.fail(actor.failure);
  return {
    canvas: board,
    canvasName: caller.canvasName,
    actor: { kind: "seat" as const, seatId: actor.success.seatId, nodeId: asNodeId(caller.nodeId) },
  };
});

const artifact = <Op extends ArtifactControlOp>(op: Op) => (args: unknown) =>
  Effect.gen(function* () {
    const seat = yield* seatActor;
    return (yield* handleArtifactOp(op, args, seat, { ...liveArtifactPorts, pending: pendingMarksOf("artifact") })) as Answer<Op>;
  }).pipe(Effect.mapError(workFailure));

const automation = <Op extends AutomationReadOp>(op: Op) => (args: unknown) =>
  Effect.gen(function* () {
    const seat = yield* seatActor;
    return (yield* handleAutomationRead(op, args, seat, liveAutomationPorts)) as Answer<Op>;
  }).pipe(Effect.mapError(workFailure));

const references = <Op extends "references.list" | "references.read">(op: Op) => (args: unknown) =>
  Effect.gen(function* () {
    const { caller } = yield* WorkSeat;
    return (yield* handleSeatReferences(op, args, { canvasName: caller.canvasName, nodeId: caller.nodeId })) as Answer<Op>;
  }).pipe(Effect.mapError(workFailure));

/** The skill ops as this core serves them: each handler is handed its admitted seat. */
export const SkillServed = SkillRpcs.middleware(WorkAdmission);

export const SkillHandlers = SkillServed.toLayer(
  SkillServed.of({
    "artifact.list": artifact("artifact.list"),
    "artifact.show": artifact("artifact.show"),
    "artifact.history": artifact("artifact.history"),
    "artifact.create": artifact("artifact.create"),
    "artifact.edit": artifact("artifact.edit"),
    "artifact.label": artifact("artifact.label"),
    "artifact.colour": artifact("artifact.colour"),
    "artifact.comment": artifact("artifact.comment"),
    "artifact.archive": artifact("artifact.archive"),
    "artifact.restore": artifact("artifact.restore"),
    "automation.list": automation("automation.list"),
    "automation.show": automation("automation.show"),
    "automation.history": automation("automation.history"),
    "references.list": references("references.list"),
    "references.read": references("references.read"),
    // Seat-local: no edge, no port, and the seat is the process-bound caller, never an argument.
    "content.stage": (args) =>
      Effect.gen(function* () {
        const { caller } = yield* WorkSeat;
        return yield* handleContentStage({ canvasName: caller.canvasName, nodeId: caller.nodeId }, args);
      }).pipe(Effect.mapError(workFailure)),
  }),
);
