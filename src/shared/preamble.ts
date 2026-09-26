import { Schema } from "effect";

/**
 * A preamble is an ephemeral, process-bound note about what an agent seat is
 * doing. It is deliberately not part of the canvas document or work mailbox;
 * the Command Center only paints it for the bounded lifetime carried by this
 * event.
 *
 * The agent's own `junto preamble` is one source. The others are facts the
 * app already sees (the seat's tool calls, its declared signals, the AI's
 * thread-health reading, mail across its wires, its control state); each
 * says who is speaking (`provenance`) and what happened (`action`), so the
 * surface can colour and mark it without re-deriving anything.
 */
export const PREAMBLE_TTL_MS = 30_000;
export const PREAMBLE_MAX_TEXT_LENGTH = 280;

/** Who the note speaks for. */
export const PREAMBLE_PROVENANCES = ["agent", "ai", "system", "operator"] as const;
export type PreambleProvenance = (typeof PREAMBLE_PROVENANCES)[number];

/** What happened. `say` is the agent's own preamble. */
export const PREAMBLE_ACTIONS = [
  "say",
  "tool",
  "signal",
  "signal-clear",
  "health",
  "mail-in",
  "mail-out",
  "mail-failed",
  "state",
] as const;
export type PreambleAction = (typeof PREAMBLE_ACTIONS)[number];

/** Theme hue names; each resolves to a `--color-*` token. */
export const PREAMBLE_TONES = ["second", "amber", "crimson", "cyan", "green", "indigo", "violet", "steel"] as const;
export type PreambleTone = (typeof PREAMBLE_TONES)[number];

export const PreambleEventSchema = Schema.Struct({
  preambleId: Schema.String,
  canvasName: Schema.String,
  nodeId: Schema.String,
  text: Schema.String,
  expiresAt: Schema.Number,
  /** Absent means the agent's own `junto preamble`. */
  provenance: Schema.optionalKey(Schema.Literals(PREAMBLE_PROVENANCES)),
  action: Schema.optionalKey(Schema.Literals(PREAMBLE_ACTIONS)),
  tone: Schema.optionalKey(Schema.Literals(PREAMBLE_TONES)),
});

export type PreambleEvent = typeof PreambleEventSchema.Type;

/** Keep a preamble to one small, readable sentence before it reaches the UI. */
export const normalizePreambleText = (value: string): string =>
  value.replace(/\s+/gu, " ").trim();

/** A deliverable is news for a few seconds, not a sentence to keep reading. */
export const PREAMBLE_TOOL_TTL_MS = 8_000;

/**
 * Seat tool calls worth telling, in words. A preamble is premium space over
 * the seat, so only a call that leaves something behind for others earns
 * one: a verdict posted, an artifact published. Routine reads and chores
 * (checking tasks, reading mail, claiming work, editing the pad) are what an
 * agent does all day and say nothing; the preamble and signals carry their
 * own event, and mail is told by wire traffic at delivery.
 */
export const SEAT_TOOL_PHRASE: Readonly<Record<string, string>> = {
  "verdict.post": "posted a verdict",
  "artifact.publish": "published an artifact",
};

/** The preamble for one successful seat tool call, or undefined when it is not news. */
export const seatToolPreamble = (input: {
  readonly preambleId: string;
  readonly canvasName: string;
  readonly nodeId: string;
  readonly op: string;
  readonly now: number;
}): PreambleEvent | undefined => {
  const phrase = SEAT_TOOL_PHRASE[input.op];
  if (phrase === undefined) return undefined;
  return {
    preambleId: input.preambleId,
    canvasName: input.canvasName,
    nodeId: input.nodeId,
    text: phrase,
    expiresAt: input.now + PREAMBLE_TOOL_TTL_MS,
    provenance: "agent",
    action: "tool",
    tone: "indigo",
  };
};
