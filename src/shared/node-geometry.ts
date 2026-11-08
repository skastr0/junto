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

/** New free notes: a title and a few lines, not a page. */
export const NOTE_NODE_SIZE = { width: 220, height: 84 } as const;
