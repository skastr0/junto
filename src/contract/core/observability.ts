/**
 * The observability group: the Observability panel's reads of the core's
 * ring, where every service row is written, and Electron main's own rows,
 * appended there so the panel shows one log. The core answers it
 * (`src/core/ops/observability.ts`); main decodes a panel's query at its own
 * edge (`src/shared/observability.ts`) and reaches the group through the
 * client service below (`src/app/observability/ipc.ts`). A new entry is
 * pushed on `OBSERVABILITY_LOG` only while a panel watches.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { ObservabilityAppendInput, ObservabilityQuery, ObservabilitySnapshot } from "../../shared/observability";
import { coreClient } from "./link";

export const ObservabilityRpcs = RpcGroup.make(
  /** No query reads the ring unfiltered. */
  Rpc.make("ObservabilityQuery", { payload: { query: Schema.optionalKey(ObservabilityQuery) }, success: ObservabilitySnapshot }),
  Rpc.make("ObservabilityClear", { success: ObservabilitySnapshot }),
  /** A panel opened: the newest rows, and every new one pushed until it unwatches. */
  Rpc.make("ObservabilityWatch", { success: ObservabilitySnapshot }),
  Rpc.make("ObservabilityUnwatch"),
  /** Electron main's own row, scrubbed again in the core with the registry only the core holds. */
  Rpc.make("ObservabilityAppend", { payload: { entry: ObservabilityAppendInput } }),
).annotate(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the observability group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class ObservabilityCore extends Context.Service<
  ObservabilityCore,
  RpcClient.FromGroup<typeof ObservabilityRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/ObservabilityCore") {
  static readonly layer = Layer.effect(ObservabilityCore, coreClient(ObservabilityRpcs));
}
