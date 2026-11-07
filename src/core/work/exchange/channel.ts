/**
 * The `rows` channel of a link: the row exchange behind the link's seam.
 *
 * Its contract carries events only, under the link's credit window
 * (`LINK_EVENT_WINDOW`, link/session.ts): it has no requests, and its event
 * is the exchange frame (`ExchangeFrame`). The session decodes each frame
 * closed and strict with that schema before this channel sees it, and
 * encodes each frame it sends with it, so a field or kind this machine does
 * not know closes the link as frame-invalid and never reaches the exchange.
 * Who the peer is comes from the link's admitted hello, never from a frame.
 */
import { Effect } from "effect";
import { RpcGroup } from "effect/rpc";
import type { InstallationId } from "@shared/installation-id";
import { ExchangeFrame } from "@shared/work-exchange";
import { bindLinkChannel, linkContract, type LinkContractChannel, type LinkEventOf } from "../../link/contract";
import type { RowExchange } from "./session";

/**
 * The rows channel's contract: no requests, and the exchange frame as its
 * event. No core push means what a frame means: a frame is one machine's
 * word to another about the rows it holds, never a change for a window.
 */
export const RowsLink = linkContract("rows", RpcGroup.make(), { event: ExchangeFrame });

/** What this channel needs of a link: who is there and how to send it a frame. */
export type RowsChannelContext = {
  readonly peer: { readonly installationId: InstallationId };
  /** Which link this is: a link that closes stops only itself, never the one kept in its place. */
  readonly sessionId: string;
  /** The link's send, typed by the contract's event. */
  readonly sendEvent: (channel: typeof RowsLink.channel, payload: LinkEventOf<typeof RowsLink>) => Effect.Effect<void, unknown>;
};

/**
 * The rows channel's handlers, over any context that names the peer and the
 * link. They take no requests, so a caller interrupted mid-request is not
 * theirs to settle.
 */
export const rowsHandlers = (exchange: RowExchange) => ({
  requests: {},
  /**
   * A frame the exchange refuses fails here, and the link closes. A handler
   * never sends: only the link's worker in session.ts does, so a handler never
   * waits on credit the peer can only give once this handler has returned.
   */
  event: (frame: ExchangeFrame, context: RowsChannelContext): Effect.Effect<void, unknown> =>
    exchange.receive(context.peer.installationId, frame),
  opened: (context: RowsChannelContext): Effect.Effect<void, unknown> =>
    exchange.opened({
      peer: context.peer.installationId,
      id: context.sessionId,
      send: (frame) => context.sendEvent(RowsLink.channel, frame),
    }),
  closed: (context: RowsChannelContext): Effect.Effect<void, unknown> =>
    Effect.sync(() => exchange.closed(context.peer.installationId, context.sessionId)),
});

/** The rows channel as a link holds it. */
export const makeRowsChannel = (exchange: RowExchange): LinkContractChannel => bindLinkChannel(RowsLink, rowsHandlers(exchange));
