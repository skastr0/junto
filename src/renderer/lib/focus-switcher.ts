/**
 * Focus switcher — Alt-Tab for focus models.
 *
 * Hold Control, tap Tab to cycle a frozen catalog, release Control to commit.
 * The catalog is a snapshot: MRU does not reshuffle until commit, so A↔B
 * flicks. Cmd+] / Cmd+[ remain the connected-actor ring; this is the global
 * jump (parked focus surfaces first, then hotbar, then the rest of the canvas).
 *
 * Presentation and navigation only — nothing here writes the canvas.
 */
import { observable } from "@legendapp/state";
import type { CanvasNode } from "@shared/canvas";
import { activateNodeSurface, nodeSurfaceKind } from "./activate-node-surface";
import {
  dock$,
  parseChatSurfaceId,
  parseNoteSurfaceId,
  parseTaskCreateSurfaceId,
  parseTerminalSurfaceId,
} from "./dock-state";
import { nodeIdAt, slotIndexOf, type HotbarSlot } from "./hotbar-slots";
import { nodeTitle, nodeTypeLabel } from "./presentation";
import { state$ } from "./state";
import type { WorkSurface } from "./surface-registry";

export const FOCUS_SWITCHER_CAP = 16;

export type FocusSwitcherEntry = {
  readonly nodeId: string;
  readonly title: string;
  readonly kindLabel: string;
  /** 1–9 when the node occupies a hotbar slot, else null. */
  readonly hotbarSlot: number | null;
  /** Already in the focus-zone MRU (parked or front). */
  readonly parked: boolean;
  /** Frontmost focus surface when the snapshot was taken. */
  readonly current: boolean;
};

export type FocusSwitcherSession = {
  readonly entries: ReadonlyArray<FocusSwitcherEntry>;
  readonly selectedIndex: number;
};

export const focusSwitcher$ = observable({
  session: null as FocusSwitcherSession | null,
});

export const nodeIdForSurface = (surface: WorkSurface): string | null => {
  if (surface.kind === "terminal") return parseTerminalSurfaceId(surface.id);
  if (surface.kind === "chat") return parseChatSurfaceId(surface.id);
  if (surface.kind === "note") return parseNoteSurfaceId(surface.id);
  if (surface.kind === "task-create") return parseTaskCreateSurfaceId(surface.id);
  if (surface.kind === "browser") {
    return dock$.browserByRef[surface.id].peek()?.nodeId ?? null;
  }
  return null;
};

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
  readonly focusNodeIds: ReadonlyArray<string>;
  readonly hotbarSlots: ReadonlyArray<HotbarSlot>;
  readonly hotbarActiveMru: ReadonlyArray<string>;
  readonly cap?: number;
};

/**
 * Ranked catalog: open focus MRU (front first), then occupied hotbar slots
 * 1–9, then hotbar recency, then document order. Closed to nodes that have
 * a focus surface. Capped so the HUD stays a glance, not a file picker.
 */
