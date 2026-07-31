import { Schema } from "effect";

/**
 * A preamble is an ephemeral, process-bound note from an agent seat. It is
 * deliberately not part of the canvas document or work mailbox; the Command
 * Center only paints it for the bounded lifetime carried by this event.
 */
export const PREAMBLE_TTL_MS = 30_000;
export const PREAMBLE_MAX_TEXT_LENGTH = 280;

export const PreambleEventSchema = Schema.Struct({
  preambleId: Schema.String,
  canvasName: Schema.String,
  nodeId: Schema.String,
  text: Schema.String,
  expiresAt: Schema.Number,
});

export type PreambleEvent = typeof PreambleEventSchema.Type;

/** Keep a preamble to one small, readable sentence before it reaches the UI. */
export const normalizePreambleText = (value: string): string =>
  value.replace(/\s+/gu, " ").trim();
