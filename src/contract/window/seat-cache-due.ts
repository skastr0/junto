/**
 * The auto cache mode's question and the operator's offboard buttons, as the
 * window reaches them: the core's own seat-cache-due group
 * (src/contract/core/seat-cache-due.ts). Its calls go to the core forwarded
 * by main unchanged, and the seats due the question are a follow stream main
 * serves over the core's notice. So a change to a core rpc's payload, success
 * or error fails main's forward and the window's callers in one compile.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, type RpcClient, type RpcClientError } from "effect/rpc";
import { SeatCacheDue, SeatCacheDueRpcs } from "../core/seat-cache-due";
import { windowClient } from "./link";

/** The core's calls the window makes as they are. The list is followed instead. */
export const SeatCacheDueForwarded = SeatCacheDueRpcs.omit("SeatCacheDueList");

export const SeatCacheDueWindowRpcs = SeatCacheDueForwarded.add(
  /** Every seat due the question now, here and on linked machines, then the whole list after each change. */
  Rpc.make("SeatCacheDueFollow", { success: Schema.Array(SeatCacheDue), stream: true }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** The window's client of the seat-cache-due group. A call fails with `RpcClientError` when the link is gone. */
export class SeatCacheDueWindow extends Context.Service<
  SeatCacheDueWindow,
  RpcClient.FromGroup<typeof SeatCacheDueWindowRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/SeatCacheDueWindow") {
  static readonly layer = Layer.effect(SeatCacheDueWindow, windowClient(SeatCacheDueWindowRpcs));
}
