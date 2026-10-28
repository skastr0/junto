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
import type { HotbarSlot } from "./hotbar-slots";
import { HOTBAR_SLOT_COUNT, emptyHotbarSlots } from "./hotbar-slots";

/** One saved slot, as main keeps it: a row per slot. */
export type ViewCommandSlot =
  | { readonly kind: "empty" }
  | { readonly kind: "fixed"; readonly nodeId: string }
  | { readonly kind: "group"; readonly nodeIds: ReadonlyArray<string> };

/** What one canvas keeps of the hotbar: nine slots, then the groups past nine. */
export type ViewCommandGroups = {
  /** Exactly nine, in digit order. */
  readonly slots: ReadonlyArray<ViewCommandSlot>;
  /** Groups past slot nine, in the order the operator made them. */
  readonly extras: ReadonlyArray<ReadonlyArray<string>>;
};

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
