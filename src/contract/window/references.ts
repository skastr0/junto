/**
 * The app briefing and references, as the window reaches them: the core's
 * own references group (src/contract/core/references.ts), its writes
 * forwarded by main unchanged, and its reads as three follow streams main
 * serves itself. So a change to a
 * core rpc's payload, success or error fails main's forward and the window's
 * callers in one compile, with no second contract.
 *
 * The template every core-served window group follows:
 * - a call the core answers is the core's rpc value, forwarded by main
 *   (`forwardTo`, src/app/window/ipc.ts), never a copy;
 * - what the core announces becomes a follow stream: it opens with the
 *   current state and sends the state again after each change, so no read
 *   races a notice;
 * - every rpc decodes closed, with `annotateRpcs`.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, type RpcClient, type RpcClientError } from "effect/rpc";
import { AppBriefing, ReferencePlace, ReferenceSummary, StoredReference } from "../../shared/references";
import { ReferencesRpcs, ReferencesUnavailable } from "../core/references";
import { windowClient } from "./link";

/** The core's calls the window makes as they are: the writes. Its reads are followed instead. */
export const ReferencesForwarded = ReferencesRpcs.omit("ReferencesBriefingRead", "ReferencesList", "ReferencesRead");

export const ReferencesWindowRpcs = ReferencesForwarded.add(
  /** The app briefing now, then as it stands after each change. */
  Rpc.make("ReferencesBriefingFollow", { success: Schema.NullOr(AppBriefing), error: ReferencesUnavailable, stream: true }),
  /** One place's references now, then after each change there. */
  Rpc.make("ReferencesListFollow", {
    payload: { place: ReferencePlace },
    success: Schema.Array(ReferenceSummary),
    error: ReferencesUnavailable,
    stream: true,
  }),
  /** One reference now (null when there is none), then after each change to it. */
  Rpc.make("ReferencesReadFollow", {
    payload: { place: ReferencePlace, name: Schema.String },
    success: Schema.NullOr(StoredReference),
    error: ReferencesUnavailable,
    stream: true,
  }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** The window's client of the references group. A call fails with `RpcClientError` when the link is gone. */
export class ReferencesWindow extends Context.Service<
  ReferencesWindow,
  RpcClient.FromGroup<typeof ReferencesWindowRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/ReferencesWindow") {
  static readonly layer = Layer.effect(ReferencesWindow, windowClient(ReferencesWindowRpcs));
}
