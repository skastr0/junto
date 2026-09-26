/**
 * Canonical canvas footprints for fixed-geometry instruments.
 *
 * An agent is a seat: a 52px ring around its portrait, the name, one line.
 * Agents render at this size whatever their stored size (convert.ts), so
 * changing it needs no migration.
 */
export const AGENT_NODE_SIZE = { width: 184, height: 56 } as const;
