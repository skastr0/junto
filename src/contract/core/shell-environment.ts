/**
 * The shell environment group: what Onboarding and Settings read of what the
 * core took from the operator's login shell, and the operator's ask for a
 * fresh read. The core's copy is the one that writes the environment its
 * spawns use, so it answers (`src/core/ops/shell-environment.ts`); main relays
 * (`src/app/shell-environment/ipc.ts`) and keeps no copy. Names, directories
 * and typed causes only: no value crosses.
 */
import { Context, Layer } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { ShellEnvironmentStatus } from "../../shared/shell-environment";
import { coreClient } from "./link";

export const ShellEnvironmentRpcs = RpcGroup.make(
  Rpc.make("ShellEnvironmentStatus", { success: ShellEnvironmentStatus }),
  /** The operator asked for a fresh read: the next spawn uses it. */
  Rpc.make("ShellEnvironmentRefresh", { success: ShellEnvironmentStatus }),
).annotate(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the shell environment group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class ShellEnvironmentCore extends Context.Service<
  ShellEnvironmentCore,
  RpcClient.FromGroup<typeof ShellEnvironmentRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/ShellEnvironmentCore") {
  static readonly layer = Layer.effect(ShellEnvironmentCore, coreClient(ShellEnvironmentRpcs));
}
