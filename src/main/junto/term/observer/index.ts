/**
 * Terminal observer plane — one headless grid per live local session.
 * LocalSessionHost is the only writer; consumers subscribe for snapshots.
 */

import { SessionObserver } from "./session-observer";
import type {
  ObserverGridSnapshot,
  ObserverListener,
  SessionObserverOptions,
} from "./types";

export type {
  AttachScreen,
  ObserverGridSnapshot,
  ObserverGridWindow,
  ObserverListener,
  ObserverModes,
  ObserverRegionName,
  ObserverSignals,
  SessionObserverOptions,
} from "./types";
export {
  DEFAULT_OBSERVER_WRITE_INTERVAL_MS,
  OBSERVER_UNWATCHED_SCROLLBACK,
  OBSERVER_WATCHED_SCROLLBACK,
  SessionObserver,
  getObserverWriteIntervalMs,
  setObserverWriteIntervalMs,
} from "./session-observer";
export { sanitizeTitle } from "./sanitize";
export {
  afterLastHorizontalRule,
  bottomNonEmptyLines,
  extractRegion,
  footerLine,
  isHorizontalRule,
  promptBoxBody,
  abovePromptBox,
} from "./regions";

export class TerminalObserverPlane {
  private readonly byBinding = new Map<string, SessionObserver>();
  private readonly globalListeners = new Set<ObserverListener>();
  /**
   * Attached surfaces per binding, kept on the plane rather than the observer
   * so a replacement generation (resume, respawn) inherits the tier a lease
   * already bought. The lease outlives the epoch; the grid does not.
   */
  private readonly surfacesByBinding = new Map<string, number>();

  attach(opts: SessionObserverOptions): SessionObserver {
    const prior = this.byBinding.get(opts.bindingId);
    if (prior) {
      prior.dispose();
      this.byBinding.delete(opts.bindingId);
    }
    const observer = new SessionObserver(opts);
    this.byBinding.set(opts.bindingId, observer);
    for (let i = this.surfacesByBinding.get(opts.bindingId) ?? 0; i > 0; i--) {
      observer.retainSurface();
    }
    // Always bridge — globalListeners may be empty at attach and filled later.
    observer.subscribe((snap) => {
      for (const listener of this.globalListeners) {
        try {
          listener(snap);
        } catch (err) {
          console.error("[term-observer] global listener failed:", err);
        }
      }
    });
    return observer;
  }

  /** Register a global snapshot listener (supervisor, diagnostics). */
  subscribeGlobal(listener: ObserverListener): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  detach(bindingId: string, epoch?: string): void {
    const obs = this.byBinding.get(bindingId);
    if (!obs) return;
    if (epoch !== undefined && obs.epoch !== epoch) return;
    obs.dispose();
    this.byBinding.delete(bindingId);
  }

  get(bindingId: string): SessionObserver | undefined {
    return this.byBinding.get(bindingId);
  }

  /**
   * A surface started painting this binding — hold the full scrollback while
   * it does. Refcounted, and recorded even when no observer is live yet so a
   * later generation starts in the right tier.
   */
  retainSurface(bindingId: string): void {
    this.surfacesByBinding.set(
      bindingId,
      (this.surfacesByBinding.get(bindingId) ?? 0) + 1,
    );
    this.byBinding.get(bindingId)?.retainSurface();
  }

  /** A surface stopped painting. At zero the bounded window comes back. */
  releaseSurface(bindingId: string): void {
    const prior = this.surfacesByBinding.get(bindingId) ?? 0;
    if (prior <= 0) return;
    if (prior === 1) this.surfacesByBinding.delete(bindingId);
    else this.surfacesByBinding.set(bindingId, prior - 1);
    this.byBinding.get(bindingId)?.releaseSurface();
  }

  /** Attached surfaces for a binding, across generations. */
  surfaceCount(bindingId: string): number {
    return this.surfacesByBinding.get(bindingId) ?? 0;
  }

  feed(bindingId: string, data: string, seq: bigint): void {
    this.byBinding.get(bindingId)?.feed(data, seq);
  }

  resize(bindingId: string, cols: number, rows: number): void {
    this.byBinding.get(bindingId)?.resize(cols, rows);
  }

  snapshot(bindingId: string): ObserverGridSnapshot | undefined {
    return this.byBinding.get(bindingId)?.snapshotNow();
  }

  /**
   * Whether `snapshot(bindingId)` currently reflects every byte fed. Undefined
   * when no observer is live for the binding.
   */
  isSettled(bindingId: string): boolean | undefined {
    return this.byBinding.get(bindingId)?.isSettled();
  }

  /** Settled serialized VT state when a live observer exists. */
  async attachScreen(
    bindingId: string,
  ): Promise<import("./types").AttachScreen | undefined> {
    return this.byBinding.get(bindingId)?.attachScreen();
  }

  /**
   * Settled read-only window for a binding, or undefined when no observer is
   * live for it — a seat with no grid has nothing to observe.
   *
   * The observer is re-resolved after the await: a replacement generation
   * (resume, respawn) can detach and re-attach this binding while the read is
   * in flight, and answering with the detached observer's epoch would pair an
   * old generation's screen with the new generation's session. Bounded retry,
   * because a replacement is a one-shot event and the caller is always under
   * its own deadline.
   */
  async readWindow(
    bindingId: string,
    lines: number,
  ): Promise<import("./types").ObserverGridWindow | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const observer = this.byBinding.get(bindingId);
      if (observer === undefined) return undefined;
      const window = await observer.readWindow(lines);
      if (this.byBinding.get(bindingId) === observer) return window;
    }
    // Still churning after three reads: return the newest coherent window
    // (it carries its own epoch), and let the caller see the generation it
    // actually came from rather than inventing one.
    return this.byBinding.get(bindingId)?.readWindow(lines);
  }

  /**
   * Sync, non-flushing form of `readWindow` for background analysis.
   *
   * A sync read cannot interleave with a detach, so the single lookup is
   * atomic and no retry loop is needed; the returned window carries its own
   * epoch, so a caller that outlives the generation can still see which one it
   * read. The seat-awareness scheduler reads through this and never through
   * `readWindow`, which awaits settlement.
   */
  readWindowNow(
    bindingId: string,
    lines: number,
  ): import("./types").ObserverGridWindow | undefined {
    return this.byBinding.get(bindingId)?.readWindowNow(lines);
  }

  subscribeAll(listener: ObserverListener): () => void {
    this.globalListeners.add(listener);
    // A live PTY may have emitted its only readiness screen before a
    // downstream runtime finished booting. Subscriptions are therefore
    // current-state observations, not future-edge-only notifications.
    for (const observer of this.byBinding.values()) {
      try {
        listener(observer.snapshotNow());
      } catch (err) {
        console.error("[term-observer] global listener replay failed:", err);
      }
    }
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  disposeAll(): void {
    for (const obs of this.byBinding.values()) {
      obs.dispose();
    }
    this.byBinding.clear();
    this.surfacesByBinding.clear();
    this.globalListeners.clear();
  }
}

/** Process-singleton used by LocalSessionHost. Tests may construct their own. */
export const terminalObserverPlane = new TerminalObserverPlane();
