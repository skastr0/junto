import type { TerminalSessionSummary } from "@shared/terminal";
import { getVellumCommandApi } from "./vellum-api";

type SessionListener = (session: TerminalSessionSummary | undefined) => void;

/** Backstop cadence — the same 2500ms the per-card intervals used. */
const POLL_MS = 2500;
/**
 * Circuit breaker: a host whose batch read keeps failing drops to a 60s
 * cadence instead of being retried every 2.5s forever. Mirrors the
 * meta poller's degraded tier. One unreachable Station must not charge the
 * canvas an IPC + host-activation attempt every tick indefinitely.
 */
const DEGRADED_POLL_MS = 60_000;
/** One blip is not a degraded host; two consecutive ones are. */
const DEGRADE_AFTER_FAILURES = 2;

/** Cards on one host share a single batch read. */
type HostSlot = {
  /** Exactly as the card supplied it — `undefined` means the local host. */
  readonly hostId: string | undefined;
  readonly listenersByBindingId: Map<string, Set<SessionListener>>;
  /** Consecutive batch failures; reset by any success (half-open probe). */
  failures: number;
  lastAt: number;
  /**
   * A slow host must not pile up overlapping batch reads, and must not hold
   * up any other host — every host's read is its own promise, never awaited
   * in a shared loop.
   */
  inflight: boolean;
};

const hosts = new Map<string, HostSlot>();
let pollTimer: ReturnType<typeof setInterval> | undefined;

/**
 * `undefined` host is the local host. The prefix keeps that key from ever
 * colliding with a real host id, including an empty one.
 */
const keyOf = (hostId: string | undefined): string =>
  hostId === undefined ? "default" : `id:${hostId}`;

const deliver = (
  listener: SessionListener,
  session: TerminalSessionSummary | undefined,
): void => {
  try {
    listener(session);
  } catch {
    // One card must not interrupt delivery to the others.
  }
};

/**
 * Index the batch by binding, then hand each registered card its own row.
 * Keyed lookup, so a tick costs one pass over the reply plus O(1) per card
 * rather than a scan per card.
 */
const dispatch = (
  slot: HostSlot,
  sessions: readonly TerminalSessionSummary[],
): void => {
  const byBindingId = new Map<string, TerminalSessionSummary>();
  for (const session of sessions) byBindingId.set(session.bindingId, session);
  // Snapshot: a listener may unregister (or another register) during delivery.
  for (const [bindingId, bucket] of [...slot.listenersByBindingId]) {
    // Absent from the batch is the same fact terminalGet reported as
    // `undefined` — the binding has no live session on this host.
    const session = byBindingId.get(bindingId);
    for (const listener of [...bucket]) deliver(listener, session);
  }
};

const pollHost = async (slot: HostSlot): Promise<void> => {
  const api = getVellumCommandApi();
  // Call through the bridge object rather than a detached reference — the
  // preload surface is free to be method-shaped.
  if (!api?.terminalList) return;
  slot.inflight = true;
  try {
    const sessions = await api.terminalList(slot.hostId);
    slot.failures = 0;
    dispatch(slot, sessions);
  } catch {
    // Never dispatch on failure: publishing `undefined` here would blank
    // every card on the host the moment one batch read timed out.
    slot.failures += 1;
  } finally {
    slot.inflight = false;
  }
};

const tick = (): void => {
  const now = Date.now();
  for (const slot of [...hosts.values()]) {
    if (slot.inflight) continue;
    if (
      slot.failures >= DEGRADE_AFTER_FAILURES &&
      now - slot.lastAt < DEGRADED_POLL_MS
    )
      continue;
    slot.lastAt = now;
    void pollHost(slot);
  }
};

const ensurePollTimer = (): void => {
  if (pollTimer !== undefined || hosts.size === 0) return;
  pollTimer = setInterval(tick, POLL_MS);
};

const stopPollTimerIfEmpty = (): void => {
  if (hosts.size > 0 || pollTimer === undefined) return;
  clearInterval(pollTimer);
  pollTimer = undefined;
};

/**
 * Register a terminal card in the shared session poller.
 *
 * One timer for all registered cards, one `terminalList` batch per host per
 * tick — not a `window.setInterval` + `terminalGet` per card. On the
 * operator's canvas that is 48 concurrent intervals and ~19 IPC round trips a
 * second collapsed to one interval and one round trip every 2.5s, and the
 * cost now scales with the number of hosts rather than the number of cards.
 *
 * This is a backstop only. The primary signal stays the binding-routed
 * `onTerminalEvent` subscription the card already owns; the poll exists
 * because lease-scoped events do not reach cards without an open surface.
 *
 * Grouping is per host rather than one `terminalList("*")` for everything:
 * the `*` handler walks every capable host sequentially inside main, so a
 * single unreachable Station would stall every card on every other host.
 *
 * Returns an unregister that is safe to call twice and only removes this
 * registration — a remount that registers before the old cleanup runs cannot
 * be torn down by it.
 */
export const registerTerminalSessionPoll = (
  bindingId: string,
  hostId: string | undefined,
  listener: SessionListener,
): (() => void) => {
  const key = keyOf(hostId);
  let slot = hosts.get(key);
  if (slot === undefined) {
    slot = {
      hostId,
      listenersByBindingId: new Map(),
      failures: 0,
      lastAt: 0,
      inflight: false,
    };
    hosts.set(key, slot);
  }
  const bucket =
    slot.listenersByBindingId.get(bindingId) ?? new Set<SessionListener>();
  slot.listenersByBindingId.set(bindingId, bucket);
  bucket.add(listener);
  ensurePollTimer();

  const owner = slot;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (!bucket.delete(listener)) return;
    if (
      bucket.size === 0 &&
      owner.listenersByBindingId.get(bindingId) === bucket
    ) {
      owner.listenersByBindingId.delete(bindingId);
    }
    if (owner.listenersByBindingId.size === 0 && hosts.get(key) === owner) {
      hosts.delete(key);
    }
    stopPollTimerIfEmpty();
  };
};

/** Test seam only — the renderer never tears the whole poller down. */
export const __resetTerminalSessionPollForTests = (): void => {
  hosts.clear();
  if (pollTimer !== undefined) clearInterval(pollTimer);
  pollTimer = undefined;
};
