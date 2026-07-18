/**
 * Rising-edge alert queue for the RTS attention machine.
 *
 * Pure model only — no React, no IPC, no Audio. The wire layer feeds live
 * signals, plays SFX on rise, and binds Space / backtick to cycleNext.
 *
 * Laws:
 * - First observe is baseline (no risen alerts, no SFX).
 * - An alert enters the queue only on a rising edge after baseline.
 * - Active (non-risen) signals still re-enter quietly so Space can land on them.
 * - Cycle wraps; empty queue is a no-op.
 * - focusNodeId comes from the alert's nodeId (wire resolves agents/projects).
 */

export const ALERT_KINDS = [
  "blocked",
  "permission",
  "herdr-done",
  "booth-review",
  "orphan",
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];

/** Stable queue entry — one per subject (member, agent, project, orphan key). */
export interface AlertItem {
  readonly id: string;
  readonly kind: AlertKind;
  readonly subjectKey: string;
  /** Best camera/selection target when known. */
  readonly nodeId?: string;
  readonly label?: string;
  readonly at: number;
  /** Level for intensity-aware kinds (booth pending count). */
  readonly level?: number;
}

/**
 * Live presence signal — not yet an edge. Wire builds these each frame from
 * rollups / chat / herdr / snapshots / kernel orphans.
 */
export interface AlertSignal {
  readonly id: string;
  readonly kind: AlertKind;
  readonly subjectKey: string;
  readonly nodeId?: string;
  readonly label?: string;
  /**
   * Intensity fingerprint. When present, a later observe with a *higher*
   * level re-fires a rising edge (booth pending rises again). Absent →
   * presence-only (appear = rise, disappear = clear).
   */
  readonly level?: number;
}

export interface AlertQueue {
  readonly items: ReadonlyArray<AlertItem>;
  /** Index of the last cycled item; -1 before any cycle. */
  readonly cycleIndex: number;
  /**
   * Last observed fingerprint per signal id after baseline.
   * Presence-only: "1". Level kinds: String(level).
   */
  readonly known: Readonly<Record<string, string>>;
  readonly baselined: boolean;
}

export const emptyAlertQueue = (): AlertQueue => ({
  items: [],
  cycleIndex: -1,
  known: {},
  baselined: false,
});

const fingerprint = (signal: AlertSignal): string =>
  signal.level !== undefined ? String(signal.level) : "1";

const isRise = (prevFp: string | undefined, signal: AlertSignal): boolean => {
  if (prevFp === undefined) return true;
  if (signal.level === undefined) return false;
  const prev = Number(prevFp);
  if (!Number.isFinite(prev)) return true;
  return signal.level > prev;
};

const toItem = (signal: AlertSignal, at: number, prev?: AlertItem): AlertItem => ({
  id: signal.id,
  kind: signal.kind,
  subjectKey: signal.subjectKey,
  nodeId: signal.nodeId ?? prev?.nodeId,
  label: signal.label ?? prev?.label,
  at: prev?.at ?? at,
  level: signal.level,
});

/**
 * Observe current signals. First call baselines (no risen). Later calls emit
 * risen edges only when a subject appears or its level increases. Signals that
 * disappear leave the queue. Steady active signals stay (or re-enter quietly).
 */
export const observeSignals = (
  queue: AlertQueue,
  signals: ReadonlyArray<AlertSignal>,
  now: number = Date.now(),
): { readonly queue: AlertQueue; readonly risen: ReadonlyArray<AlertItem> } => {
  const nextKnown: Record<string, string> = {};
  for (const signal of signals) {
    nextKnown[signal.id] = fingerprint(signal);
  }

  if (!queue.baselined) {
    return {
      queue: {
        items: [],
        cycleIndex: -1,
        known: nextKnown,
        baselined: true,
      },
      risen: [],
    };
  }

  const prevById = new Map(queue.items.map((item) => [item.id, item] as const));
  const risen: AlertItem[] = [];
  const risenIds = new Set<string>();

  for (const signal of signals) {
    if (!isRise(queue.known[signal.id], signal)) continue;
    const item = toItem(signal, now);
    // Fresh rise always stamps `at` to now (toItem would keep prev.at).
    risen.push({ ...item, at: now });
    risenIds.add(signal.id);
  }

  // Prior non-risen items still present, order preserved.
  const priorStable = queue.items
    .filter((item) => nextKnown[item.id] !== undefined && !risenIds.has(item.id))
    .map((item) => {
      const signal = signals.find((s) => s.id === item.id)!;
      return toItem(signal, now, item);
    });

  // Active signals never queued (e.g. baselined-present) — quiet re-entry.
  const priorIds = new Set(priorStable.map((i) => i.id));
  const quiet: AlertItem[] = [];
  for (const signal of signals) {
    if (risenIds.has(signal.id) || priorIds.has(signal.id)) continue;
    quiet.push(toItem(signal, now, prevById.get(signal.id)));
  }

  const ordered = [...priorStable, ...quiet, ...risen];

  const cycleIndex =
    ordered.length === 0
      ? -1
      : queue.cycleIndex >= ordered.length
        ? ordered.length - 1
        : queue.cycleIndex;

  return {
    queue: {
      items: ordered,
      cycleIndex,
      known: nextKnown,
      baselined: true,
    },
    risen,
  };
};

/**
 * Advance to the next alert (wrap). Empty queue → no-op.
 * Returns the focused item so the wire can set state$.focusNodeId + select.
 */
export const cycleNext = (
  queue: AlertQueue,
): { readonly queue: AlertQueue; readonly item: AlertItem | undefined } => {
  if (queue.items.length === 0) {
    return { queue, item: undefined };
  }
  const nextIndex = (queue.cycleIndex + 1) % queue.items.length;
  const item = queue.items[nextIndex];
  return {
    queue: { ...queue, cycleIndex: nextIndex },
    item,
  };
};

/** Focus target for camera/selection — wire may enrich nodeId before enqueue. */
export const resolveFocusNodeId = (item: AlertItem | undefined): string | undefined => {
  if (!item) return undefined;
  const id = item.nodeId?.trim();
  return id ? id : undefined;
};

/** Stable id helpers for the wire layer. */
export const alertId = {
  blocked: (nodeId: string) => `blocked:${nodeId}`,
  permission: (agentKey: string) => `permission:${agentKey}`,
  herdrDone: (nodeId: string) => `herdr-done:${nodeId}`,
  boothReview: (projectKey: string) => `booth-review:${projectKey}`,
  orphan: (key: string) => `orphan:${key}`,
} as const;

/**
 * Parse `canvas::regionId` orphan key → regionId (may be missing on canvas).
 */
export const regionIdFromOrphanKey = (key: string): string | undefined => {
  const idx = key.indexOf("::");
  if (idx < 0) return undefined;
  const regionId = key.slice(idx + 2).trim();
  return regionId || undefined;
};
