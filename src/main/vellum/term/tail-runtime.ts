/**
 * Terminal tail runtime — coalesces observer grid snapshots into a small,
 * infrequent broadcast of trailing plain-text lines for node-card preview.
 * Deliberately not wired to the full attach/scrollback path (that's the
 * modal's job); this only ever carries a capped tail.
 */

import type { TerminalTailEvent } from "../../../shared/terminal-tail";
import { terminalObserverPlane } from "./observer";
import type { ObserverGridSnapshot } from "./observer/types";

/** Hard ceiling regardless of how tall a node card grows — never the full buffer. */
export const TERMINAL_TAIL_MAX_LINES = 16;

const COALESCE_MS = 200;

const trimTrailingBlank = (lines: readonly string[]): readonly string[] => {
  let end = lines.length;
  while (end > 0 && lines[end - 1]?.trim() === "") end--;
  return lines.slice(0, end);
};

const sameLines = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((line, i) => line === b[i]);

export type TerminalTailRuntimeOptions = {
  readonly now?: () => number;
  readonly onEvent?: (event: TerminalTailEvent) => void;
};

export class TerminalTailRuntime {
  private readonly now: () => number;
  private readonly onEventCb: ((event: TerminalTailEvent) => void) | undefined;
  private readonly eventListeners = new Set<(event: TerminalTailEvent) => void>();
  private unsubObserver: (() => void) | undefined;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastSent = new Map<string, readonly string[]>();
  private readonly pending = new Map<string, ObserverGridSnapshot>();

  constructor(opts: TerminalTailRuntimeOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.onEventCb = opts.onEvent;
  }

  start(): void {
    if (this.unsubObserver) return;
    this.unsubObserver = terminalObserverPlane.subscribeAll((snap) => {
      this.onSnapshot(snap);
    });
  }

  stop(): void {
    this.unsubObserver?.();
    this.unsubObserver = undefined;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
    this.lastSent.clear();
    this.eventListeners.clear();
  }

  subscribe(listener: (event: TerminalTailEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  private onSnapshot(snap: ObserverGridSnapshot): void {
    this.pending.set(snap.bindingId, snap);
    if (this.timers.has(snap.bindingId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(snap.bindingId);
      this.flush(snap.bindingId);
    }, COALESCE_MS);
    this.timers.set(snap.bindingId, timer);
  }

  private flush(bindingId: string): void {
    const snap = this.pending.get(bindingId);
    this.pending.delete(bindingId);
    if (!snap) return;
    const trimmed = trimTrailingBlank(snap.lines).slice(-TERMINAL_TAIL_MAX_LINES);
    const prior = this.lastSent.get(bindingId) ?? [];
    if (sameLines(trimmed, prior)) return;
    this.lastSent.set(bindingId, trimmed);
    const event: TerminalTailEvent = {
      bindingId,
      epoch: snap.epoch,
      lines: trimmed,
      at: this.now(),
    };
    this.onEventCb?.(event);
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[term-tail] event listener failed:", err);
      }
    }
  }
}

/** Process singleton used by main IPC boot. Tests construct their own. */
export const terminalTailRuntime = new TerminalTailRuntime();
