/**
 * Each seat's unread total for the phone (0.11.3): the desktop badge's own
 * count (`unreadTotals`, work/mail-reads.ts), read once per canvas and
 * change however many phones list its seats. New mail on the canvas and a
 * read point that moves, from any surface, forget the canvas; the next
 * seats.list or seat.get reads it again, and each connection's seat.changed
 * follows from the number moving.
 */

export type SeatUnreadTotals = (canvasName: string, nodeIds: ReadonlyArray<string>) => Promise<ReadonlyMap<string, number> | undefined>;

export type SeatUnread = {
  /** The totals of these seats; a seat absent when its count could not be read. */
  readonly totals: (canvasName: string, nodeIds: ReadonlyArray<string>) => Promise<ReadonlyMap<string, number>>;
  /** Something a count reads changed on the canvas: read it again next time. */
  readonly forget: (canvasName: string) => void;
};

const NONE: ReadonlyMap<string, number> = new Map();

export const makeSeatUnread = (read: SeatUnreadTotals): SeatUnread => {
  // One read in flight or done per canvas, shared by every caller until the canvas is forgotten.
  const held = new Map<string, { readonly nodeIds: ReadonlySet<string>; readonly totals: Promise<ReadonlyMap<string, number>> }>();
  return {
    totals: (canvasName, nodeIds) => {
      const entry = held.get(canvasName);
      if (entry !== undefined && nodeIds.every((nodeId) => entry.nodeIds.has(nodeId))) return entry.totals;
      // A seat new to the canvas widens the read; the seats already held are counted again with it.
      const wanted = new Set([...(entry?.nodeIds ?? []), ...nodeIds]);
      const totals = read(canvasName, [...wanted]).then(
        (counted) => counted ?? NONE,
        () => NONE,
      );
      const next = { nodeIds: wanted, totals };
      held.set(canvasName, next);
      // A count that could not be read is not kept: the next caller tries again.
      void totals.then((counted) => {
        if (counted === NONE && held.get(canvasName) === next) held.delete(canvasName);
      });
      return totals;
    },
    forget: (canvasName) => {
      held.delete(canvasName);
    },
  };
};
