/**
 * 0.11 view state (04), the renderer's half: how the operator arranged Junto,
 * kept across a quit in `junto.db`. Main owns the tables, the schema step and
 * the IPC (V1); this file names what the renderer reads and writes, so a
 * surface never learns the wire.
 *
 * Command groups are V2 and live here first. Each node's filters, the item it
 * had open, a collapsed sidebar and a resized modal (V3) join the same seam.
 *
 * The contract with main, as the plan sets it: one snapshot at window load,
 * one small write per changed row as it changes, last write wins, and a push
 * to every window as a change lands. The store is synchronous on this side
 * because main fills the mirror at load; a write goes out and the same change
 * comes back as a push, which the writer drops as its own echo.
 *
 * Only the operator's own arrangement crosses. A lease is derived from
 * activity, so fixed slots and groups are kept and leases never are; a group's
 * members keep the order the operator saved them in.
 *
 * What main owes this seam (V1): a read answers with exactly nine slot rows,
 * never fewer, and the groups past nine in their saved order; a write replaces
 * that one row; and a load that fills the mirror announces every canvas it
 * filled, so a read taken before the load is dropped rather than kept.
 */
import type { ArtifactType } from "@shared/artifact";
import type { ArtifactLabel } from "@shared/artifact-labels";
import type { CaptureDesk, CaptureDraft, ViewCommandGroups, ViewCommandSlot } from "@shared/view-state";
import type { StateFilter } from "../components/tasks/tasks-pane-model";
import type { HotbarSlot } from "./hotbar-slots";
import { HOTBAR_SLOT_COUNT, emptyHotbarSlots } from "./hotbar-slots";

export type { ViewCommandGroups, ViewCommandSlot } from "@shared/view-state";

/**
 * The store as the renderer sees it. Main implements it (V1); until those
 * tables and their IPC land, `view-state-stand-in.ts` answers in memory.
 */
export type ViewStateStore = {
  /** The canvas's saved arrangement, or undefined when it has never held one. */
  readonly read: (canvas: string) => ViewCommandGroups | undefined;
  /** Write one slot's row. A blank canvas name writes nothing. */
  readonly writeSlot: (canvas: string, index: number, slot: ViewCommandSlot) => void;
  /** Write the groups past nine as one ordered list. */
  readonly writeExtras: (canvas: string, extras: ReadonlyArray<ReadonlyArray<string>>) => void;
  /** Hear a change as it lands, this window's or another's; returns the unsubscribe. */
  readonly onChange: (listener: (canvas: string) => void) => () => void;
};

/**
 * A live slot as the store keeps it. Leases and idle soft-holds are derived
 * from activity, so they are written as empty and recomputed after a load.
 */
export const storedSlotOf = (slot: HotbarSlot): ViewCommandSlot => {
  switch (slot.kind) {
    case "fixed":
      return { kind: "fixed", nodeId: slot.nodeId };
    case "group":
      return { kind: "group", nodeIds: [...slot.nodeIds] };
    case "empty":
    case "leased":
    case "evicted":
      return { kind: "empty" };
  }
};

/** A whole board as the store keeps it: exactly nine rows, digits in order. */
export const storedSlotsOf = (slots: ReadonlyArray<HotbarSlot>): ViewCommandSlot[] => {
  const board = slots.slice(0, HOTBAR_SLOT_COUNT).map(storedSlotOf);
  while (board.length < HOTBAR_SLOT_COUNT) board.push({ kind: "empty" });
  return board;
};

/** The board a canvas's saved rows stand for. A stranger canvas is empty. */
export const liveSlotsOf = (saved: ReadonlyArray<ViewCommandSlot> | undefined): HotbarSlot[] => {
  if (!saved) return emptyHotbarSlots();
  const board = saved.slice(0, HOTBAR_SLOT_COUNT).map((slot): HotbarSlot => {
    switch (slot.kind) {
      case "fixed":
        return { kind: "fixed", nodeId: slot.nodeId };
      case "group":
        return { kind: "group", nodeIds: [...slot.nodeIds] };
      case "empty":
        return { kind: "empty" };
    }
  });
  while (board.length < HOTBAR_SLOT_COUNT) board.push({ kind: "empty" });
  return board;
};

/** Whether two saved boards say the same thing, row for row. */
export const sameStoredSlots = (
  a: ReadonlyArray<ViewCommandSlot>,
  b: ReadonlyArray<ViewCommandSlot>,
): boolean =>
  a.length === b.length &&
  a.every((slot, index) => {
    const other = b[index]!;
    if (slot.kind !== other.kind) return false;
    if (slot.kind === "fixed" && other.kind === "fixed") return slot.nodeId === other.nodeId;
    if (slot.kind === "group" && other.kind === "group")
      return slot.nodeIds.length === other.nodeIds.length && slot.nodeIds.every((id, at) => other.nodeIds[at] === id);
    return true;
  });

