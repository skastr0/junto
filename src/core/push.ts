/**
 * The core's end of the push channels (Wave 3): a core service announces a
 * change by channel, and it leaves on the core's one port to main. Main's end
 * is `main-side/core-pushes.ts`; the two share only the registry
 * (`channels.ts`), which types both: a channel not in it does not compile, and
 * a payload that is not that channel's does not compile either.
 *
 * Only the core loads this module. Each core boot provides `CorePushes`: the
 * entry on its port, a windowless core, which has no window to hear them,
 * nowhere. A publisher takes it from its Layer, so a push is in its type.
 */
import { Context, Effect, Layer, Result } from "effect";
import { encodeCorePush, type CorePushChannel, type CorePushOf } from "../contract/core/channels";

/** Where a push goes: its channel, and its payload as the channel's JSON codec encoded it. */
type Send = (channel: CorePushChannel, encoded: unknown) => void;

/**
 * Encode the payload with its channel's Schema and send it. A payload its
 * Schema cannot encode is a bug in the publisher: it is logged with its
 * channel and goes nowhere, so a window never reads it and the core goes on.
 */
const deliver = <K extends CorePushChannel>(to: Send, channel: K, payload: CorePushOf<K>): void => {
  const encoded = encodeCorePush(channel, payload);
  if (Result.isFailure(encoded)) {
    console.error(`[core-pushes] ${channel} was not sent: its payload does not match its Schema: ${encoded.failure.message}`);
    return;
  }
  to(channel, encoded.success);
};

/**
 * Where a core service announces a change: a service, so a publisher's need is
 * in its type, a publish before the core has chosen where pushes go cannot be
 * written, and a test hears it. A core's boot provides one form: `toPort`
 * sends each push to the port to main, `nowhere` is the windowless core's,
 * which has no window to hear them.
 */
export type CorePushesShape = {
  readonly publish: <K extends CorePushChannel>(channel: K, payload: CorePushOf<K>) => Effect.Effect<void>;
};

export class CorePushes extends Context.Service<CorePushes, CorePushesShape>()("@junto/core/CorePushes") {
  /** The pushes over `to`: each is encoded with its channel's Schema and handed to it. For boot code that holds the value before a runtime exists. */
  static readonly over = (to: Send): CorePushesShape => ({
    publish: (channel, payload) => Effect.sync(() => deliver(to, channel, payload)),
  });

  static readonly toPort = (to: Send) => Layer.succeed(CorePushes, CorePushes.over(to));

  /** A windowless core announces to nobody, on purpose. */
  static readonly nowhere = Layer.succeed(CorePushes, { publish: () => Effect.void });
}
