import { useEffect, useMemo, useState } from "react";
import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import type { Canvas, Node } from "@shared/model";
import type { AgentSignal } from "@shared/agent-signals";
import { feedCanvasModelNeeds } from "@shared/canvas-needs";
import { executionGraphContextFromActorRefs } from "@shared/graph";
import { asNodeId } from "@shared/physics/schema";
import { automationsSource } from "./automations-source";
import { canvasTasks$, seatTasks$ } from "./seat-tasks";
import type { TaskView } from "@shared/task-model";
import {
  NO_FEED_FILTER,
  OPEN_FIELD,
  buildOperatorFeed,
  feedSeatsFromCanvas,
  feedSourcesFromCanvas,
  filterFeedSections,
  needsOperatorCount,
  orderFeedSections,
  type FeedCanvasNeed,
  type FeedFilter,
  type FeedItem,
  type FeedItemKind,
  type FeedMailWait,
  type FeedRegion,
  type FeedSection,
  type FeedSortOrder,
  type OperatorFeed,
} from "@shared/operator-feed";
import type { ThreadHealthReading } from "@shared/thread-health";
import { deriveNeeds, type SeatSnapshot } from "@shared/harness-domain";
import { agentSeatStatusOf, type AgentSeatStateEvent } from "@shared/agent-seat-state";
import { Level } from "@shared/wire/urgency";
import { agentSeat$, seatEventForBinding, seatStatusForBinding } from "./agent-seat-state";
import { agentSignals$ } from "./agent-signals-state";
import { executionGraphForImpact } from "./impact-mode";
import { kernel$ } from "./kernel-view";
import { mailWaiting$, mailWaitsOn } from "./mail-waiting";
import { phoneReach$, withPhoneReach } from "./phone-reach";
import { seatAwareness$ } from "./seat-awareness";
import { state$ } from "./state";
import { threadHealthView, useHealthClock } from "./thread-health";
import { useCanvas } from "./use-model";

/**
 * The desktop's reading of the operator feed: joins the live planes (declared
 * signals, seat control state and status, thread health) onto the canvas and hands
 * them to the shared projection, with the needs only the canvas knows
 * (`feedCanvasNeeds`: stoppages, held nodes, sinks wanting input), and this
 * Mac's own (lib/phone-reach). Whether the feed is open is
 * the operator modal slot's to say (lib/operator-modal).
 */

/** Build the feed for one canvas from the live stores, read once at `nowMs`. */
export const operatorFeedFor = (
  canvasName: string,
  canvas: Canvas,
  signals: ReadonlyArray<AgentSignal>,
  nowMs: number,
  needs: ReadonlyArray<FeedCanvasNeed> = [],
  mailWaitByNodeId?: ReadonlyMap<string, FeedMailWait>,
  automationNamesByNodeId?: ReadonlyMap<string, ReadonlyMap<string, string>>,
): OperatorFeed => {
  const attentionByNodeId = new Map<string, { readonly reason: string; readonly at: number }>();
  const snapshotByNodeId = new Map<string, SeatSnapshot>();
  const healthByNodeId = new Map<string, { readonly reading: ThreadHealthReading; readonly fresh: boolean }>();
  for (const node of canvas.nodes.values()) {
    if (node.kind !== "agent") continue;
    const event = seatEventForBinding(node.bindingId);
    if (event?.state === "attention") attentionByNodeId.set(node.id, { reason: event.reason, at: event.at });
    const status = seatStatusForBinding(node.bindingId);
    if (status) snapshotByNodeId.set(node.id, status.snapshot);
    const view = threadHealthView(node.bindingId, nowMs);
    if (view) healthByNodeId.set(node.id, { reading: view.reading, fresh: view.freshness === "current" });
  }
  return buildOperatorFeed({
    canvasName,
    nowMs,
    seats: feedSeatsFromCanvas(canvas, {
      attentionByNodeId,
      snapshotByNodeId,
      healthByNodeId,
      ...(mailWaitByNodeId ? { mailWaitByNodeId } : {}),
    }),
    signals,
    canvasNeeds: needs,
    sources: feedSourcesFromCanvas(canvas, automationNamesByNodeId),
  });
};

