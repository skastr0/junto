/**
 * Hotbar slots 1–9: empty | fixed (operator) | leased (active-node opportunistic).
 * Presentational only — never written into the authorial canvas.
 */
import { Schema } from "effect";

export const HOTBAR_SLOT_COUNT = 9 as const;

export const EmptyHotbarSlot = Schema.Struct({
  kind: Schema.Literal("empty"),
});
export type EmptyHotbarSlot = typeof EmptyHotbarSlot.Type;

export const FixedHotbarSlot = Schema.Struct({
  kind: Schema.Literal("fixed"),
  nodeId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});
export type FixedHotbarSlot = typeof FixedHotbarSlot.Type;

export const LeasedHotbarSlot = Schema.Struct({
  kind: Schema.Literal("leased"),
  nodeId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});
export type LeasedHotbarSlot = typeof LeasedHotbarSlot.Type;

export const HotbarSlot = Schema.Union([
  EmptyHotbarSlot,
  FixedHotbarSlot,
  LeasedHotbarSlot,
]);
export type HotbarSlot = typeof HotbarSlot.Type;

export const HotbarSlots = Schema.Array(HotbarSlot).pipe(
  Schema.check(
    Schema.makeFilter(
      (slots) =>
        slots.length === HOTBAR_SLOT_COUNT ||
        `hotbar must have exactly ${HOTBAR_SLOT_COUNT} slots`,
    ),
  ),
);
export type HotbarSlots = typeof HotbarSlots.Type;

export const emptyHotbarSlots = (): HotbarSlot[] =>
  Array.from({ length: HOTBAR_SLOT_COUNT }, () => ({ kind: "empty" as const }));

export const isEmptySlot = (slot: HotbarSlot): slot is EmptyHotbarSlot =>
  slot.kind === "empty";

export const isFixedSlot = (slot: HotbarSlot): slot is FixedHotbarSlot =>
  slot.kind === "fixed";

export const isLeasedSlot = (slot: HotbarSlot): slot is LeasedHotbarSlot =>
  slot.kind === "leased";

export const slotNodeId = (slot: HotbarSlot): string | undefined =>
  slot.kind === "empty" ? undefined : slot.nodeId;

/** Index of node in slots (fixed preferred if ever duplicated — should not be). */
export function slotIndexOf(
  slots: ReadonlyArray<HotbarSlot>,
  nodeId: string,
): number | null {
  const fixed = slots.findIndex(
    (slot) => slot.kind === "fixed" && slot.nodeId === nodeId,
  );
  if (fixed >= 0 && fixed < HOTBAR_SLOT_COUNT) return fixed;
  const leased = slots.findIndex(
    (slot) => slot.kind === "leased" && slot.nodeId === nodeId,
  );
  return leased >= 0 && leased < HOTBAR_SLOT_COUNT ? leased : null;
}

export function nodeIdAt(
  slots: ReadonlyArray<HotbarSlot>,
  slotIndex: number,
): string | undefined {
  const slot = slots[slotIndex];
  return slot ? slotNodeId(slot) : undefined;
}

/** Drop dead nodes → empty; keep length 9. */
export function pruneHotbarSlots(
  slots: ReadonlyArray<HotbarSlot>,
  liveNodeIds: ReadonlyArray<string>,
): HotbarSlot[] {
  const live = new Set(liveNodeIds);
  return padSlots(
    slots.map((slot) => {
      if (slot.kind === "empty") return slot;
      return live.has(slot.nodeId) ? slot : { kind: "empty" as const };
    }),
  );
}

/**
 * Operator assignment: fix `nodeId` at `slotIndex`. Removes that node from
 * every other slot. Empty/leased at target become fixed.
 */
export function assignFixedSlot(
  slots: ReadonlyArray<HotbarSlot>,
  nodeId: string,
  slotIndex: number,
): HotbarSlot[] {
  const clamped = Math.max(0, Math.min(HOTBAR_SLOT_COUNT - 1, slotIndex));
  const cleared = slots.map((slot) =>
    slot.kind !== "empty" && slot.nodeId === nodeId
      ? ({ kind: "empty" as const })
      : slot,
  );
  const next = [...cleared];
  next[clamped] = { kind: "fixed", nodeId };
  return padSlots(next);
}

/** Clear one index to empty (operator unassign / lease drop). */
export function clearHotbarSlotAt(
  slots: ReadonlyArray<HotbarSlot>,
  slotIndex: number,
): HotbarSlot[] {
  const clamped = Math.max(0, Math.min(HOTBAR_SLOT_COUNT - 1, slotIndex));
  const next = [...slots];
  next[clamped] = { kind: "empty" };
  return padSlots(next);
}

/** Remove a node wherever it appears (fixed or leased). */
export function clearHotbarNode(
  slots: ReadonlyArray<HotbarSlot>,
  nodeId: string,
): HotbarSlot[] {
  return padSlots(
    slots.map((slot) =>
      slot.kind !== "empty" && slot.nodeId === nodeId
        ? { kind: "empty" as const }
        : slot,
    ),
  );
}

