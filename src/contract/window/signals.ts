/**
 * Agent signals, as the window reaches them: the core's own signals group
 * (src/contract/core/signals.ts), every rpc decoded closed on the window's
 * link. Main answers the list as the core does and runs each write (answer,
 * hand-in, secret value, dismiss) under its authoring gate. So a change to a
 * core rpc's payload, success or error fails main's handlers and the
 * window's callers in one compile. Each change to a signal reaches the
 * window as `SignalsChanged`, main's stream of the core's own push.
 */
import { Context, Layer } from "effect";
import { AgentSignal } from "../../shared/agent-signals";
import { Rpc, type RpcClient, type RpcClientError } from "effect/rpc";
import { SignalsRpcs } from "../core/signals";
import { windowClient } from "./link";

export const SignalsWindowRpcs = SignalsRpcs.add(
  /** One signal as it now stands, each time the core changes one: raised, answered, dismissed or withdrawn. */
  Rpc.make("SignalsChanged", { success: AgentSignal, stream: true }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** The window's client of the signals group. A call fails with `RpcClientError` when the link is gone. */
export class SignalsWindow extends Context.Service<
  SignalsWindow,
  RpcClient.FromGroup<typeof SignalsWindowRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/SignalsWindow") {
  static readonly layer = Layer.effect(SignalsWindow, windowClient(SignalsWindowRpcs));
}
