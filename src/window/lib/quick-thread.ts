/**
 * Quick thread: how a new thread starts. The operator types a seat or a
 * region, picks seats, and writes once; each seat gets its own thread. This
 * file holds what the component is made from: the list the picker ranks,
 * the draft kept between opens, and the open from the canvas.
 *
 * The list is every seat on the canvas, whichever machine it runs on, and
 * the regions that hold any. A region is never a recipient: picking one only
 * narrows the list to its seats.
 *
 * The draft (seats, text, files) is kept per canvas until it is sent, so
 * closing Quick thread loses nothing. Nothing here writes the canvas.
 */
import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import { fuzzyMatch } from "@shared/fuzzy-match";
import { asNodeId, regionName, type Canvas } from "@shared/model";
import { buildFocusSwitcherCatalog } from "./focus-switcher";
import { makeAttachmentHold, type AttachmentHold } from "./operator-attachments";
import { isOperatorModalOpen, toggleOperatorModal } from "./operator-modal";
import { regionTrails } from "./region-path";
import type { HeldThreadDraft } from "./seat-threads";
import { state$ } from "./state";
import { modelStore } from "./use-model";

/** A seat the picker offers. */
export type QuickThreadSeat = {
  readonly kind: "seat";
  readonly id: string;
  readonly name: string;
  /** The region it sits in, innermost; absent outside every region. */
  readonly region?: string;
  /** Its regions outer to inner, as one line ("Junto / Product"); empty outside every region. */
  readonly path: string;
  readonly regionIds: ReadonlyArray<string>;
};

/** A region the picker offers, to narrow the list to its seats. */
export type QuickThreadRegion = {
  readonly kind: "region";
  readonly id: string;
  readonly name: string;
  /** Containing regions, outer to inner. */
  readonly outer: ReadonlyArray<string>;
  readonly color?: string;
  /** Seats in it and in the regions inside it. */
  readonly seats: number;
};

export type QuickThreadOption = QuickThreadSeat | QuickThreadRegion;

export type QuickThreadCatalog = {
  /** Every seat, the most recently visited first, as the agent switcher orders them. */
  readonly seats: ReadonlyArray<QuickThreadSeat>;
  /** Every region that holds a seat, by name. */
  readonly regions: ReadonlyArray<QuickThreadRegion>;
};

/** A row's key in the list: a seat and a region never share one. */
export const quickThreadOptionKey = (option: QuickThreadOption): string => `${option.kind}:${option.id}`;

/** What the picker chooses from, read from the canvas. Pure. */
export const quickThreadCatalog = (canvas: Canvas, recentIds: ReadonlyArray<string>): QuickThreadCatalog => {
  const trails = regionTrails(canvas);
  const held = new Map<string, number>();
  // The switcher's own order: recently visited seats first, the rest by name.
  const seats = buildFocusSwitcherCatalog({
    nodes: [...canvas.nodes.values()],
    focusNodeIds: [],
    hotbarSlots: [],
    recentIds,
  }).map((entry): QuickThreadSeat => {
    const trail = trails.get(entry.nodeId) ?? [];
    for (const step of trail) held.set(step.id, (held.get(step.id) ?? 0) + 1);
    const inner = trail.at(-1)?.name;
    return {
      kind: "seat",
      id: entry.nodeId,
      name: entry.title,
      ...(inner === undefined ? {} : { region: inner }),
      path: trail.map((step) => step.name).join(" / "),
      regionIds: trail.map((step) => step.id),
    };
  });
  const regions: QuickThreadRegion[] = [];
  for (const node of canvas.nodes.values()) {
    const count = node.kind === "region" ? held.get(node.id) : undefined;
    if (node.kind !== "region" || count === undefined) continue;
    regions.push({
      kind: "region",
      id: node.id,
      // The name a seat's path gives it, an unnamed region its placeholder.
      name: regionName(node),
      outer: (trails.get(node.id) ?? []).map((step) => step.name),
      ...(node.color ? { color: node.color } : {}),
      seats: count,
    });
  }
  regions.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { seats, regions };
};

/** Rows drawn at most: past it the operator types to narrow. */
export const QUICK_THREAD_LIST_CAP = 50;

/** A hit on a seat's own name ranks over the same hit on a region's. */
const NAME_HIT = 500;
/** A seat found only by where it sits ranks a tier under that hit: the region itself comes first. */
const PATH_ONLY = 1000;