export const buildFocusSwitcherCatalog = (
  input: FocusSwitcherCatalogInput,
): ReadonlyArray<FocusSwitcherEntry> => {
  const cap = input.cap ?? FOCUS_SWITCHER_CAP;
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const parked = new Set(input.focusNodeIds);
  const currentId = input.focusNodeIds[0];
  const seen = new Set<string>();
  const ranked: string[] = [];

  const consider = (nodeId: string | undefined): void => {
    if (!nodeId || seen.has(nodeId)) return;
    const node = byId.get(nodeId);
    if (!node || nodeSurfaceKind(node) === null) return;
    seen.add(nodeId);
    ranked.push(nodeId);
  };

  for (const id of input.focusNodeIds) consider(id);
  for (let slot = 0; slot < 9; slot += 1) {
    consider(nodeIdAt(input.hotbarSlots, slot));
  }
  for (const id of input.hotbarActiveMru) consider(id);
  for (const node of input.nodes) consider(node.id);

  return ranked.slice(0, cap).map((nodeId) => {
    const node = byId.get(nodeId)!;
    const slot = slotIndexOf(input.hotbarSlots, nodeId);
    return {
      nodeId,
      title: nodeTitle(node),
      kindLabel: nodeTypeLabel(node),
      hotbarSlot: slot === null ? null : slot + 1,
      parked: parked.has(nodeId),
      current: nodeId === currentId,
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

const snapshotCatalog = (): ReadonlyArray<FocusSwitcherEntry> => {
  const registry = dock$.registry.peek();
  return buildFocusSwitcherCatalog({
    nodes: state$.doc.peek().nodes,
    focusNodeIds: focusMruNodeIds(registry.surfaces, registry.focusMru),
    hotbarSlots: state$.hotbarSlots.peek(),
    hotbarActiveMru: state$.hotbarActiveMru.peek(),
  });
};

const currentIndexOf = (entries: ReadonlyArray<FocusSwitcherEntry>): number => {
  const at = entries.findIndex((entry) => entry.current);
  return at;
};

export const openFocusSwitcher = (direction: 1 | -1): boolean => {
  if (focusSwitcher$.session.peek()) return false;
  const entries = snapshotCatalog();
  if (entries.length < 2) return false;
  const selectedIndex = nextSelectedIndex(currentIndexOf(entries), entries.length, direction);
  focusSwitcher$.session.set({ entries, selectedIndex });
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

export const jumpFocusSwitcherHotbar = (slot: number): boolean => {
  const session = focusSwitcher$.session.peek();
  if (!session) return false;
  const index = session.entries.findIndex((entry) => entry.hotbarSlot === slot);
  if (index < 0) return false;
  return selectFocusSwitcherIndex(index);
};

export const cancelFocusSwitcher = (): void => {
  focusSwitcher$.session.set(null);
};

export const commitFocusSwitcher = (): boolean => {
  const session = focusSwitcher$.session.peek();
  if (!session) return false;
  const entry = session.entries[session.selectedIndex];
  focusSwitcher$.session.set(null);
  if (!entry) return false;
  const node = state$.doc.peek().nodes.find((candidate) => candidate.id === entry.nodeId);
  if (!node) return false;
  const result = activateNodeSurface(node);
  return result.opened;
};

/**
 * Control+Tab — capture phase so the chord never reaches the focused xterm.
 * Consumed only when a session opens or moves; otherwise the event passes.
 */
export const installFocusSwitcherHotkeys = (): (() => void) => {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (state$.commandBarOpen.peek()) return;
    const session = focusSwitcher$.session.peek();

    if (session && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelFocusSwitcher();
      return;
    }

    if (session && !event.metaKey && !event.altKey) {
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        moveFocusSwitcher(1);
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        moveFocusSwitcher(-1);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        commitFocusSwitcher();
        return;
      }
      if (event.key >= "1" && event.key <= "9") {
        event.preventDefault();
        event.stopPropagation();
        jumpFocusSwitcherHotbar(Number(event.key));
        return;
      }
    }

    if (event.key !== "Tab" || !event.ctrlKey || event.metaKey || event.altKey) return;
    if (state$.settingsOpen.peek()) return;

    const direction: 1 | -1 = event.shiftKey ? -1 : 1;
    const acted = session ? moveFocusSwitcher(direction) : openFocusSwitcher(direction);
    if (!acted) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (!focusSwitcher$.session.peek()) return;
    if (event.key !== "Control" && event.code !== "ControlLeft" && event.code !== "ControlRight") {
      return;
    }
    commitFocusSwitcher();
  };

  window.addEventListener("keydown", onKeyDown, { capture: true });
  window.addEventListener("keyup", onKeyUp, { capture: true });
  return () => {
    window.removeEventListener("keydown", onKeyDown, { capture: true });
    window.removeEventListener("keyup", onKeyUp, { capture: true });
  };
};