/**
 * Opportunistic leases: fill empty slots with recent/active nodes.
 *
 * Stability rules (operator law — least perplexing):
 * 1. Fixed slots never change here.
 * 2. An existing lease keeps its **slot index** while the node is still live
 *    and lease-worthy (working-sticky or still in the active MRU). No reshuffle
 *    when focus hops between nodes (pressing "2" must not reassign slot 2).
 * 3. Working-sticky nodes stay leased even when not most-recent in MRU; they
 *    only free when they leave the sticky set (e.g. go idle) and drop out of MRU.
 * 4. Empty slots fill from sticky-first then MRU, skipping already-placed ids.
 *
 * @param activeNodeIdsMru most-recently-active first
 * @param stickyWorkingIds nodes that must keep a lease while working
 */
export function applyHotbarLeases(
  slots: ReadonlyArray<HotbarSlot>,
  activeNodeIdsMru: ReadonlyArray<string>,
  liveNodeIds: ReadonlyArray<string>,
  stickyWorkingIds: ReadonlyArray<string> = [],
): HotbarSlot[] {
  const live = new Set(liveNodeIds);
  const sticky = new Set(
    stickyWorkingIds.filter((id) => live.has(id)),
  );
  const active = new Set(
    activeNodeIdsMru.filter((id) => live.has(id)),
  );
  const isLeaseWorthy = (id: string): boolean =>
    sticky.has(id) || active.has(id);

  const fixedIds = new Set(
    slots
      .filter(isFixedSlot)
      .map((slot) => slot.nodeId)
      .filter((id) => live.has(id)),
  );

  // Pass 1: keep fixed; preserve lease-worthy leases at the same index.
  const preserved: HotbarSlot[] = padSlots(
    slots.map((slot) => {
      if (slot.kind === "fixed") {
        return live.has(slot.nodeId) ? slot : { kind: "empty" as const };
      }
      if (slot.kind === "leased") {
        const id = slot.nodeId;
        if (live.has(id) && !fixedIds.has(id) && isLeaseWorthy(id)) {
          return slot;
        }
        return { kind: "empty" as const };
      }
      return { kind: "empty" as const };
    }),
  );

  // Pass 2: fill empties without moving preserved leases.
  const onBoard = new Set<string>(fixedIds);
  for (const slot of preserved) {
    if (slot.kind === "leased") onBoard.add(slot.nodeId);
  }
  const fillOrder: string[] = [];
  const fillSeen = new Set<string>();
  for (const id of stickyWorkingIds) {
    if (live.has(id) && !onBoard.has(id) && !fillSeen.has(id)) {
      fillOrder.push(id);
      fillSeen.add(id);
    }
  }
  for (const id of activeNodeIdsMru) {
    if (live.has(id) && !onBoard.has(id) && !fillSeen.has(id)) {
      fillOrder.push(id);
      fillSeen.add(id);
    }
  }

  let candidateIndex = 0;
  const next = preserved.map((slot) => {
    if (slot.kind !== "empty") return slot;
    while (candidateIndex < fillOrder.length) {
      const id = fillOrder[candidateIndex]!;
      candidateIndex += 1;
      if (onBoard.has(id)) continue;
      onBoard.add(id);
      return { kind: "leased" as const, nodeId: id };
    }
    return { kind: "empty" as const };
  });
  return padSlots(next);
}

/** prune dead → re-lease from MRU (sticky working leases hold their slots). */
export function resolveHotbarSlots(
  slots: ReadonlyArray<HotbarSlot>,
  liveNodeIds: ReadonlyArray<string>,
  activeNodeIdsMru: ReadonlyArray<string>,
  stickyWorkingIds: ReadonlyArray<string> = [],
): HotbarSlot[] {
  return applyHotbarLeases(
    pruneHotbarSlots(slots, liveNodeIds),
    activeNodeIdsMru,
    liveNodeIds,
    stickyWorkingIds,
  );
}

/**
 * Touch MRU: move `nodeId` to front, cap length.
 * Pure — caller writes state.
 */
export function touchActiveMru(
  mru: ReadonlyArray<string>,
  nodeId: string,
  cap = 16,
): string[] {
  return [nodeId, ...mru.filter((id) => id !== nodeId)].slice(0, cap);
}

/**
 * Migrate legacy dense order (operator assignments as 0..n-1 fixed) into
 * a 9-slot board. Remaining indices empty (leases applied later).
 */
export function hotbarSlotsFromLegacyOrder(
  order: ReadonlyArray<string>,
): HotbarSlot[] {
  const slots = emptyHotbarSlots();
  order.slice(0, HOTBAR_SLOT_COUNT).forEach((nodeId, index) => {
    if (nodeId) slots[index] = { kind: "fixed", nodeId };
  });
  return slots;
}

/** Dense fixed-only node ids in slot order (compat for drag reorder of fixed). */
export function fixedOrderOf(slots: ReadonlyArray<HotbarSlot>): string[] {
  return slots
    .filter(isFixedSlot)
    .map((slot) => slot.nodeId);
}

const padSlots = (slots: ReadonlyArray<HotbarSlot>): HotbarSlot[] => {
  const next = slots.slice(0, HOTBAR_SLOT_COUNT);
  while (next.length < HOTBAR_SLOT_COUNT) next.push({ kind: "empty" });
  return next;
};
