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

/** Short-lived: a tool call is news for a few seconds, not a sentence to read. */
export const PREAMBLE_TOOL_TTL_MS = 6_000;

/**
 * Seat tool calls worth telling, in words. Ops absent here say nothing: the
 * preamble and signals carry their own event, mail is told by wire traffic
 * at delivery, and protocol chatter (ping, doctor) is not news.
 */
export const SEAT_TOOL_PHRASE: Readonly<Record<string, string>> = {
  "tasks.list": "checking tasks",
  "tasks.create": "created a task",
  "tasks.claim": "claimed a task",
  "tasks.update": "updated a task",
  "tasks.show": "reading a task",
  "tasks.rules": "reading task rules",
  "tasks.check": "checking a task",
  "tasks.wait": "waiting on tasks",
  rulings: "reading rulings",
  "content.path": "opening content",
  "content.stat": "checking content",
  "content.materialize": "pulling content",
  "msg.list": "checking mail",
  "msg.read": "reading mail",
  "msg.sent": "reviewing sent mail",
  "msg.react": "reacted to mail",
  "seat.wait": "waiting on a peer",
  "seat.read": "reading a peer's screen",
  "verdict.post": "posted a verdict",
  "artifact.publish": "published an artifact",
  "board.list": "reading the board",
  "board.create_topic": "opened a board topic",
  "board.post": "posted to the board",
  "board.mark_read": "caught up on the board",
  "board.tags": "tagging the board",
  "pad.read": "reading the pad",
  "pad.patch": "edited the pad",
  "sheet.read": "reading the sheet",
  "relay.trigger": "fired a relay",
};

/** Writes land in indigo, reads in steel: a glance tells doing from looking. */
const SEAT_TOOL_WRITES: ReadonlySet<string> = new Set([
  "tasks.create",
  "tasks.claim",
  "tasks.update",
  "msg.react",
  "verdict.post",
  "artifact.publish",
  "board.create_topic",
  "board.post",
  "pad.patch",
  "relay.trigger",
]);

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
    tone: SEAT_TOOL_WRITES.has(input.op) ? "indigo" : "steel",
  };
};
