/**
 * Awareness runtime — the observer-plane edge of the advisory sidecar.
 *
 * Authority: read-only and advisory. This file subscribes downstream of the
 * terminal observer plane, retains the newest settled snapshot reference per
 * seat, and hands bounded background work to the scheduler. It cannot import or
 * call LocalSessionHost, SeatStateMachine, evaluate(), the composer verdict, the
 * drive modules, the canvas service, or process capabilities, and it never
 * acknowledges a delivery, clears a stall, marks a seat seen, or authors canvas
 * state.
 *
 * Hot path: observer listeners run synchronously inside the grid writer, so the
 * listener here does exactly two things — store the newest snapshot reference
 * and schedule one station-wide flush. No network, no hashing, no
 * serialization, no projection, and no `readWindow()` (which would force grid
 * settlement). Added latency on the deterministic path is zero; nothing here is
 * ever awaited by the plane.
 *
 * The evidence window the projection sees is the settled viewport the observer
 * already emitted, never the retained scrollback: a scrollback read calls
 * `settled()` and would pull the writer forward.
 *
 * Fail-open: provider failure shows deterministic status plus an honest
 * `unavailable` or `stale` enrichment. Terminal startup, automation, and
 * occupancy never wait on awareness.
 */

import { Context, Effect, Layer } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import type { ObserverGridSnapshot, ObserverGridWindow, ObserverListener } from "../observer";
import { MAX_EVIDENCE_CANDIDATE_LINES } from "./questions";
import type { AwarenessEvidenceWindow } from "./select-input";
import {
  AwarenessScheduler,
  defaultAwarenessTimers,
  makeAwarenessSchedulerLive,
  type AwarenessAdvisory,
  type AwarenessSchedulerLiveOptions,
  type AwarenessSchedulerShape,
  type AwarenessSchedulerStats,
} from "./scheduler";
import { makeAwarenessModelLive, type JevClientOptions } from "./jev-client";

/**
 * How many retained lines one observation may consider. C's candidate cap is the
 * bound; asking for more would be clipped anyway.
 */
export const AWARENESS_WINDOW_LINES = MAX_EVIDENCE_CANDIDATE_LINES;

/**
 * The only observer surface awareness may hold: subscribe for snapshots, and
 * read a non-flushing window when a hover needs a screen it has not seen.
 *
 * `readWindowNow` is the sync, non-flushing read. `readWindow` awaits
 * `settled()`, which deliberately bypasses the sampling floor, so a periodic
 * analysis read through it would turn into a parser scheduling change.
 */
export type AwarenessObservationPlane = {
  readonly subscribeAll: (listener: ObserverListener) => () => void;
  /** Non-flushing sync read. Never `readWindow()`, which settles the grid. */
  readonly snapshot: (bindingId: string) => ObserverGridSnapshot | undefined;
  /** Non-flushing window read. Never `readWindow()`. */
  readonly readWindowNow: (
    bindingId: string,
    lines: number,
  ) => ObserverGridWindow | undefined;
};

export type AwarenessRuntimeStatus = {
  readonly started: boolean;
  readonly snapshotsRetained: number;
  readonly flushes: number;
  readonly windowReads: number;
  readonly lastFlushMs: number;
  readonly scheduler: AwarenessSchedulerStats;
};

export type AwarenessRuntimeShape = {
  /** Idempotent. Subscribes and replays live seats; never blocks a caller. */
  readonly start: () => void;
  readonly stop: () => void;
  /** A cache hit is not a new assessment: it costs nothing and calls nothing. */
  readonly hover: (bindingId: string) => AwarenessAdvisory;
  readonly advisory: (bindingId: string) => AwarenessAdvisory;
  readonly retire: (bindingId: string) => void;
  readonly reconfigure: () => void;
  readonly subscribe: (listener: (advisory: AwarenessAdvisory) => void) => () => void;
  readonly status: () => AwarenessRuntimeStatus;
  readonly doctor: Effect.Effect<ServiceCheck>;
};

