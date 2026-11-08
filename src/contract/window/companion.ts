/**
 * Settings, Companion, as the window reaches it: the core's own companion
 * group (src/contract/core/companion.ts), forwarded by main unchanged, and
 * the two answers only main can give (the local port probe and System
 * Settings). The phone list is a follow stream over the core's notice, so it
 * opens with the list and reads again after each change.
 *
 * The template every core-served window group follows (src/contract/window/
 * references.ts): a call the core answers is the core's rpc value, forwarded
 * by main (`forwardTo`), never a copy; what the core announces becomes a
 * follow stream; every rpc decodes closed, with `annotateRpcs`.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, type RpcClient, type RpcClientError } from "effect/rpc";
import { CompanionDeviceRecord, CompanionStatus } from "../../shared/companion-devices";
import { CompanionRpcs } from "../core/companion";
import { windowClient } from "./link";

/** The core's calls the window makes as they are. The phone list is followed instead. */
export const CompanionForwarded = CompanionRpcs.omit("CompanionDevices");

export const CompanionWindowRpcs = CompanionForwarded.add(
  /** The paired phones now, then again after each change. */
  Rpc.make("CompanionDevicesFollow", { success: Schema.Array(CompanionDeviceRecord), stream: true }),
  /** Whether Remote Login listens: main's own port probe, cheap to ask on every focus. */
  Rpc.make("CompanionRemoteLogin", { success: CompanionStatus.fields.remoteLogin }),
  /** Open System Settings at Sharing, Remote Login (macOS); false on another platform. */
  Rpc.make("CompanionOpenRemoteLoginSettings", { success: Schema.Struct({ ok: Schema.Boolean }) }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** The window's client of the companion group. A call fails with `RpcClientError` when the link is gone. */
export class CompanionWindow extends Context.Service<
  CompanionWindow,
  RpcClient.FromGroup<typeof CompanionWindowRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/CompanionWindow") {
  static readonly layer = Layer.effect(CompanionWindow, windowClient(CompanionWindowRpcs));
}
