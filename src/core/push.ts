/**
 * The core's end of the push channels (Wave 3): a core service announces a
 * change by channel, and it leaves on the core's one port to main. Main's end
 * is `main-side/core-pushes.ts`; the two share only the registry
 * (`channels.ts`), which types both: a channel not in it does not compile, and
 * a payload that is not that channel's does not compile either.
 *
 * Only the core loads this module. Its entry sends pushes on its port; a
 * windowless core, which has no window to hear them, says so and sends them
 * nowhere. A publish before either is a boot-order bug, so it throws.
 */
import { Context, Effect, Layer, Result } from "effect";
import { encodeCorePush, type CorePushChannel, type CorePushOf } from "../contract/core/channels";

/** Where a push goes: its channel, and its payload as the channel's JSON codec encoded it. */
type Send = (channel: CorePushChannel, encoded: unknown) => void;

let send: Send | undefined;

/**
 * Encode the payload with its channel's Schema and send it. A payload its
 * Schema cannot encode is a bug in the publisher: it is logged with its
 * channel and goes nowhere, so a window never reads it and the core goes on.
 */
export const publish = <K extends CorePushChannel>(channel: K, payload: CorePushOf<K>): void => {
  if (send === undefined) throw new Error(`Junto core published ${channel} before its boot chose where pushes go`);
  const encoded = encodeCorePush(channel, payload);
  if (Result.isFailure(encoded)) {
    console.error(`[core-pushes] ${channel} was not sent: its payload does not match its Schema: ${encoded.failure.message}`);
    return;
  }
  send(channel, encoded.success);
};

/** Core boot only: where every publish goes from now on. */
export const sendPushesTo = (next: Send): void => {
  send = next;
};

/**
 * Where an RPC handler publishes: a service, so a handler's push is in its
 * type and a test hears it. The live form hands each push to the port boot
 * chose (`sendPushesTo`).
 */
export class CorePushes extends Context.Service<
  CorePushes,
  { readonly publish: <K extends CorePushChannel>(channel: K, payload: CorePushOf<K>) => Effect.Effect<void> }
>()("@junto/core/CorePushes") {
  static readonly live = Layer.succeed(CorePushes, {
    publish: (channel, payload) => Effect.sync(() => publish(channel, payload)),
  });
}
