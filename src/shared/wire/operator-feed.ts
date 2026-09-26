import { Schema } from "effect";
import { AgentSignalKind } from "./agent-signals";
import { ThreadHealthValue } from "./thread-health";

/**
 * The operator feed: everything on one canvas that wants the operator, as a
 * plain, serializable projection grouped by region. It is UI-free and
 * transport-agnostic so the desktop feed and a later mobile client read the
 * same shape.
 *
 * Three sources, kept distinct:
 * - declared signals (the agent's own claim): blocked, escalate, feedback;
 * - proven control state: the seat's screen shows a dialog that wants input;
 * - AI thread health reading "waiting on the operator", only for a seat
 *   nothing else already lists, and only while the reading is fresh.
 * Every item also carries the seat's health reading as a separate, advisory
 * field; it never changes an item's kind or urgency.
 */

export const OPERATOR_FEED_VERSION = 1 as const;

export const FeedItemKind = Schema.Literals([
  "blocked",
  "attention",
  "escalate",
  "feedback",
  "health",
]);
export type FeedItemKind = typeof FeedItemKind.Type;

/** Higher is more urgent. A proven dialog outranks a declared escalation. */
export const FEED_URGENCY: Readonly<Record<FeedItemKind, number>> = {
  blocked: 5,
  attention: 4,
  escalate: 3,
  feedback: 2,
  health: 1,
};

export const FeedSeat = Schema.Struct({
  nodeId: Schema.String,
  name: Schema.String,
  /** Seed for the seat's generated portrait (its node id today). */
  portraitIdentity: Schema.String,
  harness: Schema.optionalKey(Schema.String),
});
export type FeedSeat = typeof FeedSeat.Type;

export const FeedRegion = Schema.Struct({
  /** Innermost containing region, or null for the open field. */
  regionId: Schema.NullOr(Schema.String),
  label: Schema.String,
  /** Containing region labels, outer to inner. */
  path: Schema.Array(Schema.String),
  /** The region's own JSON Canvas colour (preset "1".."6" or hex), when it has one. */
  color: Schema.optionalKey(Schema.String),
});
export type FeedRegion = typeof FeedRegion.Type;

export const FeedHealth = Schema.Struct({
  value: ThreadHealthValue,
  tone: Schema.Literals(["trouble", "waiting", "steady", "good"]),
  /** Words to show after "AI reads". */
  label: Schema.String,
  confidence: Schema.Number,
  observedAt: Schema.Number,
  /** Older than the reading TTL: show as last observed, never as current. */
  stale: Schema.Boolean,
});
export type FeedHealth = typeof FeedHealth.Type;

export const FeedItem = Schema.Struct({
  itemId: Schema.String,
  kind: FeedItemKind,
  urgency: Schema.Number,
  canvasName: Schema.String,
  seat: FeedSeat,
  region: FeedRegion,
  /** One short sentence. */
  text: Schema.String,
  /** Longer markdown, when the source has it. */
  detail: Schema.optionalKey(Schema.String),
  /** Epoch ms the need began. */
  since: Schema.Number,
  ageMs: Schema.Number,
  /** Present for declared signals: the id to answer or dismiss. */
  signalId: Schema.optionalKey(Schema.String),
  signalKind: Schema.optionalKey(AgentSignalKind),
  health: Schema.optionalKey(FeedHealth),
});
export type FeedItem = typeof FeedItem.Type;

export const FeedSection = Schema.Struct({
  region: FeedRegion,
  items: Schema.Array(FeedItem),
  worstUrgency: Schema.Number,
});
export type FeedSection = typeof FeedSection.Type;

export const OperatorFeed = Schema.Struct({
  version: Schema.Literal(OPERATOR_FEED_VERSION),
  canvasName: Schema.String,
  generatedAt: Schema.Number,
  count: Schema.Number,
  sections: Schema.Array(FeedSection),
});
export type OperatorFeed = typeof OperatorFeed.Type;
