/**
 * The window's two machine-level questions: the one machine command it sends
 * (`src/app/hosts/ipc.ts`), answered in the owner envelope with its progress
 * pushed to the asking window alone, and the doctor's report, which main
 * asks with this installation's station facts (`src/app/ipc-handlers.ts`).
 * The core answers both (`src/core/ops/hosts-ipc.ts`).
 *
 * Both answers are data: a command that fails answers an error envelope, and
 * the doctor reports every service's own state. The one failure a call can
 * have is `RpcClientError`, the core leaving before it answered.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { DoctorReport, StationInfo } from "../../shared/contracts";
import { OperatorResponseEnvelope } from "../../shared/operator-control";
import { coreClient } from "./link";

export const HostsRpcs = RpcGroup.make(
  /**
   * An operator command as the window sent it. The core decodes it closed
   * against the owner's request union and refuses what is not a machine
   * command, so a window cannot reach the companion or authority ops.
   */
  Rpc.make("HostsCommand", {
    payload: { input: Schema.Unknown, requestId: Schema.String },
    success: OperatorResponseEnvelope,
  }),
  Rpc.make("HostsDoctorReport", { payload: { station: StationInfo }, success: DoctorReport }),
).annotate(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the hosts group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class HostsCore extends Context.Service<HostsCore, RpcClient.FromGroup<typeof HostsRpcs, RpcClientError.RpcClientError>>()(
  "@junto/contract/HostsCore",
) {
  static readonly layer = Layer.effect(HostsCore, coreClient(HostsRpcs));
}
