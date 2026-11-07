/**
 * Settings, Companion, against the phone companion in the core: this Mac's
 * readiness to pair, a pairing started, cancelled or its link copied, the
 * phone list, Remove and Restore, and the desktop's notification report the
 * companion reads beside it. Every answer is data the companion already
 * words for Settings, so none of these calls has an error to act on beyond
 * the core leaving.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import {
  CompanionDeviceRecord,
  CompanionKeyRestore,
  CompanionPairStart,
  CompanionRemoval,
  CompanionStatus,
} from "../../shared/companion-devices";
import { NotifyReport } from "../../shared/desktop-notifications";
import { coreClient } from "./link";

/** One phone, by the id Settings shows it with. */
const Device = { deviceId: Schema.String };

export const CompanionRpcs = RpcGroup.make(
  Rpc.make("CompanionStatus", { success: CompanionStatus }),
  Rpc.make("CompanionStartPairing", { success: CompanionPairStart }),
  Rpc.make("CompanionCancelPairing", { payload: Device }),
  /** Copy link: true when the pending pairing's link went on the clipboard. */
  Rpc.make("CompanionCopyLink", { payload: Device, success: Schema.Boolean }),
  Rpc.make("CompanionDevices", { success: Schema.Array(CompanionDeviceRecord) }),
  Rpc.make("CompanionRemove", { payload: Device, success: CompanionRemoval }),
  /** One phone by id, or `all`. */
  Rpc.make("CompanionRestore", { payload: { target: Schema.String }, success: CompanionKeyRestore }),
  /** What the desktop last told its window, written where the phone companion reads it. */
  Rpc.make("CompanionDesktopReport", { payload: { report: NotifyReport } }),
).annotate(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the companion group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class CompanionCore extends Context.Service<CompanionCore, RpcClient.FromGroup<typeof CompanionRpcs, RpcClientError.RpcClientError>>()(
  "@junto/contract/CompanionCore",
) {
  static readonly layer = Layer.effect(CompanionCore, coreClient(CompanionRpcs));
}
