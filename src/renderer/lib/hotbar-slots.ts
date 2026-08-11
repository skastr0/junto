/**
 * Hotbar slots 1–9: empty | fixed (operator) | leased (active) | evicted (idle soft-hold).
 * Presentational only — never written into the authorial canvas.
 *
 * Evicted = was leased, node still live, no longer lease-worthy (idle / left MRU).
 * Still shows and still occupies the digit visually, but counts as fillable for
 * new active leases — so working with a few agents does not make chips vanish
 * the moment they go idle.
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

/** Idle soft-hold: still painted, still pressable, fillable by new activity. */
export const EvictedHotbarSlot = Schema.Struct({
  kind: Schema.Literal("evicted"),
  nodeId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});
export type EvictedHotbarSlot = typeof EvictedHotbarSlot.Type;

export const HotbarSlot = Schema.Union([
  EmptyHotbarSlot,
  FixedHotbarSlot,
  LeasedHotbarSlot,
  EvictedHotbarSlot,
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

export const isEvictedSlot = (slot: HotbarSlot): slot is EvictedHotbarSlot =>
  slot.kind === "evicted";

/** Soft-hold or empty — new opportunistic leases may take this index. */
export const isFillableSlot = (slot: HotbarSlot): boolean =>
  slot.kind === "empty" || slot.kind === "evicted";

export const slotNodeId = (slot: HotbarSlot): string | undefined =>
  slot.kind === "empty" ? undefined : slot.nodeId;

/** Index of node in slots (fixed preferred, then leased, then evicted). */
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
  if (leased >= 0 && leased < HOTBAR_SLOT_COUNT) return leased;
  const evicted = slots.findIndex(
    (slot) => slot.kind === "evicted" && slot.nodeId === nodeId,
  );
  return evicted >= 0 && evicted < HOTBAR_SLOT_COUNT ? evicted : null;
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
 * every other slot. Empty/leased/evicted at target become fixed.
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

/** Remove a node wherever it appears (fixed, leased, or evicted). */
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
 * Opportunistic leases with idle soft-hold.
 *
 * Stability rules (operator law — least perplexing):
 * 1. Fixed slots never change here.
 * 2. An active lease keeps its **slot index** while lease-worthy (sticky or
 *    still in the active MRU). No reshuffle on focus hops.
 * 3. When a lease stops being lease-worthy (idle / left MRU) it becomes
 *    **evicted** at the same index — still painted and pressable.
 * 4. Evicted slots are fillable: new sticky/MRU entries take empty first,
 *    then displace evicted (left-to-right). Hard leases never displace each other.
 * 5. Evicted → leased if the same node becomes lease-worthy again (in place).
 *
 * @param activeNodeIdsMru most-recently-active first
 * @param stickyWorkingIds nodes that must keep a hard lease while working
 */
export function applyHotbarLeases(
  slots: ReadonlyArray<HotbarSlot>,
  activeNodeIdsMru: ReadonlyArray<string>,
  liveNodeIds: ReadonlyArray<string>,
  stickyWorkingIds: ReadonlyArray<string> = [],
): HotbarSlot[] {
  const live = new Set(liveNodeIds);
  const sticky = new Set(stickyWorkingIds.filter((id) => live.has(id)));
  const active = new Set(activeNodeIdsMru.filter((id) => live.has(id)));
  const isLeaseWorthy = (id: string): boolean => sticky.has(id) || active.has(id);

  const fixedIds = new Set(
    slots
      .filter(isFixedSlot)
      .map((slot) => slot.nodeId)
      .filter((id) => live.has(id)),
  );

  // Pass 1: fixed stay; leased/evicted promote/demote in place; dead → empty.
  const preserved: HotbarSlot[] = padSlots(
    slots.map((slot) => {
      if (slot.kind === "fixed") {
        return live.has(slot.nodeId) ? slot : { kind: "empty" as const };
      }
      if (slot.kind === "leased" || slot.kind === "evicted") {
        const id = slot.nodeId;
        if (!live.has(id) || fixedIds.has(id)) return { kind: "empty" as const };
        if (isLeaseWorthy(id)) return { kind: "leased" as const, nodeId: id };
        // Soft-hold: still show, still fillable.
        return { kind: "evicted" as const, nodeId: id };
      }
      return { kind: "empty" as const };
    }),
  );

  // Hard occupants block re-placement of the same id elsewhere.
  const hardOnBoard = new Set<string>(fixedIds);
  for (const slot of preserved) {
    if (slot.kind === "leased") hardOnBoard.add(slot.nodeId);
  }
  // Soft occupants: still "on the bar" for dedupe until displaced.
  const softOnBoard = new Set<string>();
  for (const slot of preserved) {
    if (slot.kind === "evicted") softOnBoard.add(slot.nodeId);
  }

  const fillOrder: string[] = [];
  const fillSeen = new Set<string>();
  for (const id of stickyWorkingIds) {
    if (live.has(id) && !hardOnBoard.has(id) && !fillSeen.has(id)) {
      fillOrder.push(id);
      fillSeen.add(id);
    }
  }
  for (const id of activeNodeIdsMru) {
    if (live.has(id) && !hardOnBoard.has(id) && !fillSeen.has(id)) {
      fillOrder.push(id);
      fillSeen.add(id);
    }
  }

  let candidateIndex = 0;
  const takeNextCandidate = (): string | undefined => {
    while (candidateIndex < fillOrder.length) {
      const id = fillOrder[candidateIndex]!;
      candidateIndex += 1;
      // Already hard-leased or fixed — skip. Soft same-id is promoted in pass 1.
      if (hardOnBoard.has(id)) continue;
      // Already soft-held at some index: pass 1 should have promoted if worthy.
      // If still in fillOrder while soft, it was not lease-worthy (shouldn't happen).
      if (softOnBoard.has(id)) continue;
      return id;
    }
    return undefined;
  };

  // Pass 2a: fill true empties first (prefer empty over displacing soft holds).
  const afterEmpty = preserved.map((slot) => {
    if (slot.kind !== "empty") return slot;
    const id = takeNextCandidate();
    if (!id) return slot;
    hardOnBoard.add(id);
    return { kind: "leased" as const, nodeId: id };
  });

  // Pass 2b: remaining candidates displace evicted left-to-right.
  const next = afterEmpty.map((slot) => {
    if (slot.kind !== "evicted") return slot;
    const id = takeNextCandidate();
    if (!id) return slot;
    softOnBoard.delete(slot.nodeId);
    hardOnBoard.add(id);
    return { kind: "leased" as const, nodeId: id };
  });

  return padSlots(next);
}

/** prune dead → re-lease / soft-hold from MRU + sticky. */
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
 * Keep only lease-eligible ids (actors). Fixed slots are operator-owned and
 * are not filtered here.
 */
export function filterLeaseCandidateIds(
  ids: ReadonlyArray<string>,
  leaseEligibleIds: ReadonlySet<string>,
): string[] {
  return ids.filter((id) => leaseEligibleIds.has(id));
}

/**
 * Drop leased/evicted entries that are not actors. Operator fixed slots stay.
 * Used when law changes from "any focus" → "actors only" so the bar does not
 * soft-hold notes, tasks, regions, etc.
 */
export function purgeNonEligibleSoftSlots(
  slots: ReadonlyArray<HotbarSlot>,
  leaseEligibleIds: ReadonlySet<string>,
): HotbarSlot[] {
  return padSlots(
    slots.map((slot) => {
      if (slot.kind === "leased" || slot.kind === "evicted") {
        return leaseEligibleIds.has(slot.nodeId)
          ? slot
          : ({ kind: "empty" as const });
      }
      return slot;
    }),
  );
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
