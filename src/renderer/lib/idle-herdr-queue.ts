/**
 * SC2-style idle herdr queue (RTS-009) — pure selector, no React/observables.
 *
 * Needs-you priority (v1, herdr only):
 * 0) permissionPending — ACP chat for that agent when applicable
 * 1) agentStatus === "done" (Idle+!seen) and not pendingSeen
 *
 * Blocked is deferred. Non-herdr inputs are ignored.
 */

export type IdleHerdrReason = "permission" | "done";

export interface IdleHerdrInput {
  readonly nodeId: string;
  /** Must be true — non-herdr nodes never enter the queue. */
  readonly isHerdr: boolean;
  /** Host/meta agentStatus: "done" = Idle+!seen (needs look). */
  readonly agentStatus?: string | null;
  /**
   * Local open-path latch (herdr-state pendingSeen). While set, host "done"
   * must not re-queue — operator just looked / is looking.
   */
  readonly pendingSeen?: boolean;
  /** ACP permission pending — priority 0 when true. */
  readonly permissionPending?: boolean;
}

export interface IdleHerdrEntry {
  readonly nodeId: string;
  readonly reason: IdleHerdrReason;
}

/** Classify a single candidate; null = not needs-you. */
export const isIdleHerdrNeedsYou = (input: IdleHerdrInput): IdleHerdrReason | null => {
  if (!input.isHerdr) return null;
  if (input.permissionPending === true) return "permission";
  // pendingSeen forces quiet even if a stale row still says done
  if (input.pendingSeen === true) return null;
  if (input.agentStatus === "done") return "done";
  return null;
};

/**
 * Ordered needs-you queue: all permission first (document order), then done.
 * Stable: preserves input array order within each priority bucket.
 */
export const deriveIdleHerdrQueue = (
  candidates: ReadonlyArray<IdleHerdrInput>,
): ReadonlyArray<IdleHerdrEntry> => {
  const permission: IdleHerdrEntry[] = [];
  const done: IdleHerdrEntry[] = [];
  for (const candidate of candidates) {
    const reason = isIdleHerdrNeedsYou(candidate);
    if (reason === "permission") {
      permission.push({ nodeId: candidate.nodeId, reason });
    } else if (reason === "done") {
      done.push({ nodeId: candidate.nodeId, reason });
    }
  }
  return [...permission, ...done];
};

/**
 * Cycle focus through the queue (SC2 idle-worker button).
 * - empty queue → undefined
 * - current not in queue (or missing) → first
 * - current at end → wrap to first
 */
export const nextIdleHerdrNodeId = (
  queue: ReadonlyArray<IdleHerdrEntry>,
  currentNodeId: string | null | undefined,
): string | undefined => {
  if (queue.length === 0) return undefined;
  if (!currentNodeId) return queue[0]!.nodeId;
  const idx = queue.findIndex((entry) => entry.nodeId === currentNodeId);
  if (idx === -1) return queue[0]!.nodeId;
  return queue[(idx + 1) % queue.length]!.nodeId;
};
