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
  ObserverListener,
  ObserverModes,
  ObserverRegionName,
  ObserverSignals,
  SessionObserverOptions,
} from "./types";
export {
  DEFAULT_OBSERVER_WRITE_INTERVAL_MS,
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

  attach(opts: SessionObserverOptions): SessionObserver {
    const prior = this.byBinding.get(opts.bindingId);
    if (prior) {
      prior.dispose();
      this.byBinding.delete(opts.bindingId);
    }
    const observer = new SessionObserver(opts);
    this.byBinding.set(opts.bindingId, observer);
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

  feed(bindingId: string, data: string, seq: bigint): void {
    this.byBinding.get(bindingId)?.feed(data, seq);
  }

  resize(bindingId: string, cols: number, rows: number): void {
    this.byBinding.get(bindingId)?.resize(cols, rows);
  }

  snapshot(bindingId: string): ObserverGridSnapshot | undefined {
    return this.byBinding.get(bindingId)?.snapshotNow();
  }

  /** Settled serialized VT state when a live observer exists. */
  async attachScreen(
    bindingId: string,
  ): Promise<import("./types").AttachScreen | undefined> {
    return this.byBinding.get(bindingId)?.attachScreen();
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
    this.globalListeners.clear();
  }
}

/** Process-singleton used by LocalSessionHost. Tests may construct their own. */
export const terminalObserverPlane = new TerminalObserverPlane();
