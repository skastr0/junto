import type { Effect } from "effect";
import type { ExchangeFrame } from "../../src/shared/work-exchange";
import { rowsHandlers, RowsLink, type RowsChannelContext } from "../../src/core/work/exchange/channel";
import type { RowExchange } from "../../src/core/work/exchange/session";

/** A frame as it crosses: encoded by the rows contract, then JSON. */
export const rowsWire = (frame: ExchangeFrame): unknown => JSON.parse(JSON.stringify(RowsLink.events!.encode(frame)));

/**
 * The rows channel driven by hand, frame by frame, as a session drives it:
 * each frame through the contract's decode, then its event handler.
 */
export const rowsChannel = (exchange: RowExchange) => {
  const handlers = rowsHandlers(exchange);
  return {
    /** The contract's closed, strict decode; throws for anything else. */
    decodeEvent: (wire: unknown): ExchangeFrame => RowsLink.events!.decode(wire) as ExchangeFrame,
    handleEvent: (context: RowsChannelContext, frame: ExchangeFrame): Effect.Effect<void, unknown> => handlers.event(frame, context),
    opened: handlers.opened,
    closed: handlers.closed,
  };
};
