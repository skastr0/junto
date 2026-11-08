/**
 * What the window reads of the shell environment: the core's own group
 * (src/contract/core/shell-environment.ts), forwarded by main unchanged, and
 * the core's change notices as one event stream main serves itself. So a
 * change to a core rpc's payload or answer fails main's forward and the
 * window's callers in one compile. Names, directories and typed causes only:
 * no value crosses.
 */
import { Context, Layer } from "effect";
import { Rpc, type RpcClient, type RpcClientError } from "effect/rpc";
import { ShellEnvironmentChange } from "../../shared/shell-environment";
import { ShellEnvironmentRpcs } from "../core/shell-environment";
import { windowClient } from "./link";

export const ShellEnvironmentWindowRpcs = ShellEnvironmentRpcs.add(
  /** Each environment that replaces the one in use, from now on: an event, so none is dropped. */
  Rpc.make("ShellEnvironmentChanges", { success: ShellEnvironmentChange, stream: true }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** The window's client of the shell environment group. A call fails with `RpcClientError` when the link is gone. */
export class ShellEnvironmentWindow extends Context.Service<
  ShellEnvironmentWindow,
  RpcClient.FromGroup<typeof ShellEnvironmentWindowRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/ShellEnvironmentWindow") {
  static readonly layer = Layer.effect(ShellEnvironmentWindow, windowClient(ShellEnvironmentWindowRpcs));
}
