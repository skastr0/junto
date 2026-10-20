import { asNodeId, inPaintOrder, regionStack as modelRegionStack, regionName, type Canvas, type Node } from "./model";
import { titleOf } from "./model/title";
import type { AgentSignal } from "./agent-signals";
import { deriveNeeds, type SeatSnapshot } from "./harness-domain";
import type { MailHold } from "./mail-hold";
import { seatStatusTime } from "./seat-status-text";
import {
  THREAD_HEALTH_LABEL,
  THREAD_HEALTH_TONE,
  THREAD_HEALTH_TTL_MS,
  type ThreadHealthReading,
} from "./thread-health";
import { Level } from "./wire/urgency";
import {
  feedItemRank,
  needsOperatorCount,
  OPERATOR_FEED_VERSION,
  type FeedHealth,
  type FeedItem,
  type FeedRegion,
  type FeedSeat,
  type FeedSection,
  type OperatorFeed,
} from "./wire/operator-feed";

/**
 * The operator feed builders: the desktop's live planes joined onto a canvas
 * and projected into the wire shapes (effect-only, shared with the phone
 * companion), which are re-exported here.
 */
export * from "./wire/operator-feed";

// --- inputs -----------------------------------------------------------------

/** A seat as the feed needs it, already resolved from the native canvas. */
export type FeedSeatInput = {
  readonly seat: FeedSeat;
  readonly region: FeedRegion;
  /** Proven control state: the seat's screen wants input. */
  readonly attention?: { readonly reason: string; readonly at: number };
  /** The seat's harness status, folded; the feed lists it when it stopped. */
  readonly snapshot?: SeatSnapshot;
  readonly health?: ThreadHealthReading;
  /**
   * Freshness judged by the producer (the desktop compares screen digests).
   * Absent, the reading is fresh while inside THREAD_HEALTH_TTL_MS.
   */
  readonly healthFresh?: boolean;
  /** Delivery has held this seat's mail past its bound; the feed lists it until the mail is typed. */
  readonly mailWait?: FeedMailWait;
};

/**
 * Mail that delivery has held for one seat for long enough to tell the
 * operator: how many, since when, and why the seat's box would not take it.
 */
export type FeedMailWait = {
  readonly count: number;
  /** Epoch ms the longest-held of them first waited. */
  readonly heldSince: number;
  readonly hold: MailHold;
};

/**
 * A need only the canvas knows: a node that holds others up, a node held up
 * by its work, a sink or seat that wants input. The node need not be a seat.
 */
export type FeedCanvasNeed = {
  readonly itemId: string;
  readonly kind: "blocked" | "attention";
  readonly seat: FeedSeat;
  readonly region: FeedRegion;
  readonly text: string;
  /** Epoch ms the need began; absent when that is not known. */
  readonly since?: number;
};

export type OperatorFeedInput = {
  readonly canvasName: string;
  readonly nowMs: number;
  readonly seats: ReadonlyArray<FeedSeatInput>;
  readonly signals: ReadonlyArray<AgentSignal>;
  readonly canvasNeeds?: ReadonlyArray<FeedCanvasNeed>;
};

export const OPEN_FIELD: FeedRegion = { regionId: null, label: "open field", path: [] };

/** Region and seats read directly from the kind model. */
export const feedRegionForCanvas = (canvas: Canvas, nodeId: string): FeedRegion => {
  const stack = modelRegionStack(canvas, asNodeId(nodeId));
  const inner = stack[stack.length - 1];
  return inner ? { regionId: inner.id, label: regionName(inner), path: stack.map(regionName), ...(inner.color ? { color: inner.color } : {}) } : OPEN_FIELD;
};

