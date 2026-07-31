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
  "orphan",
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];

/**
 * Cycle order priority — lower first.
 * Permission/blocked need you now; herdr-done is "waiting on review";
 * orphans are structural.
 */
export const ALERT_KIND_PRIORITY: Readonly<Record<AlertKind, number>> = {
  permission: 0,
  blocked: 1,
  "herdr-done": 2,
  orphan: 4,
};

export const ALERT_KIND_LABEL: Readonly<Record<AlertKind, string>> = {
  permission: "permission",
  blocked: "blocked",
  "herdr-done": "herdr done",
  orphan: "orphan",
};

const compareAlertItems = (a: AlertItem, b: AlertItem): number => {
  const pr = ALERT_KIND_PRIORITY[a.kind] - ALERT_KIND_PRIORITY[b.kind];
  if (pr !== 0) return pr;
  // Within a kind: newest rise first (higher `at`), then stable id.
  if (a.at !== b.at) return b.at - a.at;
  return a.id.localeCompare(b.id);
};

/** Stable queue entry — one per subject (member, agent, project, orphan key). */
export interface AlertItem {
  readonly id: string;
  readonly kind: AlertKind;
  readonly subjectKey: string;
  /** Best camera/selection target when known. */
  readonly nodeId?: string;
  readonly label?: string;
  readonly at: number;
  /** Level for intensity-aware kinds. */
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
   * level re-fires a rising edge when the signal carries a level. Absent →
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

  // Severity order, not collection order — Space should feel intentional.
  const ordered = [...priorStable, ...quiet, ...risen].sort(compareAlertItems);

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

const hasFocusTarget = (item: AlertItem | undefined): boolean =>
  Boolean(item?.nodeId?.trim());

/**
 * Advance to the next *focusable* alert (wrap). Skips items with no nodeId
 * so Space never "ticks" into a dead slot. Empty / all-unfocusable → no-op.
 */
export const cycleNext = (
  queue: AlertQueue,
): { readonly queue: AlertQueue; readonly item: AlertItem | undefined } => {
  if (queue.items.length === 0) {
    return { queue, item: undefined };
  }
  const n = queue.items.length;
  let idx = queue.cycleIndex;
  for (let step = 0; step < n; step += 1) {
    idx = (idx + 1) % n;
    const item = queue.items[idx];
    if (hasFocusTarget(item)) {
      return {
        queue: { ...queue, cycleIndex: idx },
        item,
      };
    }
  }
  return { queue, item: undefined };
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
  /** Managed seat ready/complete (idle+unseen) — same kind priority as herdr-done. */
  agentDone: (nodeId: string) => `agent-done:${nodeId}`,
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
