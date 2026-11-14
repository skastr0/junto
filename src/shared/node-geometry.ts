import { contentMediaKind, parseContentObjectUrl } from "./content-url";

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

/** The ring's centre inside a seat's box (border 1 plus padding 1, then the 52 ring). */
export const SEAT_RING_CENTRE = { x: 2 + SEAT_RING_PX / 2, y: 2 + SEAT_RING_PX / 2 } as const;

/**
 * Kinds drawn as kind seats (KindSeat.tsx): the seat's 52px ring around the
 * kind's icon, the name, one line. Like agents they render at AGENT_NODE_SIZE
 * whatever their stored size, so older stored sizes need no migration. A file
 * is a kind seat too unless it is an image (isImageFile), which draws at its
 * own stored size.
 */
export const KIND_SEAT_KINDS: ReadonlySet<string> = new Set([
  "task",
  "artifacts",
  "automations",
  "files",
  "page",
  "terminal",
  "git",
  "link",
]);

/** A file node whose path is a content-store image: drawn as the image, not as a kind seat. */
export const isImageFile = (path: string | undefined): boolean => {
  const ref = path === undefined ? undefined : parseContentObjectUrl(path);
  return ref !== undefined && contentMediaKind(ref.mediaType) === "image";
};

/** Kinds that hold a seat ring: agents and kind seats, a file unless it is an image. */
export const holdsSeatRing = (kind: string | undefined, path?: string): boolean =>
  kind === "agent" || (kind !== undefined && KIND_SEAT_KINDS.has(kind)) || (kind === "file" && !isImageFile(path));

/** The size a node is drawn at: fixed for seats and kind seats, stored otherwise. */
export const renderedNodeSize = (
  kind: string | undefined,
  stored: { readonly width: number; readonly height: number; readonly path?: string },
): { readonly width: number; readonly height: number } =>
  holdsSeatRing(kind, stored.path) ? AGENT_NODE_SIZE : { width: stored.width, height: stored.height };

/**
 * Where a ringed card's content box sits against the card's own centre: the
 * sheet pads a seat `1px 10px 1px 1px` (kind-seat.css, factory-grammar.css),
 * so the box the ring is laid out in is 4.5 units left of the card's middle.
 * At far and overview the ring is held at a screen size and centred there, not
 * on the card, and the GPU's owner record carries the same half-difference
 * (engine/scene.ts, renderer.ts).
 */
export const SEAT_CONTENT_CENTRE_DX = -4.5;

/**
 * The square a ringed card's ring is drawn in when the far rule holds it: a
 * 52 unit ring scaled about the card's content-box centre, in board units.
 * `scale` is the tier's seat multiplier (canvas-tier.ts farSeatScale or
 * seatFloorScale, capped by the card's ring room). Absent for a card with no
 * ring, which keeps its own rectangle at every tier.
 */
export const heldRingRect = (
  row: { readonly kind?: string; readonly path?: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  scale: number,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | undefined => {
  if (!holdsSeatRing(row.kind, row.path)) return undefined;
  const size = renderedNodeSize(row.kind, row);
  const side = SEAT_RING_PX * scale;
  return {
    x: row.x + size.width / 2 + SEAT_CONTENT_CENTRE_DX - side / 2,
    y: row.y + size.height / 2 - side / 2,
    width: side,
    height: side,
  };
};

/** New free notes: a title and a few lines, not a page. */
export const NOTE_NODE_SIZE = { width: 220, height: 84 } as const;
