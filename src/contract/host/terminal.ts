/**
 * The core's terminal port, which Electron main hands it: the core asks as it
 * boots, and main posts it a new port to the terminal process (`pty.connect`
 * on the core's parent port, the port beside it), then answers whether it
 * could. Main posts a fresh one each time the terminal process starts again,
 * unasked. A windowless core never asks: its terminals run in process.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { hostClient } from "./link";

export const TerminalHostRpcs = RpcGroup.make(
  /** True once the port is posted; false when main holds no terminal process for this core. */
  Rpc.make("TerminalConnect", { success: Schema.Boolean }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** The core's client of the terminal host group. */
export class TerminalHost extends Context.Service<
  TerminalHost,
  RpcClient.FromGroup<typeof TerminalHostRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/TerminalHost") {
  static readonly layer = Layer.effect(TerminalHost, hostClient(TerminalHostRpcs));
}
