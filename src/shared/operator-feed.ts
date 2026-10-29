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
  FEED_KIND_LABEL,
  feedItemRank,
  needsOperatorCount,
  OPERATOR_FEED_VERSION,
  type FeedHealth,
  type FeedItem,
  type FeedItemKind,
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

/**
 * A node that is no seat but can raise a signal: an Automations node. The feed
 * names it by its own title and region, never as a seat that is gone, and
 * names a signal one of its automations raised by that automation's name.
 */
export type FeedSourceNode = {
  readonly name: string;
  readonly region: FeedRegion;
  /**
   * The automations the node holds, by id, when the producer read them: a
   * signal whose source names one is named by it. Absent, the node's title
   * stands, which is what an older reader and a removed automation deserve.
   */
  readonly automations?: ReadonlyMap<string, string>;
};

export type OperatorFeedInput = {
  readonly canvasName: string;
  readonly nowMs: number;
  readonly seats: ReadonlyArray<FeedSeatInput>;
  readonly signals: ReadonlyArray<AgentSignal>;
  readonly canvasNeeds?: ReadonlyArray<FeedCanvasNeed>;
  /**
   * The non-seat nodes a signal can come from, by id. Without an entry a
   * signal from one still lists, named as a seat that is gone, which is what
   * an older reader and a removed node deserve.
   */
  readonly sources?: ReadonlyMap<string, FeedSourceNode>;
};

export const OPEN_FIELD: FeedRegion = { regionId: null, label: "open field", path: [] };

/** Region and seats read directly from the kind model. */
export const feedRegionForCanvas = (canvas: Canvas, nodeId: string): FeedRegion => {
  const stack = modelRegionStack(canvas, asNodeId(nodeId));
  const inner = stack[stack.length - 1];
  return inner ? { regionId: inner.id, label: regionName(inner), path: stack.map(regionName), ...(inner.color ? { color: inner.color } : {}) } : OPEN_FIELD;
};

/**
 * The non-seat nodes a signal can come from: the Automations node, by its
 * title and region, and the automations it holds when the producer read them.
 */