/** Whether two lists of groups past nine say the same thing, in order. */
export const sameExtras = (
  a: ReadonlyArray<ReadonlyArray<string>>,
  b: ReadonlyArray<ReadonlyArray<string>>,
): boolean =>
  a.length === b.length &&
  a.every(
    (group, index) => group.length === b[index]!.length && group.every((id, at) => b[index]![at] === id),
  );

// ---------------------------------------------------------------------------
// Node surfaces (V3)

/** The Artifacts node as the operator left it: its filter and the artifact it had open. */
export type ArtifactsNodeView = {
  readonly type: ArtifactType | "all";
  readonly archived: boolean;
  /** Picked labels, sorted: a row each. */
  readonly labels: ReadonlyArray<ArtifactLabel>;
  readonly open: string | null;
};

/** The Tasks node: its state filter and the task it had open. */
export type TasksNodeView = {
  readonly state: StateFilter;
  readonly open: string | null;
};

/** The Automations node: the automation it had open. */
export type AutomationsNodeView = {
  readonly open: string | null;
};

/** The Files node: the file it had open, relative, and the folders expanded in its tree, a row each. */
export type FilesNodeView = {
  readonly open: string | null;
  readonly expanded: ReadonlyArray<string>;
};

/** A resized modal's size, by surface: machine-wide, not per node or canvas. */
export type SurfaceSize = { readonly width: number; readonly height: number };

/**
 * The node surfaces' half of the store (V3), beside `ViewStateStore`. Read
 * synchronously from the load snapshot, a value stays the same object until
 * it changes, so a reader can hold it as a React snapshot. A blank canvas
 * name reads nothing and writes nothing. Every row goes with its node and its
 * canvas (V1).
 */
export type NodeViewStore = {
  readonly artifacts: (canvas: string, node: string) => ArtifactsNodeView | undefined;
  readonly writeArtifacts: (canvas: string, node: string, view: ArtifactsNodeView) => void;
  readonly tasks: (canvas: string, node: string) => TasksNodeView | undefined;
  readonly writeTasks: (canvas: string, node: string, view: TasksNodeView) => void;
  readonly automations: (canvas: string, node: string) => AutomationsNodeView | undefined;
  readonly writeAutomations: (canvas: string, node: string, view: AutomationsNodeView) => void;
  readonly files: (canvas: string, node: string) => FilesNodeView | undefined;
  readonly writeFiles: (canvas: string, node: string, view: FilesNodeView) => void;
  /** Whether the node's two-pane sidebar is collapsed; a row while it is. */
  readonly sidebarCollapsed: (canvas: string, node: string) => boolean;
  readonly writeSidebarCollapsed: (canvas: string, node: string, collapsed: boolean) => void;
  readonly surfaceSize: (surface: string) => SurfaceSize | undefined;
  /** null forgets the size: the surface opens at its default again. */
  readonly writeSurfaceSize: (surface: string, size: SurfaceSize | null) => void;
  /** The Artifacts comments rail, open or an edge, one choice for every artifact. */
  readonly commentsRailOpen: () => boolean;
  readonly writeCommentsRailOpen: (open: boolean) => void;
  /** The actor rail, one setting for every agent; expanded unless the operator collapsed it. */
  readonly actorRailExpanded: () => boolean;
  readonly writeActorRailExpanded: (expanded: boolean) => void;
  /** Quick capture's Inbox: the Artifacts node this canvas's captures land in (11 Q4). */
  readonly captureInbox: (canvas: string) => string | undefined;
  /** null forgets it: the next capture asks again. */
  readonly writeCaptureInbox: (canvas: string, node: string | null) => void;
  /** Quick capture's draft (0.12): the words not yet in an artifact, as last written. */
  readonly captureDraft: (canvas: string) => CaptureDraft | undefined;
  /**
   * Write the draft, or null to clear it. Resolves true once the row is on
   * disk, false when it was not kept; never rejects. Nothing listens for it:
   * the writing reads it once, as it opens.
   */
  readonly writeCaptureDraft: (canvas: string, draft: CaptureDraft | null) => Promise<boolean>;
  /** Quick capture's desk (0.12): where the operator was, never a word of the writing. */
  readonly captureDesk: (canvas: string) => CaptureDesk | undefined;
  /**
   * Write the desk, or null to forget it (a fresh capture starts). Resolves
   * true once the row is on disk, false when it was not kept; never rejects.
   */
  readonly writeCaptureDesk: (canvas: string, desk: CaptureDesk | null) => Promise<boolean>;
  /** Hear any change as it lands, this window's or another's; returns the unsubscribe. */
  readonly onChange: (listener: () => void) => () => void;
};
