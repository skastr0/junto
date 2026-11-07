/**
 * Desktop notifications, as the window reaches them: main holds the plane
 * (src/app/notifications/plane.ts) and serves this group itself. The window
 * reports its canvas's open needs, asks for a test banner, reads whether
 * macOS delivers Junto's banners, and opens the system's notification
 * settings; main tells it when the operator clicks a banner and when a silent
 * banner's cue should play, as one event stream.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { NotifyCue, NotifyReport, NotifyTarget } from "../../shared/desktop-notifications";
import { windowClient } from "./link";

/** A banner on demand: whether macOS showed it, and why not when it did not. */
export const NotificationsTestResult = Schema.Struct({ ok: Schema.Boolean, message: Schema.optionalKey(Schema.String) });

/** Whether macOS delivers Junto's banners, as last seen. */
export const NotificationDelivery = Schema.Union([
  Schema.Struct({ state: Schema.Literals(["unknown", "allowed"]) }),
  Schema.Struct({ state: Schema.Literal("blocked"), reason: Schema.String }),
]);
export type NotificationDelivery = typeof NotificationDelivery.Type;

/** What main tells the window: a banner was clicked, or a silent banner's cue should play. */
export const NotifyWindowEvent = Schema.TaggedUnion({
  Activate: { target: NotifyTarget },
  Cue: { cue: NotifyCue },
});
export type NotifyWindowEvent = typeof NotifyWindowEvent.Type;

export const NotificationsWindowRpcs = RpcGroup.make(
  /** The canvas's open needs, for banners and the Dock badge; the phone companion reads it too. */
  Rpc.make("NotificationsReport", { payload: { report: NotifyReport } }),
  /** Show a test banner now (where macOS asks for permission). */
  Rpc.make("NotificationsTest", { success: NotificationsTestResult }),
  Rpc.make("NotificationsDelivery", { success: NotificationDelivery }),
  /** Open the system's notification settings for Junto: true where there are some (macOS). */
  Rpc.make("NotificationsOpenSystemSettings", { success: Schema.Boolean }),
  /** Each click on a banner and each cue, from now on: events, so none is dropped. */
  Rpc.make("NotificationsEvents", { success: NotifyWindowEvent, stream: true }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** The window's client of the notifications group. A call fails with `RpcClientError` when the link is gone. */
export class NotificationsWindow extends Context.Service<
  NotificationsWindow,
  RpcClient.FromGroup<typeof NotificationsWindowRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/NotificationsWindow") {
  static readonly layer = Layer.effect(NotificationsWindow, windowClient(NotificationsWindowRpcs));
}