export const feedSourcesFromCanvas = (
  canvas: Canvas,
  automationsByNodeId?: ReadonlyMap<string, ReadonlyMap<string, string>>,
): ReadonlyMap<string, FeedSourceNode> => {
  const sources = new Map<string, FeedSourceNode>();
  for (const node of canvas.nodes.values()) {
    if (node.kind !== "automations") continue;
    const automations = automationsByNodeId?.get(node.id);
    sources.set(node.id, {
      name: titleOf(node),
      region: feedRegionForCanvas(canvas, node.id),
      ...(automations === undefined ? {} : { automations }),
    });
  }
  return sources;
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
 * What the operator narrowed the feed to, besides a region: words, kinds and
 * seats. An empty list keeps everything of that axis, so clearing one chip
 * clears one axis and the rest stay.
 */
export type FeedFilter = {
  /** Case-insensitive words to find in a need's sentence or its detail. */
  readonly query: string;
  readonly kinds: ReadonlyArray<FeedItemKind>;
  readonly seats: ReadonlyArray<string>;
};

export const NO_FEED_FILTER: FeedFilter = { query: "", kinds: [], seats: [] };

/** Whether the operator narrowed anything: the surface offers to clear it. */
export const feedFilterOn = (filter: FeedFilter): boolean =>
  filter.query.trim() !== "" || filter.kinds.length > 0 || filter.seats.length > 0;

/** A need's words as a search reads them: its one sentence and its detail. */
const feedItemWords = (item: FeedItem): string => `${item.text}\n${item.detail ?? ""}`.toLowerCase();

/** Whether a need passes every axis the operator set; an axis left empty passes all. */
export const feedItemMatches = (item: FeedItem, filter: FeedFilter): boolean => {
  if (filter.kinds.length > 0 && !filter.kinds.includes(item.kind)) return false;
  if (filter.seats.length > 0 && !filter.seats.includes(item.seat.nodeId)) return false;
  const words = filter.query.trim().toLowerCase();
  return words === "" || feedItemWords(item).includes(words);
};

/** The sections a filter leaves: its matching needs, and no section left empty. */
export const filterFeedSections = (
  sections: ReadonlyArray<FeedSection>,
  filter: FeedFilter,
): ReadonlyArray<FeedSection> =>
  feedFilterOn(filter)
    ? sections
        .map((section) => ({ ...section, items: section.items.filter((item) => feedItemMatches(item, filter)) }))
        .filter((section) => section.items.length > 0)
    : sections;

/** The one order every surface says the kinds in, as `FEED_KIND_LABEL` declares them. */
const FEED_KIND_ORDER: ReadonlyArray<FeedItemKind> = [
  "blocked",
  "attention",
  "stopped",
  "escalate",
  "feedback",
  "health",
  "notice",
  "work",
];

/** A kind's words on a chip: the one name every surface gives it, its first letter capitalised. */
export const feedKindChipLabel = (kind: FeedItemKind): string => {
  const label = FEED_KIND_LABEL[kind];
  return label.charAt(0).toUpperCase() + label.slice(1);
};

/** A kind filter chip: its kind, the words every surface gives it, and how many it would show. */
export type FeedKindChip = {
  readonly kind: FeedItemKind;
  readonly label: string;
  /** What pressing it leaves on screen; readings count, because this chip is a view of the list. */
  readonly count: number;
};

/**
 * One chip per kind the feed holds, in the one order every surface says them
 * (`FEED_KIND_LABEL`), so the strip does not move as counts change. The count is
 * what the chip would show, which is why a reading counts here where the region
 * strip counts needs only: this chip filters the list.
 */
export const feedKindChips = (sections: ReadonlyArray<FeedSection>): ReadonlyArray<FeedKindChip> => {
  const counts = new Map<FeedItemKind, number>();
  for (const section of sections) for (const item of section.items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  return FEED_KIND_ORDER.filter((kind) => counts.has(kind)).map((kind) => ({
    kind,
    label: feedKindChipLabel(kind),
    count: counts.get(kind) ?? 0,
  }));
};

/** A seat filter chip: the seat by its name, and how many of its needs it would show. */
export type FeedSeatChip = {
  readonly seatId: string;
  readonly name: string;
  readonly count: number;
};

/**
 * One chip per seat with a need, the busiest first and ties by name, so the
 * strip reads like the list it filters rather than like a roster.
 */
export const feedSeatChips = (sections: ReadonlyArray<FeedSection>): ReadonlyArray<FeedSeatChip> => {
  const chips = new Map<string, FeedSeatChip>();
  for (const section of sections) {
    for (const item of section.items) {
      const known = chips.get(item.seat.nodeId);
      chips.set(item.seat.nodeId, { seatId: item.seat.nodeId, name: item.seat.name, count: (known?.count ?? 0) + 1 });
    }
  }
  return [...chips.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
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
      urgency: feedItemRank(item.kind, item.work, nowMs),
      canvasName,
      seat: entry.seat,
      region: entry.region,
      ...(item.since === undefined ? {} : { ageMs: Math.max(0, nowMs - item.since) }),
      ...(entry.health ? { health: feedHealth(entry, entry.health, nowMs) } : {}),
    });
  };

  for (const signal of input.signals) {
    if (signal.state !== "open" || signal.canvasName !== canvasName) continue;
    const source = input.sources?.get(signal.nodeId);
    // A signal an automation raised is named by the automation, not by the node
    // it lives on; a node whose automations were not read, or an automation
    // since removed, keeps the node's title.
    const automationName =
      signal.source?.kind === "automation" ? source?.automations?.get(signal.source.automationId) : undefined;
    const entry = seatsById.get(signal.nodeId) ?? {
      seat: {
        nodeId: signal.nodeId,
        name: automationName ?? source?.name ?? "removed seat",
        portraitIdentity: signal.nodeId,
      },
      region: source?.region ?? OPEN_FIELD,
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
      ...(signal.source === undefined ? {} : { source: signal.source }),
      ...(signal.work === undefined ? {} : { work: signal.work }),
      ...(signal.form === undefined ? {} : { form: signal.form }),
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
