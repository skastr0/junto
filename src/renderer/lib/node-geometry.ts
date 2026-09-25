/**
 * Canonical canvas footprints for fixed-geometry instruments.
 *
 * An agent is a seat: a 56px ring around its portrait, the name, one line.
 * Existing canvases keep their stored sizes; the seat centres itself in any
 * height, so no migration is needed.
 */
export const AGENT_NODE_SIZE = { width: 240, height: 72 } as const;