/**
 * Nodes that want input for a reason the canvas does not carry, and when
 * it began: a terminal that is not an agent seat whose screen wants input
 * (its seat event's time, which main stamps).
 */
const liveWantsInput = (nodes: Iterable<Node>): ReadonlyMap<string, number | undefined> => {
  const out = new Map<string, number | undefined>();
  for (const node of nodes) {
    // Agent seats in attention are the feed's own items already.
    if (node.kind === "agent") continue;
    const bindingId = node.kind === "terminal" ? node.bindingId : agentSeat$.bindingIdByNodeId[node.id].peek();
    const event = seatEventForBinding(bindingId);
    if (event?.state === "attention") out.set(node.id, event.at);
  }
  return out;
};

const NO_TASKS: ReadonlyArray<TaskView> = [];

const NO_NAMES: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map();

const sameNames = (
  a: ReadonlyMap<string, ReadonlyMap<string, string>>,
  b: ReadonlyMap<string, ReadonlyMap<string, string>>,
): boolean => {
  if (a.size !== b.size) return false;
  for (const [nodeId, names] of a) {
    const other = b.get(nodeId);
    if (other === undefined || other.size !== names.size) return false;
    for (const [id, name] of names) if (other.get(id) !== name) return false;
  }
  return true;
};

/**
 * The automations each Automations node holds, by id and name, for the nodes
 * that raised a signal: the feed names an automation's signal by the
 * automation, not by the node it lives on (0.11/09). One list read per such
 * node, kept current with the editor's own source; a read that fails leaves
 * the node's title standing.
 */
const useAutomationNames = (
  canvasName: string,
  nodeIds: ReadonlyArray<string>,
): ReadonlyMap<string, ReadonlyMap<string, string>> => {
  const [names, setNames] = useState(NO_NAMES);
  const key = nodeIds.join("|");
  useEffect(() => {
    const ids = key === "" ? [] : key.split("|");
    if (ids.length === 0) {
      setNames(NO_NAMES);
      return;
    }
    let live = true;
    const read = (): void => {
      Promise.all(
        ids.map((nodeId) =>
          automationsSource()
            .list(canvasName, asNodeId(nodeId))
            .then(
              (listed) =>
                [nodeId, new Map(listed.automations.map((automation) => [String(automation.automationId), automation.name]))] as const,
              () => undefined,
            ),
        ),
      ).then(
        (entries) => {
          if (!live) return;
          const next = new Map<string, ReadonlyMap<string, string>>();
          for (const entry of entries) if (entry !== undefined) next.set(entry[0], entry[1]);
          setNames((current) => (sameNames(current, next) ? current : next));
        },
        () => undefined,
      );
    };
    read();
    const stop = automationsSource().subscribe(read);
    return () => {
      live = false;
      stop();
    };
  }, [canvasName, key]);
  return names;
};

/**
 * One result for every reader of the same inputs. The needs-you button, the
 * desktop notifications and the open feed each built the same feed from the
 * same stores on every seat change: three passes over every seat and the
 * execution graph where one does (0.11.10 trace, the feed open under cmd+K:
 * 532 ms in 30 s, 384 of them the feed's own copy). Inputs compare by
 * identity, as useMemo's do, and every input a result reads is in its list.
 */
const sharedResult = <T,>(): ((inputs: ReadonlyArray<unknown>, compute: () => T) => T) => {
  let last: { readonly inputs: ReadonlyArray<unknown>; readonly value: T } | undefined;
  return (inputs, compute) => {
    if (last !== undefined && last.inputs.length === inputs.length && last.inputs.every((input, index) => Object.is(input, inputs[index]))) {
      return last.value;
    }
    const value = compute();
    last = { inputs, value };
    return value;
  };
};
const sharedNeeds = sharedResult<ReadonlyArray<FeedCanvasNeed>>();
const sharedFeed = sharedResult<OperatorFeed>();