export const feedSeatsFromCanvas = (canvas: Canvas, options: {
  readonly nameOf?: (node: Node) => string;
  readonly attentionByNodeId?: ReadonlyMap<string, { readonly reason: string; readonly at: number }>;
  readonly snapshotByNodeId?: ReadonlyMap<string, SeatSnapshot>;
  readonly healthByNodeId?: ReadonlyMap<string, { readonly reading: ThreadHealthReading; readonly fresh?: boolean }>;
  readonly mailWaitByNodeId?: ReadonlyMap<string, FeedMailWait>;
} = {}): ReadonlyArray<FeedSeatInput> => inPaintOrder(canvas).filter((node) => node.kind === "agent").map((node) => {
  const attention = options.attentionByNodeId?.get(node.id);
  const snapshot = options.snapshotByNodeId?.get(node.id);
  const health = options.healthByNodeId?.get(node.id);
  const mailWait = options.mailWaitByNodeId?.get(node.id);
  return { seat: { nodeId: node.id, name: (options.nameOf ?? titleOf)(node), portraitIdentity: node.id, harness: node.harness }, region: feedRegionForCanvas(canvas, node.id), ...(attention ? { attention } : {}), ...(snapshot ? { snapshot } : {}), ...(health ? { health: health.reading } : {}), ...(health?.fresh !== undefined ? { healthFresh: health.fresh } : {}), ...(mailWait && mailWait.count > 0 ? { mailWait } : {}) };
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

/** Why the seat's box would not take its mail, after "the box" or the seat. */
const MAIL_WAIT_REASON = {
  draft: "the box reads as your draft",
  dialog: "the seat is showing a dialog",
  unreadable: "the box cannot be read",
  busy: "the seat is busy starting, compacting or retrying",
  stopped: "the seat has stopped",
  unsupported: "the seat's harness cannot take mail right now",
} as const satisfies Record<MailHold, string>;

/** "45 min", "2 h", "3 d": how long, rounded down, never less than a minute. */
const waitedFor = (ms: number): string => {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${String(hours)} h` : `${String(Math.floor(hours / 24))} d`;
};

/** A hold this build has words for; a newer main's reason is left out, never shown as text. */
export const knownMailHold = (hold: string): hold is MailHold => Object.hasOwn(MAIL_WAIT_REASON, hold);

const MAIL_WAITING_ITEM_PREFIX = "mail-waiting:";

/** Held mail's feed item: shown with a jump to the seat, never answered, dismissed or notified. */
export const isMailWaitingItem = (item: { readonly itemId: string }): boolean =>
  item.itemId.startsWith(MAIL_WAITING_ITEM_PREFIX);

/** "3 mails have waited 2 h: the box reads as your draft". */
export const mailWaitText = (wait: FeedMailWait, nowMs: number): string =>
  `${wait.count === 1 ? "1 mail has" : `${String(wait.count)} mails have`} waited ${waitedFor(nowMs - wait.heldSince)}: ${MAIL_WAIT_REASON[wait.hold]}`;

/**
 * The seat's stop, when one of its needs reads stopped on the feed: a usage
 * limit nothing wakes, a sign-in error, a crash, an unexpected exit. The
 * sentence says what stopped it; the harness's own words go in the detail.
 */
export const feedStopOf = (
  snapshot: SeatSnapshot,
  nowMs: number,
): { readonly text: string; readonly detail?: string; readonly since: number } | undefined => {
  const need = deriveNeeds(snapshot).find((entry) => entry.level === Level.stopped);
  if (!need) return undefined;
  const { status } = snapshot;
  if (status._tag === "Blocked" && status.reason._tag === "UsageLimit") {
    const resets = status.reason.resetsAt;
    return { text: `hit a usage limit${resets === undefined ? "" : `, resets ${seatStatusTime(resets, nowMs)}`}`, since: need.since };
  }
  if (status._tag === "Blocked" && status.reason._tag === "Error") {
    const text = status.reason.kind === "auth" ? "stopped on a sign-in error" : "stopped on an error";
    return { text, ...(status.reason.message ? { detail: status.reason.message } : {}), since: need.since };
  }
  if (status._tag === "Exited") {
    const how = status.signal !== undefined ? `Killed by ${status.signal}.` : status.code !== undefined ? `Exit code ${status.code}.` : undefined;
    return { text: "exited unexpectedly", ...(how ? { detail: how } : {}), since: need.since };
  }
  return { text: "stopped", since: need.since };
};

/** Most urgent first, then oldest first; a need with no known time follows the dated ones. */
const byUrgencyThenAge = (a: FeedItem, b: FeedItem): number =>
  b.urgency - a.urgency ||
  (a.since ?? Number.POSITIVE_INFINITY) - (b.since ?? Number.POSITIVE_INFINITY) ||
  a.itemId.localeCompare(b.itemId);

// --- view -------------------------------------------------------------------

/**
 * How a surface may order the feed: the declared order (urgency, then age),
 * or plain recency. A need with no known time always follows the dated ones:
 * no time is ever made up for it.
 */
export const FEED_SORT_ORDERS = ["urgency", "newest", "oldest"] as const;
export type FeedSortOrder = (typeof FEED_SORT_ORDERS)[number];

const FEED_ITEM_ORDER: Readonly<Record<FeedSortOrder, (a: FeedItem, b: FeedItem) => number>> = {
  urgency: byUrgencyThenAge,
  newest: (a, b) =>
    (b.since ?? Number.NEGATIVE_INFINITY) - (a.since ?? Number.NEGATIVE_INFINITY) ||
    byUrgencyThenAge(a, b),
  oldest: (a, b) =>
    (a.since ?? Number.POSITIVE_INFINITY) - (b.since ?? Number.POSITIVE_INFINITY) ||
    byUrgencyThenAge(a, b),
};

/**
 * Re-sort a feed's sections for the chosen order: each section's items, then
 * the sections by their lead item. `urgency` reproduces the projection's own
 * order.
 */
export const orderFeedSections = (
  sections: ReadonlyArray<FeedSection>,
  order: FeedSortOrder,
): ReadonlyArray<FeedSection> => {
  const byItem = FEED_ITEM_ORDER[order];
  return [...sections]
    .map((section) => ({ ...section, items: [...section.items].sort(byItem) }))
    .sort(
      (a, b) =>
        (a.items[0] !== undefined && b.items[0] !== undefined ? byItem(a.items[0], b.items[0]) : 0) ||
        a.region.label.localeCompare(b.region.label),
    );
};

/**
 * Keep only the one region the operator is looking at — `null` picks the open
 * field, `undefined` keeps every region.
 */
export const feedSectionsInRegion = (
  sections: ReadonlyArray<FeedSection>,
  regionId: string | null | undefined,
): ReadonlyArray<FeedSection> =>
  regionId === undefined ? sections : sections.filter((section) => section.region.regionId === regionId);

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
      urgency: feedItemRank(item.kind),
      canvasName,
      seat: entry.seat,
      region: entry.region,
      ...(item.since === undefined ? {} : { ageMs: Math.max(0, nowMs - item.since) }),
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
      ...(signal.attachments?.length ? { attachments: signal.attachments } : {}),
      ...(signal.suggestions?.length ? { suggestions: signal.suggestions } : {}),
      since: signal.createdAt,
      signalId: signal.signalId,
      signalKind: signal.kind,
    });
  }

  for (const entry of input.seats) {
    if (!entry.attention) continue;
    // One row per seat: the id holds while the seat asks again, so the row
    // stays put instead of leaving and coming back.
    push(entry, {
      itemId: `attention:${entry.seat.nodeId}`,
      kind: "attention",
      text: attentionText(entry.attention.reason),
      since: entry.attention.at,
    });
  }

  for (const entry of input.seats) {
    const stop = entry.snapshot && feedStopOf(entry.snapshot, nowMs);
    if (!stop) continue;
    push(entry, {
      itemId: `stopped:${entry.seat.nodeId}`,
      kind: "stopped",
      text: stop.text,
      ...(stop.detail ? { detail: stop.detail } : {}),
      since: stop.since,
    });
  }

  // Not a signal and nothing to answer: the seat is the place to act.
  for (const entry of input.seats) {
    const wait = entry.mailWait;
    // The fact crosses IPC undecoded: a reason this build does not know lists nothing.
    if (!wait || wait.count <= 0 || !knownMailHold(wait.hold)) continue;
    push(entry, {
      itemId: `${MAIL_WAITING_ITEM_PREFIX}${entry.seat.nodeId}`,
      kind: "attention",
      text: mailWaitText(wait, nowMs),
      since: wait.heldSince,
    });
  }

  // The feed carries the agent's own sentence, so a canvas need joins only
  // where nothing listed for that node is already as urgent.
  const worst = new Map<string, number>();
  for (const item of items) worst.set(item.seat.nodeId, Math.max(worst.get(item.seat.nodeId) ?? -1, item.urgency));
  for (const need of input.canvasNeeds ?? []) {
    if ((worst.get(need.seat.nodeId) ?? -1) >= feedItemRank(need.kind)) continue;
    const entry = seatsById.get(need.seat.nodeId) ?? { seat: need.seat, region: need.region };
    push(entry, {
      itemId: need.itemId,
      kind: need.kind,
      text: need.text,
      ...(need.since === undefined ? {} : { since: need.since }),
      canvas: true,
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
      // A section holds at least the item that made it.
      return { region: section.region, items: sorted, worstUrgency: sorted[0]!.urgency };
    })
    .sort((a, b) => {
      const lead = byUrgencyThenAge(a.items[0]!, b.items[0]!);
      return b.worstUrgency - a.worstUrgency || lead || a.region.label.localeCompare(b.region.label);
    });

  return {
    version: OPERATOR_FEED_VERSION,
    canvasName,
    generatedAt: nowMs,
    count: needsOperatorCount(items),
    sections: ordered,
  };
};
