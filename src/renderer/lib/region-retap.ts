// Pure helpers for region slot digit re-tap: first press → region; re-press
// same slot within the gap → cycle members (document order). No camera math.

/** Max gap (ms) between same-digit presses that still counts as a re-tap cycle. */
export const REGION_RETAP_GAP_MS = 200;

export type RegionRetapMemory = {
  readonly slotIndex: number;
  /** performance.now() (or any monotonic ms clock) of the last press. */
  readonly atMs: number;
  /**
   * Index into the region's member list after the last press.
   * `-1` = last action selected the region itself (not a member yet).
   */
  readonly memberCursor: number;
};

export type RegionDigitVerdict =
  | { readonly kind: "select-region" }
  | { readonly kind: "select-member"; readonly index: number };

/**
 * Decide whether a digit press goes to the region or cycles a member.
 *
 * - Different slot, expired gap, or empty members → select region (cursor -1).
 * - Same slot within gap with members → next member index (wrap; first re-tap → 0).
 */
export function regionDigitVerdict(
  memory: RegionRetapMemory | null,
  slotIndex: number,
  nowMs: number,
  memberCount: number,
  gapMs: number = REGION_RETAP_GAP_MS,
): { readonly verdict: RegionDigitVerdict; readonly memory: RegionRetapMemory } {
  const within =
    memory !== null &&
    memory.slotIndex === slotIndex &&
    nowMs - memory.atMs <= gapMs;

  if (!within || memberCount <= 0) {
    return {
      verdict: { kind: "select-region" },
      memory: { slotIndex, atMs: nowMs, memberCursor: -1 },
    };
  }

  const index = memory.memberCursor < 0 ? 0 : (memory.memberCursor + 1) % memberCount;
  return {
    verdict: { kind: "select-member", index },
    memory: { slotIndex, atMs: nowMs, memberCursor: index },
  };
}

/**
 * Document-order member ids that appear in both `documentNodeIds` and the
 * rollup/membership set. Preserves document order; drops unknowns.
 */
export function membersInDocumentOrder(
  memberIds: ReadonlyArray<string>,
  documentNodeIds: ReadonlyArray<string>,
): string[] {
  const set = new Set(memberIds);
  return documentNodeIds.filter((id) => set.has(id));
}
