/**
 * The `rows` channel of a link: the row exchange behind the link's seam.
 *
 * A link hands this channel whatever the other machine sent. Nothing of it is
 * used before `decodeEvent`: the one closed, strict decode of a frame, which
 * rejects any field or kind this machine does not know. The channel carries
 * events only; a request or a response on it is refused. Who the peer is
 * comes from the link's admitted hello, never from a frame.
 */
import { Effect, Result, Schema } from "effect";
import type { InstallationId } from "@shared/installation-id";
import { decodeExchangeFrame, encodeExchangeFrame, type ExchangeFrame } from "@shared/work-exchange";
import type { RowExchange } from "./session";

/** What this channel needs of a link: who is there and how to send it a frame. */
export type RowsChannelContext = {
  readonly peer: { readonly installationId: InstallationId };
  readonly sendEvent: (channel: "rows", payload: unknown) => Effect.Effect<void, unknown>;
};

/** Why the rows channel refused what a link handed it; the link closes as frame-invalid with this cause. */
export class RowsFrameRefused extends Schema.TaggedError<RowsFrameRefused>()("RowsFrameRefused", {
  check: Schema.Literals(["unknown-frame", "no-requests"]),
  message: Schema.String,
}) {}

/** The one decode of a frame from another machine. Throws for anything else. */
export const decodeRowsEvent = (payload: unknown): ExchangeFrame => {
  const decoded = decodeExchangeFrame(payload);
  if (Result.isFailure(decoded)) throw new RowsFrameRefused({ check: "unknown-frame", message: "a frame this machine does not know" });
  return decoded.success;
};

const noRequests = (): never => {
  throw new RowsFrameRefused({ check: "no-requests", message: "the rows channel carries no requests" });
};

export const makeRowsChannel = (exchange: RowExchange) => ({
  decodeRequest: noRequests,
  decodeResponse: noRequests,
  decodeEvent: decodeRowsEvent,
  /**
   * A frame the session refuses fails here, and the link closes. A handler
   * never sends: only the link's worker in session.ts does, so a handler never
   * waits on credit the peer can only give once this handler has returned.
   */
  handleEvent: (context: RowsChannelContext, payload: unknown): Effect.Effect<void, unknown> =>
    exchange.receive(context.peer.installationId, payload),
  opened: (context: RowsChannelContext): Effect.Effect<void, unknown> =>
    exchange.opened({
      peer: context.peer.installationId,
      send: (frame) => context.sendEvent("rows", encodeExchangeFrame(frame)),
    }),
  closed: (context: RowsChannelContext): Effect.Effect<void, unknown> =>
    Effect.sync(() => exchange.closed(context.peer.installationId)),
});
