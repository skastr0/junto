import { Schema } from "effect";
import type { CanvasDoc, CanvasNode } from "./canvas";
import { AgentSignalKind, type AgentSignal } from "./agent-signals";
import { regionStack } from "./graph";
import {
  THREAD_HEALTH_LABEL,
  THREAD_HEALTH_TONE,
  THREAD_HEALTH_TTL_MS,
  ThreadHealthValue,
  type ThreadHealthReading,
} from "./thread-health";

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

// --- inputs -----------------------------------------------------------------

/** A seat as the feed needs it, already resolved from the document. */
export type FeedSeatInput = {
  readonly seat: FeedSeat;
  readonly region: FeedRegion;
  /** Proven control state: the seat's screen wants input. */
  readonly attention?: { readonly reason: string; readonly at: number };
  readonly health?: ThreadHealthReading;
  /**
   * Freshness judged by the producer (the desktop compares screen digests).
   * Absent, the reading is fresh while inside THREAD_HEALTH_TTL_MS.
   */
  readonly healthFresh?: boolean;
};

export type OperatorFeedInput = {
  readonly canvasName: string;
  readonly nowMs: number;
  readonly seats: ReadonlyArray<FeedSeatInput>;
  readonly signals: ReadonlyArray<AgentSignal>;
};

export const OPEN_FIELD: FeedRegion = { regionId: null, label: "open field", path: [] };

/** Innermost containing region of a node, with its outer-to-inner path. */
export const feedRegionFor = (doc: CanvasDoc, nodeId: string): FeedRegion => {
  const stack = regionStack(doc, nodeId);
  const inner = stack[stack.length - 1];
  if (!inner) return OPEN_FIELD;
  const labelOf = (group: (typeof stack)[number]): string => group.label?.trim() || "untitled region";
  return { regionId: inner.id, label: labelOf(inner), path: stack.map(labelOf) };
};

/** Agent seats of a document as feed seats; live planes are joined by node id. */
export const feedSeatsFromDoc = (
  doc: CanvasDoc,
  options: {
    readonly nameOf: (node: CanvasNode) => string;
    readonly attentionByNodeId?: ReadonlyMap<string, { readonly reason: string; readonly at: number }>;
    readonly healthByNodeId?: ReadonlyMap<string, { readonly reading: ThreadHealthReading; readonly fresh?: boolean }>;
  },
): ReadonlyArray<FeedSeatInput> =>
  doc.nodes
    .filter((node) => node.type !== "group" && node.ether?.entity?.kind === "agent")
    .map((node) => {
      const harness = node.ether?.terminal?.harness;
      const attention = options.attentionByNodeId?.get(node.id);
      const health = options.healthByNodeId?.get(node.id);
      return {
        seat: {
          nodeId: node.id,
          name: options.nameOf(node),
          portraitIdentity: node.id,
          ...(typeof harness === "string" ? { harness } : {}),
        },
        region: feedRegionFor(doc, node.id),
        ...(attention ? { attention } : {}),
        ...(health ? { health: health.reading } : {}),
        ...(health?.fresh !== undefined ? { healthFresh: health.fresh } : {}),
      };
    });

// --- projection -------------------------------------------------------------

const healthFresh = (entry: FeedSeatInput, nowMs: number): boolean =>
  entry.healthFresh ??
  (entry.health !== undefined && nowMs - entry.health.observedAt <= THREAD_HEALTH_TTL_MS);

const feedHealth = (entry: FeedSeatInput, reading: ThreadHealthReading, nowMs: number): FeedHealth => ({
  value: reading.value,
  tone: THREAD_HEALTH_TONE[reading.value],
  label: THREAD_HEALTH_LABEL[reading.value],
  confidence: reading.confidence,
  observedAt: reading.observedAt,
  stale: !healthFresh(entry, nowMs),
});

/** Proven attention, said the way the seat card says it. */
export const attentionText = (reason: string): string =>
  /stall/i.test(reason) ? "stalled, needs a look" : "wants your input";

const byUrgencyThenAge = (a: FeedItem, b: FeedItem): number =>
  b.urgency - a.urgency || a.since - b.since || a.itemId.localeCompare(b.itemId);

export const buildOperatorFeed = (input: OperatorFeedInput): OperatorFeed => {
  const { canvasName, nowMs } = input;
  const seatsById = new Map(input.seats.map((entry) => [entry.seat.nodeId, entry] as const));
  const items: FeedItem[] = [];
  const listed = new Set<string>();

  const push = (
    entry: FeedSeatInput,
    item: Omit<FeedItem, "urgency" | "canvasName" | "seat" | "region" | "ageMs" | "health">,
  ): void => {
    listed.add(entry.seat.nodeId);
    items.push({
      ...item,
      urgency: FEED_URGENCY[item.kind],
      canvasName,
      seat: entry.seat,
      region: entry.region,
      ageMs: Math.max(0, nowMs - item.since),
      ...(entry.health ? { health: feedHealth(entry, entry.health, nowMs) } : {}),
    });
  };

  for (const signal of input.signals) {
    if (signal.state !== "open" || signal.canvasName !== canvasName) continue;
    const entry = seatsById.get(signal.nodeId) ?? {
      seat: { nodeId: signal.nodeId, name: "removed seat", portraitIdentity: signal.nodeId },
      region: OPEN_FIELD,
    };
    push(entry, {
      itemId: `signal:${signal.signalId}`,
      kind: signal.kind,
      text: signal.text,
      ...(signal.detail ? { detail: signal.detail } : {}),
      since: signal.createdAt,
      signalId: signal.signalId,
      signalKind: signal.kind,
    });
  }

  for (const entry of input.seats) {
    if (!entry.attention) continue;
    push(entry, {
      itemId: `attention:${entry.seat.nodeId}:${entry.attention.at}`,
      kind: "attention",
      text: attentionText(entry.attention.reason),
      since: entry.attention.at,
    });
  }

  for (const entry of input.seats) {
    const reading = entry.health;
    if (!reading || listed.has(entry.seat.nodeId)) continue;
    if (reading.value !== "waiting_on_operator") continue;
    if (!healthFresh(entry, nowMs)) continue;
    push(entry, {
      itemId: `health:${entry.seat.nodeId}:${reading.provenance.assessmentId}`,
      kind: "health",
      text: `AI reads: ${THREAD_HEALTH_LABEL[reading.value]}`,
      since: reading.observedAt,
    });
  }

  const sections = new Map<string, { region: FeedRegion; items: FeedItem[] }>();
  for (const item of items) {
    const key = item.region.regionId ?? "";
    const section = sections.get(key) ?? { region: item.region, items: [] };
    section.items.push(item);
    sections.set(key, section);
  }
  const ordered = [...sections.values()]
    .map((section) => {
      const sorted = [...section.items].sort(byUrgencyThenAge);
      return { region: section.region, items: sorted, worstUrgency: sorted[0]?.urgency ?? 0 };
    })
    .sort((a, b) => {
      const lead = byUrgencyThenAge(a.items[0]!, b.items[0]!);
      return b.worstUrgency - a.worstUrgency || lead || a.region.label.localeCompare(b.region.label);
    });

  return {
    version: OPERATOR_FEED_VERSION,
    canvasName,
    generatedAt: nowMs,
    count: items.length,
    sections: ordered,
  };
};
