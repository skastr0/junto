/**
 * Managed-terminal drive — state-gated typing transport for agent seats.
 *
 * Owns: paste+CR recipe, idle gate, mid-turn queue, interrupt spacing, stall retry.
 * Does not own: PTY leases, seat state machine (injected lookups).
 *
 * Fail-closed: not idle → queue (bounded); never hang forever on the pulse path.
 */

import {
  buildPromptWriteSequence,
  canSendIdleInterrupt,
  DEFAULT_PROMPT_STALL_MS,
  INTERRUPT_BYTE,
  MIN_IDLE_INTERRUPT_GAP_MS,
} from "./typing";

/** Returns true when the managed seat may accept a typed prompt. */
export type SeatIdleLookup = (bindingId: string) => boolean;

/**
 * Write raw bytes to a managed terminal PTY.
 * Synchronous or async; false = write refused (no lease / dead session).
 */
export type TerminalWriter = (
  bindingId: string,
  data: string,
) => boolean | Promise<boolean>;

export type DriveAttentionReason =
  | "clipboard-unsafe"
  | "prompt-stalled"
  | "write-failed"
  | "not-ready"
  | "queue-timeout";

/** Default max wait for a mid-turn queued prompt before resolving false. */
export const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;

export type DriveAttentionCallback = (
  bindingId: string,
  reason: DriveAttentionReason,
) => void;

/**
 * Optional Grok preflight: return false when the clipboard holds an image
 * (or otherwise unsafe paste surface). Drive aborts to attention and does
 * NOT clear the operator's clipboard.
 */
export type ClipboardSafeAssert = () => boolean | Promise<boolean>;

export type WritePromptOptions = {
  /**
   * Positive UI readiness (not a quiet-gap). When false, abort to attention
   * without writing — Hermes install window swallows Ctrl+C and kills the session.
   * Default true when omitted (caller responsibility to pass false when unready).
   */
  readonly ready?: boolean;
  /** Override queue wait when seat is busy (default DEFAULT_QUEUE_TIMEOUT_MS). */
  readonly queueTimeoutMs?: number;
};