/**
 * effect-foundation style service id: `@junto/AwarenessRuntime` — single
 * definition, no dual Live + `.layer` export.
 */
export class AwarenessRuntime extends Context.Service<AwarenessRuntime, AwarenessRuntimeShape>()(
  "@junto/AwarenessRuntime",
) {}

export type AwarenessRuntimeOptions = AwarenessSchedulerLiveOptions & {
  readonly plane: AwarenessObservationPlane;
};

export const makeAwarenessRuntime = (
  options: AwarenessRuntimeOptions & { readonly scheduler: AwarenessSchedulerShape },
): AwarenessRuntimeShape => {
  const { plane, scheduler } = options;
  const timers = options.timers ?? defaultAwarenessTimers;
  const clock = options.clock ?? Date.now;
  const monotonic =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? () => performance.now()
      : () => clock();

  /** Newest settled snapshot per seat. Reference only: never copied here. */
  const latest = new Map<string, ObserverGridSnapshot>();
  /** Grid sequence already delivered per seat, so a repaint costs no read. */
  const lastWindowSeq = new Map<string, bigint>();
  /** Every binding this runtime has observed, so stop() can retire them all. */
  const known = new Set<string>();
  const listeners = new Set<(advisory: AwarenessAdvisory) => void>();
  let flushTimer: unknown;
  let unsubscribePlane: (() => void) | undefined;
  let unsubscribeScheduler: (() => void) | undefined;
  let started = false;
  let snapshotsRetained = 0;
  let flushes = 0;
  let lastFlushMs = 0;
  let windowReads = 0;

  /**
   * The non-flushing window for the grid this snapshot names, or undefined when
   * that grid was already delivered: an unchanged sequence cannot have changed
   * the evidence, and re-reading it would be pure cost.
   */
  const windowFor = (snapshot: ObserverGridSnapshot): AwarenessEvidenceWindow | undefined => {
    if (lastWindowSeq.get(snapshot.bindingId) === snapshot.seq) return undefined;
    const window = plane.readWindowNow(snapshot.bindingId, AWARENESS_WINDOW_LINES);
    if (window === undefined) return undefined;
    lastWindowSeq.set(snapshot.bindingId, window.seq);
    windowReads += 1;
    return { ...window, observedAt: clock() };
  };

  const observeSnapshot = (snapshot: ObserverGridSnapshot): void => {
    known.add(snapshot.bindingId);
    scheduler.observe(snapshot, windowFor(snapshot));
  };

  const flush = (): void => {
    if (latest.size === 0) return;
    const startedAt = monotonic();
    const pending = [...latest.values()];
    latest.clear();
    for (const snapshot of pending) {
      try {
        observeSnapshot(snapshot);
      } catch (error) {
        // An advisory plane fault must never reach the observer or the seat.
        console.error("[awareness] observe failed:", error);
      }
    }
    flushes += 1;
    lastFlushMs = monotonic() - startedAt;
  };

  const scheduleFlush = (): void => {
    if (!started || flushTimer !== undefined) return;
    flushTimer = timers.setTimeout(() => {
      flushTimer = undefined;
      flush();
    }, 0);
  };

  /** The synchronous observer-plane callback. Two stores and a flag check. */
  const onSnapshot: ObserverListener = (snapshot) => {
    latest.set(snapshot.bindingId, snapshot);
    snapshotsRetained += 1;
    scheduleFlush();
  };

  const stop = (): void => {
    if (unsubscribePlane !== undefined) {
      unsubscribePlane();
      unsubscribePlane = undefined;
    }
    if (unsubscribeScheduler !== undefined) {
      unsubscribeScheduler();
      unsubscribeScheduler = undefined;
    }
    if (flushTimer !== undefined) {
      timers.clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    for (const bindingId of known) scheduler.retire(bindingId);
    known.clear();
    latest.clear();
    lastWindowSeq.clear();
    started = false;
  };

  return {
    start: () => {
      if (started) return;
      started = true;
      unsubscribeScheduler = scheduler.subscribe((advisory) => {
        for (const listener of listeners) {
          try {
            listener(advisory);
          } catch (error) {
            console.error("[awareness] runtime listener failed:", error);
          }
        }
      });
      // `subscribeAll` replays every live seat, so a seat that painted its only
      // readiness screen before this runtime booted is still observed.
      unsubscribePlane = plane.subscribeAll(onSnapshot);
    },
    stop,
    hover: (bindingId) => {
      if (latest.has(bindingId)) {
        flush();
        return scheduler.hover(bindingId);
      }
      // Non-flushing: a hover must not force grid settlement behind the seat's
      // own writer.
      const snapshot = plane.snapshot(bindingId);
      if (snapshot !== undefined) {
        latest.set(bindingId, snapshot);
        flush();
      }
      return scheduler.hover(bindingId);
    },
    advisory: (bindingId) => scheduler.advisory(bindingId),
    retire: (bindingId) => {
      latest.delete(bindingId);
      known.delete(bindingId);
      lastWindowSeq.delete(bindingId);
      scheduler.retire(bindingId);
    },
    reconfigure: () => scheduler.reconfigure(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    status: () => ({
      started,
      snapshotsRetained,
      flushes,
      windowReads,
      lastFlushMs,
      scheduler: scheduler.stats(),
    }),
    doctor: Effect.sync((): ServiceCheck => {
      const stats = scheduler.stats();
      if (!started) {
        return {
          id: "awareness",
          label: "Seat Awareness",
          status: "unknown" as const,
          detail: "advisory sidecar not started",
        };
      }
      if (!stats.enabled) {
        return {
          id: "awareness",
          label: "Seat Awareness",
          status: "ok" as const,
          detail: "disabled until a Jev API key is explicitly enrolled",
        };
      }
      if (stats.credentialBlocked) {
        return {
          id: "awareness",
          label: "Seat Awareness",
          status: "error" as const,
          detail: "Jev rejected the configured credential; advisory calls stopped",
        };
      }
      if (stats.breakerOpen) {
        return {
          id: "awareness",
          label: "Seat Awareness",
          status: "warning" as const,
          detail: `Jev transport circuit breaker open; ${stats.calls} calls this session`,
        };
      }
      return {
        id: "awareness",
        label: "Seat Awareness",
        status: "ok" as const,
        detail: `${stats.model}: ${stats.calls} calls, ${stats.inputTokens} input tokens, ${stats.cacheHits} cache hits, ${stats.seats} seats`,
      };
    }),
  };
};

export const makeAwarenessRuntimeLive = (
  options: AwarenessRuntimeOptions,
): Layer.Layer<AwarenessRuntime, never, AwarenessScheduler> =>
  Layer.effect(
    AwarenessRuntime,
    Effect.gen(function* () {
      const scheduler = yield* AwarenessScheduler;
      const runtime = makeAwarenessRuntime({ ...options, scheduler });
      yield* Effect.addFinalizer(() => Effect.sync(() => runtime.stop()));
      return AwarenessRuntime.of(runtime);
    }),
  );

/**
 * Full composition: model (SDK adapter) -> scheduler (policy) -> runtime
 * (observer edge). A missing key yields a disabled model, so the runtime still
 * runs and reports `disabled` rather than failing to wire.
 */
export const makeAwarenessLayer = (
  options: AwarenessRuntimeOptions & { readonly model: JevClientOptions },
): Layer.Layer<AwarenessRuntime> => {
  const scheduler = makeAwarenessSchedulerLive(options).pipe(
    Layer.provide(makeAwarenessModelLive(options.model)),
  );
  return makeAwarenessRuntimeLive(options).pipe(Layer.provide(scheduler));
};