/**
 * The list for what is typed. Nothing typed: the seats, most recent first.
 * Typed: seats and regions in one ranked list, fuzzy over a seat's name and
 * region path and a region's name (`fuzzy-match`, as Cmd+K). Narrowed to a
 * region, only that region's seats, and no region rows.
 */
export const quickThreadOptions = (
  catalog: QuickThreadCatalog,
  query: string,
  regionId?: string,
): ReadonlyArray<QuickThreadOption> => {
  const seats = regionId === undefined ? catalog.seats : catalog.seats.filter((seat) => seat.regionIds.includes(regionId));
  if (query.trim() === "") return seats.slice(0, QUICK_THREAD_LIST_CAP);
  const ranked: Array<{ readonly option: QuickThreadOption; readonly score: number; readonly index: number }> = [];
  const rank = (option: QuickThreadOption, score: number): void => void ranked.push({ option, score, index: ranked.length });
  // Regions first, so a region and a seat that score the same list the region first.
  if (regionId === undefined) {
    for (const region of catalog.regions) {
      const hit = fuzzyMatch(query, { identity: [region.name] });
      if (hit !== null) rank(region, hit.score);
    }
  }
  for (const seat of seats) {
    const byName = fuzzyMatch(query, { identity: [seat.name] });
    const byPath = seat.path === "" ? null : fuzzyMatch(query, { identity: [seat.path] });
    if (byName === null && byPath === null) continue;
    rank(seat, Math.max(byName === null ? -Infinity : byName.score + NAME_HIT, byPath === null ? -Infinity : byPath.score - PATH_ONLY));
  }
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.slice(0, QUICK_THREAD_LIST_CAP).map((entry) => entry.option);
};

// ---- The draft, kept until it is sent ----

// Each canvas's chosen seats, as one value per canvas: read whole, written whole.
const seats$ = observable<{ byCanvas: Readonly<Record<string, ReadonlyArray<string>>> }>({ byCanvas: {} });
const texts = new Map<string, string>();
const files = new Map<string, AttachmentHold>();
const helds = new Map<string, HeldThreadDraft>();
const NO_SEATS: ReadonlyArray<string> = [];

/** The seats chosen on this canvas, in the order chosen. */
export const quickThreadSeats = (canvasName: string): ReadonlyArray<string> => seats$.byCanvas.peek()[canvasName] ?? NO_SEATS;

export const useQuickThreadSeats = (canvasName: string): ReadonlyArray<string> =>
  use$(seats$.byCanvas)[canvasName] ?? NO_SEATS;

export const setQuickThreadSeats = (canvasName: string, seatIds: ReadonlyArray<string>): void => {
  seats$.byCanvas.set({ ...seats$.byCanvas.peek(), [canvasName]: [...new Set(seatIds)] });
};

/** The text and files of this canvas's draft, for the thread input to keep them in. One object per canvas. */
export const quickThreadDraft = (canvasName: string): HeldThreadDraft => {
  let held = helds.get(canvasName);
  if (held === undefined) {
    const hold = makeAttachmentHold();
    files.set(canvasName, hold);
    held = {
      text: () => texts.get(canvasName) ?? "",
      keepText: (text) => void texts.set(canvasName, text),
      files: hold,
    };
    helds.set(canvasName, held);
  }
  return held;
};

/** Something is waiting to be sent on this canvas: a seat, words or a file. */
export const hasQuickThreadDraft = (canvasName: string): boolean =>
  quickThreadSeats(canvasName).length > 0 ||
  (texts.get(canvasName) ?? "").trim() !== "" ||
  (files.get(canvasName)?.items().length ?? 0) > 0;

/**
 * Open Quick thread from anywhere, or close it when it is open (its own
 * key). The seats selected on the canvas start chosen, unless a draft with
 * seats of its own is waiting: that one comes back as it was left. False
 * with no canvas open, so the key passes.
 */
export const openQuickThread = (): boolean => {
  const canvasName = state$.canvasName.peek();
  if (canvasName === "") return false;
  if (!isOperatorModalOpen("quick-thread") && quickThreadSeats(canvasName).length === 0) {
    const nodes = modelStore.canvasOf(canvasName).nodes;
    const selected = state$.selectedNodeIds.peek().filter((id) => nodes.get(asNodeId(id))?.kind === "agent");
    if (selected.length > 0) setQuickThreadSeats(canvasName, selected);
  }
  toggleOperatorModal("quick-thread");
  return true;
};

/** Test helper: forget every draft. */
export const resetQuickThreads = (): void => {
  for (const hold of files.values()) hold.drop();
  seats$.byCanvas.set({});
  texts.clear();
  files.clear();
  helds.clear();
};
