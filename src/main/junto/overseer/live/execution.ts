import { Context, type Effect } from "effect";
import type { OverseerResult } from "@shared/overseer-control";

/** Authentication evidence derived by Work control, never from a renderer or model. */
export interface OverseerHostIdentity {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly bindingId: string;
  readonly peerPid: number;
  readonly processGeneration: string;
}

export interface OverseerLiveExecutionConstraint {
  readonly signal?: AbortSignal;
  /** Memory-only fence checked synchronously at dispatch. */
  readonly assertCurrent: () => void;
  /** Durable fence and receipt join the owner's transaction, never opening another. */
  readonly assertCurrentWithin: Effect.Effect<void, unknown>;
  readonly afterMutation?: (transactionName: string) => Effect.Effect<void, unknown>;
  readonly settle?: (result: OverseerResult) => Promise<void>;
}

/** Optional per-run constraint; ordinary operator and worker writes never acquire it. */
export class OverseerLiveExecution extends Context.Service<
  OverseerLiveExecution, OverseerLiveExecutionConstraint
>()("@junto/OverseerLiveExecution") {}
