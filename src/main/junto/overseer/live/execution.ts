import { Context } from "effect";
import type { OverseerResult } from "@shared/overseer-control";
import type { StateWriter } from "../../state/engine";

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
  /** Synchronous fence, checked at dispatch and within each owning transaction. */
  readonly assertCurrent: (writer?: StateWriter) => void;
  readonly afterMutation?: (writer: StateWriter, transactionName: string) => void;
  readonly settle?: (result: OverseerResult) => Promise<void>;
}

/** Optional per-run constraint; ordinary operator and worker writes never acquire it. */
export class OverseerLiveExecution extends Context.Service<
  OverseerLiveExecution, OverseerLiveExecutionConstraint
>()("@junto/OverseerLiveExecution") {}