// --- live-seat signatures ----------------------------------------------------
//
// A seat report bumps agentSeat$.rev once per event, and every feed reader
// used to rebuild its whole projection on each bump: on the factory board
// that was the feed's pass over all 207 seats plus a React render of every
// subscriber, ten times a second, for reports that changed nothing the feed
// can draw (a working/idle flip carries no attention, no stopped need and no
// health reading). The signatures below name exactly what the feed and the
// canvas needs read from the seat stores; a report that leaves them equal
// re-renders nobody.
//
// Per-seat parts are cached on the objects that carry them: an event object
// lives until its seat reports again, a snapshot until its event is replaced,
// so a report pays for one seat's share and the rest hit caches.

/** The status slice feedStopOf reads, as a string; equal strings stop alike. */
const stoppedStatusSig = (status: SeatSnapshot["status"]): string => {
  if (status._tag === "Blocked") {
    const reason = status.reason;
    if (reason._tag === "UsageLimit") return `U${reason.resetsAt ?? ""}`;
    if (reason._tag === "Error") return `E${reason.kind}|${reason.message ?? ""}`;
    return `B${reason._tag}`;
  }
  if (status._tag === "Exited") return `X${status.signal ?? ""}|${status.code ?? ""}`;
  return status._tag;
};

/** The stopped item a snapshot would raise, cached per snapshot object. */
const stoppedSigs = new WeakMap<SeatSnapshot, string>();
const stoppedSigOf = (snapshot: SeatSnapshot): string => {
  const held = stoppedSigs.get(snapshot);
  if (held !== undefined) return held;
  const need = deriveNeeds(snapshot).find((entry) => entry.level === Level.stopped);
  const sig = need === undefined ? "" : `s${need.cause}@${need.since}${stoppedStatusSig(snapshot.status)}`;
  stoppedSigs.set(snapshot, sig);
  return sig;
};

/** Attention and stopped-need parts of one seat event, cached per event object. */
const eventSigs = new WeakMap<AgentSeatStateEvent, string>();
const eventSigOf = (event: AgentSeatStateEvent | undefined): string => {
  if (event === undefined) return "";
  const held = eventSigs.get(event);
  if (held !== undefined) return held;
  const status = agentSeatStatusOf(event);
  const sig = `${event.state === "attention" ? `a${event.reason}@${event.at}` : ""}${status === undefined ? "" : stoppedSigOf(status.snapshot)}`;
  eventSigs.set(event, sig);
  return sig;
};

/**
 * The feed's seat signature: per agent node, its attention mark, the stopped
 * need its snapshot would raise and the health reading with the freshness
 * inputs threadHealthView weighs. Read inside a use$ selector so every store
 * read is tracked; equal signatures mean an identical feed.
 */
const feedSeatSig = (canvas: Canvas): string => {
  const events = agentSeat$.byBindingId.get();
  const assessments = seatAwareness$.byBindingId.get();
  const digests = seatAwareness$.windowDigestByBindingId.get();
  const parts: string[] = [];
  for (const node of canvas.nodes.values()) {
    if (node.kind !== "agent" || node.bindingId === undefined) continue;
    const part = `${node.id}=${eventSigOf(events[node.bindingId])}`;
    const assessment = assessments[node.bindingId];
    const reading = assessment?.health;
    if (assessment !== undefined && reading !== undefined) {
      parts.push(`${part}h${reading.value}|${reading.confidence}|${reading.observedAt}|${assessment.evidence.digest}|${digests[node.bindingId] ?? ""}`);
    } else {
      parts.push(part);
    }
  }
  return parts.join("|");
};

/**
 * The canvas needs' seat signature: attention marks on the nodes that are
 * not agent seats, which is all liveWantsInput reads. Agent reports do not
 * touch it, so a seat storm leaves the needs projection asleep.
 */
