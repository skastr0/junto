/**
 * The demo engine, as the window reaches it (--junto-demo only). Main serves
 * this group itself: outside demo mode DemoState answers inactive and
 * DemoWriteEdl answers ok: false, so a window always gets an answer and the
 * behaviour is the flag's, never the registration's.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { windowClient } from "./link";

/** Whether this launch is a demo, and how its take starts. */
export const DemoStateInfo = Schema.Struct({
  active: Schema.Boolean,
  /** JUNTO_DEMO_AUTOROLL=1: the take starts itself shortly after mount. */
  autoroll: Schema.optionalKey(Schema.Boolean),
  /** JUNTO_DEMO_SCENARIO: the scenario to roll; unknown or absent rolls the default. */
  scenarioId: Schema.optionalKey(Schema.String),
});
export type DemoStateInfo = typeof DemoStateInfo.Type;

/** One executed op, planned against actual time, for post (music sync, overlays, cuts). */
export const DemoEdlEntry = Schema.Struct({
  beat: Schema.Number,
  plannedMs: Schema.Number,
  actualMs: Schema.Number,
  /** Compact op tag, e.g. "add-nodes:12" or "camera-fit". */
  op: Schema.String,
});
export type DemoEdlEntry = typeof DemoEdlEntry.Type;

/** A take's edit decision list: every op the conductor ran, and when. */
export const DemoEdl = Schema.Struct({
  scenarioId: Schema.String,
  bpm: Schema.Number,
  startedAtEpochMs: Schema.Number,
  entries: Schema.Array(DemoEdlEntry),
});
export type DemoEdl = typeof DemoEdl.Type;

export const DemoWriteEdlResult = Schema.Struct({
  ok: Schema.Boolean,
  path: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
export type DemoWriteEdlResult = typeof DemoWriteEdlResult.Type;

export const DemoWindowRpcs = RpcGroup.make(
  Rpc.make("DemoState", { success: DemoStateInfo }),
  /** Write a finished take's EDL under ~/.junto/demo. */
  Rpc.make("DemoWriteEdl", { payload: { edl: DemoEdl }, success: DemoWriteEdlResult }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** The window's client of the demo group. A call fails with `RpcClientError` when the link is gone. */
export class DemoWindow extends Context.Service<
  DemoWindow,
  RpcClient.FromGroup<typeof DemoWindowRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/DemoWindow") {
  static readonly layer = Layer.effect(DemoWindow, windowClient(DemoWindowRpcs));
}
