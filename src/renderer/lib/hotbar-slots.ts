/**
 * Hotbar slots 1–9: empty | fixed (operator) | leased (active) | evicted (idle soft-hold).
 * Presentational only — never written into the authorial canvas.
 *
 * Evicted = was leased, node still live, no longer sticky-active (idle).
 * Still shows and still occupies the digit visually, but counts as fillable for
 * new sticky leases — so idle soft-holds make way for newly working actors
 * (oldest lease first) instead of blocking the bar.
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
 * 2. Hard lease only while **sticky** (working / attention). Historical focus
 *    MRU does **not** hold a hard lease — idle actors demote to evicted even
 *    if they remain in the MRU, so they make way for newly sticky actors.
 * 3. A sticky lease keeps its **slot index** (no reshuffle on focus hops).
 * 4. When sticky ends, the lease becomes **evicted** at the same index —
 *    still painted and pressable, fillable by new activity.
 * 5. New sticky actors without a hard lease take empty first, then displace
 *    evicted **oldest-lease-first** (slot index order: lower index first).
 *    Hard leases never displace each other.
 * 6. Evicted → leased if the same node becomes sticky again (in place).
 *
 * @param activeNodeIdsMru most-recently-focused first — orders fill among
 *   sticky candidates only; does not by itself keep a hard lease
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
  // Hard lease = sticky only. MRU history alone must not pin idle chips.
  const isLeaseWorthy = (id: string): boolean => sticky.has(id);

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

  // Fill only sticky actors not already hard-leased. Order: sticky in MRU
  // recency (most recent first), then remaining sticky (document order).
  const fillOrder: string[] = [];
  const fillSeen = new Set<string>();
  const pushFill = (id: string): void => {
    if (!live.has(id) || !sticky.has(id) || hardOnBoard.has(id) || fillSeen.has(id)) {
      return;
    }
    fillOrder.push(id);
    fillSeen.add(id);
  };
  for (const id of activeNodeIdsMru) pushFill(id);
  for (const id of stickyWorkingIds) pushFill(id);

  let candidateIndex = 0;
  const takeNextCandidate = (): string | undefined => {
    while (candidateIndex < fillOrder.length) {
      const id = fillOrder[candidateIndex]!;
      candidateIndex += 1;
      // Already hard-leased or fixed — skip. Soft same-id is promoted in pass 1.
      if (hardOnBoard.has(id)) continue;
      // Already soft-held: pass 1 promotes sticky in place; non-sticky is idle.
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

  // Pass 2b: remaining candidates displace evicted oldest-lease-first.
  // Slot index order matches sequential fill age (lower index = older lease).
  const next = [...afterEmpty];
  for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
    const slot = next[i];
    if (!slot || slot.kind !== "evicted") continue;
    const id = takeNextCandidate();
    if (!id) break;
    softOnBoard.delete(slot.nodeId);
    hardOnBoard.add(id);
    next[i] = { kind: "leased" as const, nodeId: id };
  }

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
