/**
 * A seat as one work call reaches it, and how the work socket's RPC server
 * hands that seat to each handler.
 *
 * The work server admits a call before it dispatches it: the credential, the
 * caller's node on a live canvas, the pause plane. What it admitted is the
 * call's `WorkSeat`. The `WorkAdmission` middleware provides it to every
 * handler of a group served here, so no handler takes its caller as an
 * argument and none can run without one.
 */
import { Context, Effect, Result } from "effect";
import { RpcMiddleware } from "effect/rpc";
import { type WorkErrorBody, type WorkOpName as WorkOp } from "@shared/work-control";
import { type ActorRef } from "@shared/work-reference";
import { type Message } from "@shared/work-model";
import { type Canvas } from "@shared/model";
import { admitWorkTarget, findNode } from "../work/authz";
import type { WorkServiceShape } from "../work/service";
import { type SeatObservation } from "../work/seat-observation";
import { type readSeatSince } from "../work/seat-since-read";

type SeatSinceRead = ReturnType<typeof readSeatSince>;
/** What `readSeatSince` answers, and how it fails. */
type SeatSince = Effect.Success<SeatSinceRead>;
type SeatSinceError = Effect.Error<SeatSinceRead>;

/** Work-control caller resolved through the sole credential admission path. */
export type WorkCaller = {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly workHome: string;
  /** Occupant label for proof stamps / logs. */
  readonly occupant: string;
  /** Main-issued generation credential incarnation; no client-supplied generation claims. */
  readonly generation: string;
};

export const requireTarget = (
  doc: Canvas,
  callerId: string,
  targetId: string,
  op: WorkOp,
): WorkErrorBody | { readonly node: ReturnType<typeof findNode> } => {
  // Target-scoped ops: canvas physics admit (edge + role law + port facet).
  const admitted = admitWorkTarget(doc, callerId, targetId, op);
  if (Result.isFailure(admitted)) return admitted.failure;
  return { node: admitted.success.node };
};

/** What one admitted work call acts as and reads against. */
export class WorkSeat extends Context.Service<WorkSeat, {
  /** The work store, as the admitting control plane holds it: a handler reaches it only through its seat. */
  readonly work: WorkServiceShape;
  readonly caller: WorkCaller;
  /** The caller's canvas as this call read it. */
  readonly board: Canvas;
  /** The caller as the one actor its process is bound to, or why it is not one. */
  readonly actor: Result.Result<ActorRef, WorkErrorBody>;
  /** One node's mailbox. */
  readonly mailboxOf: (nodeId: string) => Effect.Effect<ReadonlyArray<Message>, WorkErrorBody>;
  /** What this seat sent into every other mailbox, newest first; `snapshot` reads it without waiting for a write in flight. */
  readonly sentMailOf: (snapshot?: boolean) => Effect.Effect<ReadonlyArray<Message & { readonly toNodeId: string }>, WorkErrorBody>;
  /** The call begins to write here, or is refused when its identity went stale first. */
  readonly beginWrite: Effect.Effect<void, WorkErrorBody>;
  /** The live seat observation (seat.wait, seat.read), built only when a handler yields it. */
  readonly observation: Effect.Effect<SeatObservation>;
  /** The caller's canvas is paused: a seat may read but never act. */
  readonly paused: boolean;
  /** The machine name this core's log rows carry, read only when a handler yields it. */
  readonly machine: Effect.Effect<string>;
  /** What changed for this seat since its previous session (since, onboard), read with its work store. */
  readonly readSince: (previousStartedAt: number | undefined, perSection?: number) => Effect.Effect<SeatSince, SeatSinceError>;
}>()("@junto/core/work-control/WorkSeat") {}

/** Provides each handler the seat its call was admitted as. */
export class WorkAdmission extends RpcMiddleware.Service<WorkAdmission, { provides: WorkSeat }>()(
  "@junto/core/work-control/WorkAdmission",
) {}