type QueuedPrompt = {
  readonly text: string;
  readonly resolve: (ok: boolean) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

export type ManagedTerminalDriveOptions = {
  readonly write: TerminalWriter;
  readonly isSeatIdle: SeatIdleLookup;
  readonly onAttention?: DriveAttentionCallback;
  readonly assertClipboardSafe?: ClipboardSafeAssert;
  readonly now?: () => number;
  readonly stallTimeoutMs?: number;
  readonly idleInterruptGapMs?: number;
  readonly queueTimeoutMs?: number;
  /**
   * When true (default), after paste+CR arm a stall watch: no onTurnStart
   * within stallTimeoutMs → retry once → attention.
   */
  readonly stallWatch?: boolean;
};

export class ManagedTerminalDrive {
  private readonly writeFn: TerminalWriter;
  private readonly isSeatIdle: SeatIdleLookup;
  private readonly onAttention: DriveAttentionCallback | undefined;
  private readonly assertClipboardSafe: ClipboardSafeAssert | undefined;
  private readonly now: () => number;
  private readonly stallTimeoutMs: number;
  private readonly idleInterruptGapMs: number;
  private readonly queueTimeoutMs: number;
  private readonly stallWatch: boolean;

  private readonly queues = new Map<string, QueuedPrompt[]>();
  private readonly writing = new Set<string>();
  private readonly lastIdleInterruptAt = new Map<string, number>();
  private readonly stallTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly stallRetried = new Set<string>();
  private readonly awaitingTurn = new Set<string>();

  constructor(options: ManagedTerminalDriveOptions) {
    this.writeFn = options.write;
    this.isSeatIdle = options.isSeatIdle;
    this.onAttention = options.onAttention;
    this.assertClipboardSafe = options.assertClipboardSafe;
    this.now = options.now ?? (() => Date.now());
    this.stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_PROMPT_STALL_MS;
    this.idleInterruptGapMs = options.idleInterruptGapMs ?? MIN_IDLE_INTERRUPT_GAP_MS;
    this.queueTimeoutMs = options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
    this.stallWatch = options.stallWatch ?? true;
  }

  /**
   * Deliver one submitted prompt when idle. Queues when the seat is busy;
   * promise resolves when the write lands, fails, or queue times out.
   * Returns false immediately for not-ready / clipboard-unsafe / write fail.
   */
  async writePrompt(
    bindingId: string,
    text: string,
    opts: WritePromptOptions = {},
  ): Promise<boolean> {
    const ready = opts.ready ?? true;
    if (!ready) {
      this.onAttention?.(bindingId, "not-ready");
      return false;
    }

    if (this.assertClipboardSafe) {
      let safe = false;
      try {
        safe = await Promise.resolve(this.assertClipboardSafe());
      } catch {
        safe = false;
      }
      if (!safe) {
        this.onAttention?.(bindingId, "clipboard-unsafe");
        return false;
      }
    }

    if (!this.isSeatIdle(bindingId) || this.writing.has(bindingId)) {
      const timeoutMs = opts.queueTimeoutMs ?? this.queueTimeoutMs;
      return new Promise<boolean>((resolve) => {
        const entry: QueuedPrompt = {
          text,
          resolve: (ok) => {
            if (entry.timer !== undefined) clearTimeout(entry.timer);
            entry.timer = undefined;
            resolve(ok);
          },
          timer: undefined,
        };
        entry.timer = setTimeout(() => {
          entry.timer = undefined;
          // Drop this entry from the queue if still waiting.
          const q = this.queues.get(bindingId);
          if (q) {
            const idx = q.indexOf(entry);
            if (idx >= 0) {
              q.splice(idx, 1);
              if (q.length === 0) this.queues.delete(bindingId);
              else this.queues.set(bindingId, q);
            }
          }
          this.onAttention?.(bindingId, "queue-timeout");
          resolve(false);
        }, timeoutMs);
        entry.timer.unref?.();
        const q = this.queues.get(bindingId) ?? [];
        q.push(entry);
        this.queues.set(bindingId, q);
      });
    }

    return this.executePrompt(bindingId, text);
  }

  /**
   * Interrupt the seat with Ctrl+C (0x03).
   * Mid-turn: always allowed. Idle: enforces min gap between consecutive 0x03.
   */
  async interrupt(bindingId: string): Promise<boolean> {
    const idle = this.isSeatIdle(bindingId);
    const now = this.now();
    if (
      idle &&
      !canSendIdleInterrupt(
        this.lastIdleInterruptAt.get(bindingId),
        now,
        this.idleInterruptGapMs,
      )
    ) {
      return false;
    }
    const ok = await Promise.resolve(this.writeFn(bindingId, INTERRUPT_BYTE));
    if (ok && idle) {
      this.lastIdleInterruptAt.set(bindingId, now);
    }
    return ok;
  }

  /**
   * Seat became idle — drain at most one queued prompt (one turn at a time).
   * Phase 2 state machine calls this on working→idle.
   */
  onSeatIdle(bindingId: string): void {
    void this.drainOne(bindingId);
  }

  /**
   * Turn-start ack (title flip, hook event, OSC). Clears stall watch for the seat.
   */
  onTurnStart(bindingId: string): void {
    this.awaitingTurn.delete(bindingId);
    this.stallRetried.delete(bindingId);
    const timer = this.stallTimers.get(bindingId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.stallTimers.delete(bindingId);
    }
  }

  /** Test / shutdown seam — drop queues and timers. */
  resetForTest(): void {
    for (const timer of this.stallTimers.values()) clearTimeout(timer);
    this.stallTimers.clear();
    for (const q of this.queues.values()) {
      for (const item of q) {
        if (item.timer !== undefined) clearTimeout(item.timer);
        item.resolve(false);
      }
    }
    this.queues.clear();
    this.writing.clear();
    this.lastIdleInterruptAt.clear();
    this.stallRetried.clear();
    this.awaitingTurn.clear();
  }

  /** Queued prompt count for one binding (tests / diagnostics). */
  queuedCount(bindingId: string): number {
    return this.queues.get(bindingId)?.length ?? 0;
  }

  private async drainOne(bindingId: string): Promise<void> {
    if (!this.isSeatIdle(bindingId) || this.writing.has(bindingId)) return;
    const q = this.queues.get(bindingId);
    if (!q || q.length === 0) return;
    const next = q.shift()!;
    if (q.length === 0) this.queues.delete(bindingId);
    else this.queues.set(bindingId, q);
    const ok = await this.executePrompt(bindingId, next.text);
    next.resolve(ok);
  }

  private async executePrompt(bindingId: string, text: string): Promise<boolean> {
    this.writing.add(bindingId);
    try {
      const ok = await this.writePasteAndCr(bindingId, text);
      if (!ok) {
        this.onAttention?.(bindingId, "write-failed");
        return false;
      }
      if (this.stallWatch) this.armStallWatch(bindingId, text);
      return true;
    } finally {
      this.writing.delete(bindingId);
    }
  }

  private async writePasteAndCr(bindingId: string, text: string): Promise<boolean> {
    const [paste, cr] = buildPromptWriteSequence(text);
    // ONE write for the full paste envelope…
    if (!(await Promise.resolve(this.writeFn(bindingId, paste)))) return false;
    // …then a SEPARATE CR write. Never join; never LF.
    if (!(await Promise.resolve(this.writeFn(bindingId, cr)))) return false;
    return true;
  }

  private armStallWatch(bindingId: string, text: string): void {
    const prior = this.stallTimers.get(bindingId);
    if (prior !== undefined) clearTimeout(prior);
    this.awaitingTurn.add(bindingId);
    const timer = setTimeout(() => {
      this.stallTimers.delete(bindingId);
      if (!this.awaitingTurn.has(bindingId)) return;
      if (!this.stallRetried.has(bindingId)) {
        this.stallRetried.add(bindingId);
        void this.writePasteAndCr(bindingId, text).then((ok) => {
          if (!ok) {
            this.onAttention?.(bindingId, "write-failed");
            this.awaitingTurn.delete(bindingId);
            return;
          }
          this.armStallWatch(bindingId, text);
        });
        return;
      }
      this.awaitingTurn.delete(bindingId);
      this.stallRetried.delete(bindingId);
      this.onAttention?.(bindingId, "prompt-stalled");
    }, this.stallTimeoutMs);
    this.stallTimers.set(bindingId, timer);
  }
}