const feedWantsSig = (canvas: Canvas): string => {
  const events = agentSeat$.byBindingId.get();
  const binds = agentSeat$.bindingIdByNodeId.get();
  const parts: string[] = [];
  for (const node of canvas.nodes.values()) {
    if (node.kind === "agent") continue;
    const bindingId = node.kind === "terminal" ? node.bindingId : binds[node.id];
    const event = bindingId === undefined ? undefined : events[bindingId];
    if (event?.state === "attention") parts.push(`${node.id}:${event.reason}@${event.at}`);
  }
  return parts.join("|");
};

/** The open canvas's needs that no seat declared, read from the live stores. */
const useCanvasNeeds = (): ReadonlyArray<FeedCanvasNeed> => {
  const canvasName = use$(state$.canvasName);
  const canvas = useCanvas(canvasName);
  const byNode = use$(canvasTasks$.byNode);
  const heldBy = use$(seatTasks$.bySeat);
  const actorRefs = use$(state$.actorRefs);
  const execution = use$(kernel$.execution);
  const executionRev = use$(kernel$.executionRev);
  const wantsSig = use$(() => feedWantsSig(canvas));
  return useMemo(
    () =>
      // Kernel execution and seat state mutate in place; their revs carry the change.
      sharedNeeds([canvas, canvasName, actorRefs, execution, executionRev, wantsSig, byNode, heldBy], () => {
        const context = executionGraphContextFromActorRefs(
          canvasName,
          actorRefs,
          heldBy,
        );
        return feedCanvasModelNeeds({
          canvasName,
          canvas,
          itemsOf: (nodeId: string) => byNode[nodeId] ?? NO_TASKS,
          graph: executionGraphForImpact(canvas, execution, context),
          wantsInput: liveWantsInput(canvas.nodes.values()),
        });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canvas, canvasName, actorRefs, execution, executionRev, wantsSig, byNode, heldBy],
  );
};

/** The live feed for the open canvas. */
export const useOperatorFeed = (): OperatorFeed => {
  const canvasName = use$(state$.canvasName);
  const canvas = useCanvas(canvasName);
  // The store mutates in place, so its identity never moves; key the list on
  // what can change about a signal (it arrives, then closes) and rebuild it
  // only then, not on every render.
  const signalsKey = use$(() =>
    Object.values(agentSignals$.get())
      .map((signal) => `${signal.signalId}:${signal.state}`)
      .join("|"),
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const signals = useMemo(() => Object.values(agentSignals$.peek()), [signalsKey]);
  const seatSig = use$(() => feedSeatSig(canvas));
  const needs = useCanvasNeeds();
  const now = useHealthClock();
  // By field: the store mutates in place.
  const paired = use$(phoneReach$.paired);
  const remoteLogin = use$(phoneReach$.remoteLogin);
  // Held mail, by node. The store mutates in place too: key it on what it says.
  const waitsKey = use$(() => JSON.stringify(mailWaiting$[canvasName].get() ?? {}));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const waits = useMemo(() => mailWaitsOn(mailWaiting$.peek(), canvasName), [waitsKey, canvasName]);
  // The Automations nodes that raised an open signal: their automations name
  // the cards. Only those nodes are read, and only while a signal waits.
  const signallingNodes = useMemo(() => {
    const ids = new Set<string>();
    for (const signal of signals) {
      if (signal.state === "open" && signal.source?.kind === "automation") ids.add(signal.source.nodeId);
    }
    return [...ids].sort();
  }, [signals]);
  const automationNames = useAutomationNames(canvasName, signallingNodes);
  const namesKey = useMemo(
    () => [...automationNames].map(([nodeId, names]) => `${nodeId}=${[...names].map(([id, name]) => `${id}:${name}`).join(",")}`).join("|"),
    [automationNames],
  );
  return useMemo(
    () =>
      // Signals, waits and automation names are keyed by what they say: each
      // reader holds its own copy of the same list. Seat and awareness stores
      // mutate in place; their revs carry the change.
      sharedFeed([canvasName, canvas, signalsKey, needs, seatSig, now, paired, remoteLogin, waitsKey, namesKey], () =>
        withPhoneReach(operatorFeedFor(canvasName, canvas, signals, now, needs, waits, automationNames), { paired, remoteLogin }),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canvasName, canvas, signals, needs, seatSig, now, paired, remoteLogin, waits, automationNames],
  );
};

/** Items in reading order, for list movement (lib/list-nav). */
export const feedItemsInOrder = (sections: ReadonlyArray<FeedSection>): ReadonlyArray<FeedItem> =>
  sections.flatMap((section) => section.items);

/**
 * Keep a selection through a feed change. When the selected item leaves
 * (answered here, answered elsewhere, dismissed, withdrawn) the selection
 * moves to its nearest neighbour that is still there, next first.
 */
export const reconcileSelection = (
  previous: ReadonlyArray<Pick<FeedItem, "itemId">>,
  current: ReadonlyArray<Pick<FeedItem, "itemId">>,
  selected: string | null,
): string | null => {
  if (selected === null) return null;
  const live = new Set(current.map((item) => item.itemId));
  if (live.has(selected)) return selected;
  const index = previous.findIndex((item) => item.itemId === selected);
  if (index === -1) return null;
  const after = previous.slice(index + 1).find((item) => live.has(item.itemId));
  if (after) return after.itemId;
  const before = previous.slice(0, index).reverse().find((item) => live.has(item.itemId));
  return before?.itemId ?? null;
};

/**
 * "3 waiting across 2 regions": the feed's status line. The number is the
 * feed's own count, the same one the top bar and the Dock badge show. With a
 * region filter on, it says what is left in view against the whole feed.
 */
export const feedStatusLine = (
  feed: Pick<OperatorFeed, "count" | "sections">,
  filtered?: { readonly label: string; readonly count: number },
  /**
   * What the operator's own narrowing shows, in rows, when a filter is on. The
   * pair counts the list rather than needs, so a reading the kind chips can
   * narrow to is counted like the card it is: the chips count rows too.
   */
  shown?: { readonly count: number; readonly total: number },
): string => {
  // A region alone counts needs, as its chips do; a filter counts rows, as its chips do.
  if (shown !== undefined) {
    return filtered === undefined ? `${shown.count} of ${shown.total} shown` : `${shown.count} of ${shown.total} shown in ${filtered.label}`;
  }
  if (filtered !== undefined) {
    return `${filtered.count} of ${feed.count} waiting in ${filtered.label}`;
  }
  if (feed.count === 0) return "nobody needs you right now";
  const regions = feed.sections.filter((section) => needsOperatorCount(section.items) > 0).length;
  return `${feed.count} waiting${regions > 1 ? ` across ${regions} regions` : ""}`;
};

// --- view state -------------------------------------------------------------

/**
 * The region the operator narrowed the feed to, named as the phone names it:
 * by its canvas and its path, outer to inner, itself last. The empty path is
 * the open field. A parent takes in its children: their paths start with its
 * own. The pick is ignored on another canvas.
 */
export type FeedRegionPick = {
  readonly canvasName: string;
  readonly path: ReadonlyArray<string>;
};

/** One key per pick on a canvas; the open field is the empty path. */
export const regionPickKey = (path: ReadonlyArray<string>): string => path.join("\u0000");

/** Whether a region falls under a picked path: itself or a child. The open field matches only itself. */
export const regionMatches = (path: ReadonlyArray<string>, region: Pick<FeedRegion, "path">): boolean =>
  path.length === 0
    ? region.path.length === 0
    : path.length <= region.path.length && path.every((label, index) => region.path[index] === label);

/** What a pick is called in a sentence: its own name, or the open field. */
export const regionPickName = (path: ReadonlyArray<string>): string => path.at(-1) ?? "the open field";

/**
 * A region as a filter chip (mirrors the phone's regionChips): its own name,
 * the regions around it, its colour when the feed carries one, and how many
 * needs wait on the operator in it and its children.
 */
export type FeedRegionChip = {
  readonly key: string;
  readonly path: ReadonlyArray<string>;
  readonly label: string;
  /** Containing regions, outer to inner. */
  readonly outer: ReadonlyArray<string>;
  /** The region's own colour; a parent known only from a child's path has none. */
  readonly color: string | undefined;
  readonly open: boolean;
  /** Needs waiting on the operator here and in its children; AI readings are listed, not counted. */
  readonly count: number;
};

/**
 * The strip's chips: every region a need sits in and every region that
 * contains one, in the order the sections give them, a parent just before its
 * first child. A pick with nothing left in it stays, at the end, so the strip
 * still says what is chosen.
 */
export const feedRegionChips = (
  sections: ReadonlyArray<FeedSection>,
  pick?: ReadonlyArray<string>,
): ReadonlyArray<FeedRegionChip> => {
  const chips = new Map<string, { path: ReadonlyArray<string>; label: string; color: string | undefined; open: boolean }>();
  for (const { region } of sections) {
    if (region.path.length === 0) {
      if (!chips.has("")) chips.set("", { path: [], label: region.label, color: undefined, open: true });
      continue;
    }
    region.path.forEach((label, index) => {
      const path = region.path.slice(0, index + 1);
      const own = index === region.path.length - 1;
      const known = chips.get(regionPickKey(path));
      if (!known) chips.set(regionPickKey(path), { path, label, color: own ? region.color : undefined, open: false });
      else if (own && known.color === undefined && region.color !== undefined) known.color = region.color;
    });
  }
  if (pick !== undefined && !chips.has(regionPickKey(pick))) {
    chips.set(regionPickKey(pick), { path: pick, label: pick.at(-1) ?? OPEN_FIELD.label, color: undefined, open: pick.length === 0 });
  }
  return [...chips.entries()].map(([key, chip]) => ({
    key,
    path: chip.path,
    label: chip.label,
    outer: chip.path.slice(0, -1),
    color: chip.color,
    open: chip.open,
    count: needsOperatorCount(sections.filter((section) => regionMatches(chip.path, section.region)).flatMap((section) => section.items)),
  }));
};

/**
 * The feed's view: which region is showing, what the operator narrowed it to,
 * and in what order. Session-lived and module-scoped so it survives the modal
 * opening and closing — triage spans more than one look — without pretending to
 * be a preference.
 */
export const feedView$ = observable<{
  region: FeedRegionPick | undefined;
  order: FeedSortOrder;
  /** Words to find in a need's sentence or its detail; empty finds everything. */
  query: string;
  /** The kinds kept; empty keeps every kind. */
  kinds: ReadonlyArray<FeedItemKind>;
  /** The one seat kept, by node id; undefined keeps every seat. */
  seat: string | undefined;
  /**
   * Whether the seat chips are unfolded. Folded by default: one row per seat
   * made the bar grow to five lines on a busy canvas. A seat picked while
   * folded still shows in the bar, so a filter is never invisible.
   */
  seatsOpen: boolean;
}>({ region: undefined, order: "urgency", query: "", kinds: [], seat: undefined, seatsOpen: false });

/** The filter the view's three narrowing fields say. */
export const feedFilterOf = (view: {
  readonly query: string;
  readonly kinds: ReadonlyArray<FeedItemKind>;
  readonly seat: string | undefined;
}): FeedFilter => ({ query: view.query, kinds: view.kinds, seats: view.seat === undefined ? [] : [view.seat] });

/** A chip's press: the kind joins the filter, or leaves it. */
export const toggleFeedKind = (kind: FeedItemKind): void => {
  const held = feedView$.kinds.peek();
  feedView$.kinds.set(held.includes(kind) ? held.filter((one) => one !== kind) : [...held, kind]);
};

/**
 * A chip's press: the seat becomes the one kept, or leaves when it already
 * is. One seat at a time, like the region pick: a second pick replaces the
 * first rather than narrowing to nothing.
 */
export const toggleFeedSeat = (seatId: string): void => {
  feedView$.seat.set(feedView$.seat.peek() === seatId ? undefined : seatId);
};

/** Clear everything the operator narrowed: the region pick and the three axes. */
export const clearFeedFilters = (): void => {
  feedView$.region.set(undefined);
  feedView$.query.set("");
  feedView$.kinds.set([]);
  feedView$.seat.set(undefined);
};

/**
 * The sections an open feed shows: the picked region's, what the filter keeps
 * of them, in the picked order.
 */
export const viewFeedSections = (
  sections: ReadonlyArray<FeedSection>,
  pick: FeedRegionPick | undefined,
  canvasName: string,
  order: FeedSortOrder,
  filter: FeedFilter = NO_FEED_FILTER,
): ReadonlyArray<FeedSection> =>
  orderFeedSections(
    filterFeedSections(
      pick?.canvasName === canvasName ? sections.filter((section) => regionMatches(pick.path, section.region)) : sections,
      filter,
    ),
    order,
  );

/** A section as the open feed draws it, with the items fading out of it. */
export type ShownFeedSection = FeedSection & { readonly leavingIds: ReadonlySet<string> };

const regionKey = (section: Pick<FeedSection, "region">): string => section.region.regionId ?? "";

/**
 * `kept` in its own order, with each entry of `ranked` it lacks put where the
 * ranking puts it: just before the first entry ranked after it that is
 * already placed, or last.
 */
const holdOrder = <T>(kept: ReadonlyArray<T>, ranked: ReadonlyArray<T>, keyOf: (entry: T) => string): T[] => {
  const out = [...kept];
  const placed = new Set(out.map(keyOf));
  let after: string | undefined;
  // From the end, so new neighbours keep their ranked order between them.
  for (let index = ranked.length - 1; index >= 0; index -= 1) {
    const entry = ranked[index]!;
    const key = keyOf(entry);
    if (!placed.has(key)) {
      const at = after === undefined ? -1 : out.findIndex((placedEntry) => keyOf(placedEntry) === after);
      out.splice(at === -1 ? out.length : at, 0, entry);
      placed.add(key);
    }
    after = key;
  }
  return out;
};

/**
 * What an open feed draws after a change: `ranked` held in the order the
 * operator already sees in `shown`. A region or a card keeps its place, one
 * that is new goes where the ranking puts it, and a card in `leaving` that
 * is gone from `ranked` stays where it was, marked, so it can fade out
 * there; its region stays with it. Pure; the surface owns the timing.
 */
export const holdFeedPlaces = (
  shown: ReadonlyArray<ShownFeedSection>,
  ranked: ReadonlyArray<FeedSection>,
  leaving: ReadonlySet<string>,
): ReadonlyArray<ShownFeedSection> => {
  const live = new Set(feedItemsInOrder(ranked).map((item) => item.itemId));
  const rankedByRegion = new Map(ranked.map((section) => [regionKey(section), section] as const));
  const held = shown.flatMap((section): ShownFeedSection[] => {
    const now = rankedByRegion.get(regionKey(section));
    const nowById = new Map(now?.items.map((item) => [item.itemId, item] as const));
    const leavingIds = new Set<string>();
    const kept = section.items.flatMap((item): FeedItem[] => {
      const current = nowById.get(item.itemId);
      if (current) return [current];
      // Moved to another region: it is drawn there, not faded out here.
      if (live.has(item.itemId) || !leaving.has(item.itemId)) return [];
      leavingIds.add(item.itemId);
      return [item];
    });
    const items = holdOrder(kept, now?.items ?? [], (item) => item.itemId);
    return items.length === 0 ? [] : [{ ...(now ?? section), items, leavingIds }];
  });
  const fresh = ranked.map((section): ShownFeedSection => ({ ...section, items: [...section.items], leavingIds: new Set() }));
  return holdOrder(held, fresh, regionKey);
};
