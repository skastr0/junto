/**
 * Canonical canvas footprints for fixed-geometry nodes.
 *
 * An agent is a seat: a 52px ring around its portrait, the name, one line.
 * Wide enough for an eighteen letter name ("product-automation") and for the
 * longest line Junto itself writes ("done, not read yet") without an ellipsis.
 * Agents render at this size whatever their stored size (convert.ts), so
 * changing it needs no migration.
 */
export const AGENT_NODE_SIZE = { width: 216, height: 56 } as const;

/** The ring a seat's portrait sits in (activity-atlas.ts, data-mark-size="seat"). */
export const SEAT_RING_PX = 52;

/**
 * Kinds drawn as kind seats (KindSeat.tsx): the seat's 52px ring around the
 * kind's icon, the name, one line. Like agents they render at AGENT_NODE_SIZE
 * whatever their stored size, so older stored sizes need no migration. A file
 * is not here: an image file draws at its own stored size, and only a plain
 * path file draws a kind seat, in its stored box.
 */
export const KIND_SEAT_KINDS: ReadonlySet<string> = new Set([
  "task",
  "artifacts",
  "automations",
  "page",
  "terminal",
  "git",
  "link",
]);

/** Kinds that hold a seat ring: agents and kind seats. */
export const holdsSeatRing = (kind: string | undefined): boolean =>
  kind === "agent" || (kind !== undefined && KIND_SEAT_KINDS.has(kind));

/** The size a node is drawn at: fixed for seats and kind seats, stored otherwise. */
export const renderedNodeSize = (
  kind: string | undefined,
  stored: { readonly width: number; readonly height: number },
): { readonly width: number; readonly height: number } =>
  holdsSeatRing(kind) ? AGENT_NODE_SIZE : { width: stored.width, height: stored.height };

/** New free notes: a title and a few lines, not a page. */
export const NOTE_NODE_SIZE = { width: 220, height: 84 } as const;
