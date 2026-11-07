/**
 * The Observability panel's group, as the window reaches it: the core's
 * reads of its ring (src/contract/core/observability.ts), forwarded by main
 * unchanged, and one live stream main serves itself. The stream is the
 * panel's watch: it opens the core's watch slot when it starts, sends the
 * ring's counts, then each new row and each clear, and closes the slot when
 * it ends. So a slot never outlives the panel that opened it. Main's own
 * rows (`ObservabilityAppend`) are not the window's to call.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, type RpcClient, type RpcClientError } from "effect/rpc";
import { ObservabilityLogEntry, ObservabilitySnapshot } from "../../shared/observability";
import { ObservabilityCleared } from "../core/channels";
import { ObservabilityRpcs } from "../core/observability";
import { windowClient } from "./link";

/** The core's calls the window makes as they are: a query and a clear. */
export const ObservabilityForwarded = ObservabilityRpcs.omit("ObservabilityWatch", "ObservabilityUnwatch", "ObservabilityAppend");

/** What the live stream sends: the ring as the watch opened, then each row and each clear. */
export const ObservabilityLiveEvent = Schema.TaggedUnion({
  Opened: { snapshot: ObservabilitySnapshot },
  Row: { entry: ObservabilityLogEntry },
  Cleared: { cleared: ObservabilityCleared },
});
export type ObservabilityLiveEvent = typeof ObservabilityLiveEvent.Type;

export const ObservabilityWindowRpcs = ObservabilityForwarded.add(
  /** The panel's watch: `Opened` first, then every row and clear until the stream ends. */
  Rpc.make("ObservabilityLive", { success: ObservabilityLiveEvent, stream: true }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** The window's client of the observability group. A call fails with `RpcClientError` when the link is gone. */
export class ObservabilityWindow extends Context.Service<
  ObservabilityWindow,
  RpcClient.FromGroup<typeof ObservabilityWindowRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/ObservabilityWindow") {
  static readonly layer = Layer.effect(ObservabilityWindow, windowClient(ObservabilityWindowRpcs));
}
