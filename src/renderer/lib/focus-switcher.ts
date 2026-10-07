/**
 * The agent switcher: hold Cmd, tap the backtick to step through the agents,
 * let Cmd go to open the chosen one. The keys are rows in the key table; this
 * file holds the model.
 *
 * The catalog is every agent seat with a surface to open, in the one urgency
 * order (lib/urgency-order): the ones that need the operator first. It is a
 * snapshot, read once as the switcher comes up, so nothing reorders under
 * the operator while they step.
 *
 * Presentation and navigation only: nothing here writes the canvas.
 */
import { observable } from "@legendapp/state";
import type { CanvasNode } from "@shared/canvas";
import { activateNodeSurface, nodeSurfaceKind } from "./activate-node-surface";
import { dock$, nodeIdForSurface } from "./dock-state";
import { slotIndexOf, type HotbarSlot } from "./hotbar-slots";
import { nodeTitle } from "./presentation";
import type { SeatUrgency } from "./seat-line";
import { seatUrgencyNow } from "../components/SeatRing";
import { state$ } from "./state";
import type { WorkSurface } from "./surface-registry";
import { urgencyOrder } from "./urgency-order";

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
  readonly nodes: ReadonlyArray<CanvasNode>;
  /** Open surfaces, front first: the first one names the agent in front. */
  readonly focusNodeIds: ReadonlyArray<string>;
  readonly hotbarSlots: ReadonlyArray<HotbarSlot>;
  /** Read once per snapshot (seatUrgencyNow), so the order holds while the switcher is up. */
  readonly urgencyOf: (agent: CanvasNode) => SeatUrgency;
};

/**
 * The catalog: every agent with a surface to open, most urgent first (the
 * one urgency order, shared with the rail). Not capped: the strip scrolls.
 */
export const buildFocusSwitcherCatalog = (
  input: FocusSwitcherCatalogInput,
): ReadonlyArray<FocusSwitcherEntry> => {
  const currentId = input.focusNodeIds[0];
  const agents = input.nodes.filter(
    (node) => node.ether?.entity?.kind === "agent" && nodeSurfaceKind(node) !== null,
  );
  return urgencyOrder(agents, input.urgencyOf).map((node) => {
    const slot = slotIndexOf(input.hotbarSlots, node.id);
    return {
      nodeId: node.id,
      title: nodeTitle(node),
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
 * Where the switcher comes up: on the most urgent agent that is not the one
 * already in front (stepping back, on the least urgent).
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
  return buildFocusSwitcherCatalog({
    nodes: state$.doc.peek().nodes,
    focusNodeIds: focusMruNodeIds(registry.surfaces, registry.focusMru),
    hotbarSlots: state$.hotbarSlots.peek(),
    urgencyOf: seatUrgencyNow,
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
  const node = state$.doc.peek().nodes.find((candidate) => candidate.id === entry.nodeId);
  if (!node) return false;
  const result = activateNodeSurface(node);
  return result.opened;
};
