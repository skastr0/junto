import type { CanvasDoc, CanvasNode } from "./canvas";
import type { AgentSignal } from "./agent-signals";
import { regionStack } from "./graph";
import {
  THREAD_HEALTH_LABEL,
  THREAD_HEALTH_TONE,
  THREAD_HEALTH_TTL_MS,
  type ThreadHealthReading,
} from "./thread-health";
import {
  FEED_URGENCY,
  OPERATOR_FEED_VERSION,
  type FeedHealth,
  type FeedItem,
  type FeedRegion,
  type FeedSeat,
  type OperatorFeed,
} from "./wire/operator-feed";

/**
 * The operator feed builders: the desktop's live planes joined onto a canvas
 * and projected into the wire shapes (effect-only, shared with the phone
 * companion), which are re-exported here.
 */
export * from "./wire/operator-feed";

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
  return {
    regionId: inner.id,
    label: labelOf(inner),
    path: stack.map(labelOf),
    ...(inner.color ? { color: inner.color } : {}),
  };
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
