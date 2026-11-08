/**
 * The agent switcher: hold Cmd, tap the backtick to step through the agents,
 * let Cmd go to open the chosen one. The keys are rows in the key table; this
 * file holds the model.
 *
 * The catalog is every agent seat by recency, like cmd+tab: the seats the
 * operator visited most recently first (seat-visits), then the ones never
 * visited, by name. Urgency is cmd+K's job. It is a snapshot, read once as the
 * switcher comes up, so nothing reorders under the operator while they step.
 *
 * Presentation and navigation only: nothing here writes the canvas.
 */
import { observable } from "@legendapp/state";
import type { Node, Seat } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { activateNodeSurface } from "./activate-node-surface";
import { dock$, nodeIdForSurface } from "./dock-state";
import { slotIndexOf, type HotbarSlot } from "./hotbar-slots";
import { state$ } from "./state";
import type { WorkSurface } from "./surface-registry";
import { modelStore } from "./use-model";

export type FocusSwitcherEntry = {
  readonly nodeId: string;
  readonly title: string;
  /** 1–9 when the node occupies a hotbar slot, else null. */
  readonly hotbarSlot: number | null;
  /** The agent in front when the snapshot was taken. */
  readonly current: boolean;
};

export type FocusSwitcherSession = {
  readonly entries: ReadonlyArray<FocusSwitcherEntry>;
  readonly selectedIndex: number;
};

export const focusSwitcher$ = observable({
  session: null as FocusSwitcherSession | null,
});

export const focusMruNodeIds = (
  surfaces: ReadonlyArray<WorkSurface>,
  focusMru: ReadonlyArray<string>,
  browserNodeId: (surfaceId: string) => string | null = (id) =>
    dock$.browserByRef[id].peek()?.nodeId ?? null,
): readonly string[] => {
  const byId = new Map(surfaces.map((surface) => [surface.id, surface]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const surfaceId of focusMru) {
    const surface = byId.get(surfaceId);
    if (!surface) continue;
    const nodeId =
      surface.kind === "browser"
        ? browserNodeId(surface.id)
        : nodeIdForSurface(surface);
    if (!nodeId || seen.has(nodeId)) continue;
    seen.add(nodeId);
    out.push(nodeId);
  }
  return out;
};

export type FocusSwitcherCatalogInput = {
  readonly nodes: ReadonlyArray<Node>;
  /** Open surfaces, front first: the first one names the agent in front. */
  readonly focusNodeIds: ReadonlyArray<string>;
  readonly hotbarSlots: ReadonlyArray<HotbarSlot>;
  /** Node ids the operator visited, most recent first (seatVisitOrder). */
  readonly recentIds: ReadonlyArray<string>;
};

/** Seats by recency: visited ones in `recentIds` order, then the rest by name. */
const recencyOrder = (seats: ReadonlyArray<Seat>, recentIds: ReadonlyArray<string>): Seat[] => {
  const rank = new Map(recentIds.map((id, index) => [id, index] as const));
  return [...seats].sort((a, b) => {
    const aRank = rank.get(a.id);
    const bRank = rank.get(b.id);
    if (aRank !== undefined && bRank !== undefined) return aRank - bRank;
    if (aRank !== undefined) return -1;
    if (bRank !== undefined) return 1;
    return titleOf(a).localeCompare(titleOf(b)) || a.id.localeCompare(b.id);
  });
};

/**
 * The catalog: every seat, the most recently visited first. A seat always has
 * a terminal to open. Not capped: the strip scrolls.
 */
export const buildFocusSwitcherCatalog = (
  input: FocusSwitcherCatalogInput,
): ReadonlyArray<FocusSwitcherEntry> => {
  const currentId = input.focusNodeIds[0];
  const seats = input.nodes.filter((node): node is Seat => node.kind === "agent");
  return recencyOrder(seats, input.recentIds).map((node) => {
    const slot = slotIndexOf(input.hotbarSlots, node.id);
    return {
      nodeId: node.id,
      title: titleOf(node),
      hotbarSlot: slot === null ? null : slot + 1,
      current: node.id === currentId,
    };
  });
};

export const wrapIndex = (index: number, length: number): number => {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
};

export const nextSelectedIndex = (
  currentIndex: number,
  length: number,
  direction: 1 | -1,
): number => {
  if (length <= 0) return 0;
  if (currentIndex < 0) return direction === 1 ? 0 : length - 1;
  return wrapIndex(currentIndex + direction, length);
};

/**
 * Where the switcher comes up: on the most recent agent that is not the one
 * already in front (stepping back, on the least recent).
 */
export const openingIndex = (
  entries: ReadonlyArray<FocusSwitcherEntry>,
  direction: 1 | -1,
): number => {
  const edge = direction === 1 ? 0 : entries.length - 1;
  return entries[edge]?.current ? wrapIndex(edge + direction, entries.length) : edge;
};

const snapshotCatalog = (): ReadonlyArray<FocusSwitcherEntry> => {
  const registry = dock$.registry.peek();
  const canvas = state$.canvasName.peek();
  return buildFocusSwitcherCatalog({
    nodes: canvas === "" ? [] : [...modelStore.canvasOf(canvas).nodes.values()],
    focusNodeIds: focusMruNodeIds(registry.surfaces, registry.focusMru),
    hotbarSlots: state$.hotbarSlots.peek(),
    recentIds: state$.seatVisitOrder.peek(),
  });
};

const cancelWhenHidden = (): void => {
  if (document.hidden) cancelFocusSwitcher();
};

// The switcher waits on Cmd being let go, and a key let go in another window
// never arrives here: leaving the window closes the switcher, nothing opened.
const watchWindow = (up: boolean): void => {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (up) {
    window.addEventListener("blur", cancelFocusSwitcher);
    document.addEventListener("visibilitychange", cancelWhenHidden);
  } else {
    window.removeEventListener("blur", cancelFocusSwitcher);
    document.removeEventListener("visibilitychange", cancelWhenHidden);
  }
};

export const openFocusSwitcher = (direction: 1 | -1): boolean => {
  if (focusSwitcher$.session.peek()) return false;
  const entries = snapshotCatalog();
  if (entries.length < 2) return false;
  focusSwitcher$.session.set({ entries, selectedIndex: openingIndex(entries, direction) });
  watchWindow(true);
  return true;
};

export const moveFocusSwitcher = (direction: 1 | -1): boolean => {
  const session = focusSwitcher$.session.peek();
  if (!session || session.entries.length === 0) return false;
  focusSwitcher$.session.set({
    entries: session.entries,
    selectedIndex: nextSelectedIndex(
      session.selectedIndex,
      session.entries.length,
      direction,
    ),
  });
  return true;
};

export const selectFocusSwitcherIndex = (index: number): boolean => {
  const session = focusSwitcher$.session.peek();
  if (!session) return false;
  if (index < 0 || index >= session.entries.length) return false;
  if (index === session.selectedIndex) return true;
  focusSwitcher$.session.set({ entries: session.entries, selectedIndex: index });
  return true;
};

export const cancelFocusSwitcher = (): void => {
  watchWindow(false);
  focusSwitcher$.session.set(null);
};

export const commitFocusSwitcher = (): boolean => {
  const session = focusSwitcher$.session.peek();
  if (!session) return false;
  const entry = session.entries[session.selectedIndex];
  cancelFocusSwitcher();
  if (!entry) return false;
  const result = activateNodeSurface(entry.nodeId);
  return result.opened;
};
