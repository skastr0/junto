/**
 * Canonical canvas footprints for fixed-geometry instruments.
 *
 * An agent is a seat: a 52px ring around its portrait, the name, one line.
 * Agents render at this size whatever their stored size (convert.ts), so
 * changing it needs no migration.
 */
export const AGENT_NODE_SIZE = { width: 184, height: 56 } as const;

/**
 * Terminal and git are instruments in the seat's language: a 40px ring
 * around the kind's glyph, the name, one line. Like agents they render at
 * this size whatever their stored size, so older, larger stored sizes need
 * no migration.
 */
export const INSTRUMENT_NODE_SIZE = { width: 176, height: 44 } as const;

/** Kinds that render at INSTRUMENT_NODE_SIZE. */
export const INSTRUMENT_KINDS: ReadonlySet<string> = new Set(["terminal", "git"]);

/** The size a node is drawn at: fixed for seats and instruments, stored otherwise. */
export const renderedNodeSize = (
  kind: string | undefined,
  stored: { readonly width: number; readonly height: number },
): { readonly width: number; readonly height: number } =>
  kind === "agent"
    ? AGENT_NODE_SIZE
    : kind !== undefined && INSTRUMENT_KINDS.has(kind)
      ? INSTRUMENT_NODE_SIZE
      : { width: stored.width, height: stored.height };

/** New free notes: a title and a few lines, not a page. */
export const NOTE_NODE_SIZE = { width: 220, height: 84 } as const;
