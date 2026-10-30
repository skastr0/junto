import { Effect, Schema } from "effect";
import { linkLog } from "./log";
import type { LinkChannel, LinkChannelHandler } from "./types";

/**
 * What stands on a catalog channel that has no owner yet (consensus until T3,
 * authority until F5). Every channel in the catalog is bound at every machine,
 * so a peer's frame on one is never a bad frame that closes the link: a
 * request is refused, a one-way frame is dropped, and the first of either on a
 * link is logged, naming the channel and never a payload.
 */

export class LinkChannelUnbound extends Schema.TaggedError<LinkChannelUnbound>()("LinkChannelUnbound", {
  channel: Schema.String,
  message: Schema.String,
}) {}

export const unboundYet = (channel: LinkChannel): LinkChannelHandler => {
  /** The links that have been told once. */
  const noted = new Set<string>();
  const note = (sessionId: string, peer: string): Effect.Effect<void> => {
    if (noted.has(sessionId)) return Effect.void;
    noted.add(sessionId);
    return linkLog("Warning", "a peer used a link channel that has no handler yet", { channel, peer, sessionId });
  };
  return {
    // Nothing here reads a payload, so any JSON passes the decode.
    decodeRequest: (payload) => payload,
    decodeResponse: (payload) => payload,
    decodeEvent: (payload) => payload,
    handleRequest: (context) => note(context.sessionId, context.peer.machineName).pipe(
      Effect.andThen(Effect.fail(new LinkChannelUnbound({ channel, message: `The ${channel} channel has no handler on this machine yet` }))),
    ),
    handleEvent: (context) => note(context.sessionId, context.peer.machineName),
    closed: (context) => Effect.sync(() => { noted.delete(context.sessionId); }),
  };
};
