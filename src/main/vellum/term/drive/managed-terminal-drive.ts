/**
 * Managed-terminal drive — state-gated typing transport for agent seats.
 *
 * Owns: paste+CR recipe, idle gate, mid-turn queue, interrupt spacing, turn-start acknowledgement.
 * Does not own: PTY leases, seat state machine (injected lookups).
 *
 * Fail-closed: not idle → bounded queue or immediate refusal by caller policy.
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
export type ClipboardSafeAssert = (
  bindingId: string,
) => boolean | Promise<boolean>;

export type WritePromptOptions = {
  /**
   * Positive UI readiness (not a quiet-gap). When false, abort to attention
   * without writing — Hermes install window swallows Ctrl+C and kills the session.
   * Default true when omitted (caller responsibility to pass false when unready).
   */
  readonly ready?: boolean;
  /** Override queue wait when seat is busy (default DEFAULT_QUEUE_TIMEOUT_MS). */
  readonly queueTimeoutMs?: number;
  /**
   * Whether a busy/not-yet-writeable seat may retain the raw prompt for a
   * later idle transition. Scheduled kernel pulses set false so their source
   * identity stays in the kernel and every retry re-checks current edges.
   * Defaults true for operator-authored and work-message prompts.
   */
  readonly queueIfBusy?: boolean;
  /**
   * Earliest epoch-ms at which paste is allowed (Grok ≥1.5s post-spawn).
   * When now < readyAfterMs, wait only when queueIfBusy permits retention.
   */
  readonly readyAfterMs?: number;
};

/** Grok TUI trap: paste before ~1.5s post-spawn is swallowed. */
export const GROK_MIN_POST_SPAWN_MS = 1_500;

type QueuedPrompt = {
  readonly text: string;
  readonly resolve: (ok: boolean) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

type PendingTurn = {
  readonly generation: number;
  readonly bindingGeneration: number;
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
   * When true (default), a successful paste+CR is accepted only after
   * onTurnStart. Missing acknowledgement resolves false and raises attention;
   * the drive never retries physical input because a late retry could land
   * mid-turn.
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
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly turnStartCounts = new Map<string, number>();
  /** bindingId → earliest write time (Grok post-spawn, etc.). */
  private readonly readyAfter = new Map<string, number>();
  /** Per-binding generation cut: terminal epoch changes invalidate old writes. */
  private readonly bindingGenerations = new Map<string, number>();
  private suspended = false;
  private lifecycleGeneration = 0;

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

  /** Mark a binding as just spawned — enforces min delay before first paste. */
  markSpawned(bindingId: string, minDelayMs: number = GROK_MIN_POST_SPAWN_MS): void {
    if (this.suspended) return;
    this.readyAfter.set(bindingId, this.now() + Math.max(0, minDelayMs));
  }

  /**
   * Cut all transport state retained for one terminal generation.
   *
   * A binding id is stable across PTY replacement, so queued prompts, an
   * in-flight paste→CR pair, and stall retries must not survive an epoch
   * change and land in the replacement process.
   */
  invalidateBinding(bindingId: string): void {
    this.bindingGenerations.set(
      bindingId,
      (this.bindingGenerations.get(bindingId) ?? 0) + 1,
    );
    this.clearBindingTransientState(bindingId);
  }

  /**
   * Monotonic license-revocation cut.
   *
   * Existing PTY processes and their host generations remain alive. This
   * drive only drops its Vellum-owned write authority: queued text resolves
   * refused, stall retries are canceled, delayed preflight continuations
   * become stale, and no later paste/CR/interrupt reaches the writer.
   */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    this.lifecycleGeneration += 1;
    this.clearTransientState();
  }

  private active(generation: number): boolean {
    return !this.suspended && generation === this.lifecycleGeneration;
  }

  private activeBinding(
    bindingId: string,
    generation: number,
    bindingGeneration: number,
  ): boolean {
    return (
      this.active(generation) &&
      (this.bindingGenerations.get(bindingId) ?? 0) === bindingGeneration
    );
  }

  /**
   * Deliver one submitted prompt when idle. Queues when the seat is busy;
   * With stall watching enabled, the promise resolves true only after an
   * explicit turn-start acknowledgement. It resolves false on write failure,
   * acknowledgement timeout, generation change, shutdown, or queue timeout.
   * Returns false immediately for not-ready / clipboard-unsafe / write fail.
   */
  async writePrompt(
    bindingId: string,
    text: string,
    opts: WritePromptOptions = {},
  ): Promise<boolean> {
    const generation = this.lifecycleGeneration;
    const bindingGeneration = this.bindingGenerations.get(bindingId) ?? 0;
    if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
      return false;
    }
    const ready = opts.ready ?? true;
    const queueIfBusy = opts.queueIfBusy ?? true;
    if (!ready) {
      this.onAttention?.(bindingId, "not-ready");
      return false;
    }

    if (
      !queueIfBusy &&
      (!this.isSeatIdle(bindingId) ||
        this.writing.has(bindingId) ||
        this.pendingTurns.has(bindingId))
    ) {
      return false;
    }

    const readyAfter =
      opts.readyAfterMs ?? this.readyAfter.get(bindingId) ?? 0;
    const waitMs = readyAfter - this.now();
    if (waitMs > 0) {
      // A non-queuing caller retains authorization context outside this
      // transport and will retry later. Never park its raw text in the drive.
      if (!queueIfBusy) return false;
      await new Promise<void>((r) => {
        const t = setTimeout(r, waitMs);
        t.unref?.();
      });
      if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
        return false;
      }
      this.readyAfter.delete(bindingId);
    }

    if (this.assertClipboardSafe) {
      let safe = false;
      try {
        safe = await Promise.resolve(this.assertClipboardSafe(bindingId));
      } catch {
        safe = false;
      }
      if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
        return false;
      }
      if (!safe) {
        this.onAttention?.(bindingId, "clipboard-unsafe");
        return false;
      }
    }

    if (
      !this.isSeatIdle(bindingId) ||
      this.writing.has(bindingId) ||
      this.pendingTurns.has(bindingId)
    ) {
      if (!queueIfBusy) return false;
      const timeoutMs = opts.queueTimeoutMs ?? this.queueTimeoutMs;
      return new Promise<boolean>((resolve) => {
        if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
          resolve(false);
          return;
        }
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
          if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
            resolve(false);
            return;
          }
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

    return this.executePrompt(
      bindingId,
      text,
      generation,
      bindingGeneration,
    );
  }

  /**
   * Interrupt the seat with Ctrl+C (0x03).
   * Mid-turn: always allowed. Idle: enforces min gap between consecutive 0x03.
   */
  async interrupt(bindingId: string): Promise<boolean> {
    const generation = this.lifecycleGeneration;
    const bindingGeneration = this.bindingGenerations.get(bindingId) ?? 0;
    if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
      return false;
    }
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
    if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
      return false;
    }
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
    if (this.suspended) return;
    void this.drainOne(bindingId);
  }

  /**
   * Turn-start ack (title flip, hook event, OSC). Clears stall watch for the seat.
   */
  onTurnStart(bindingId: string): void {
    if (this.suspended) return;
    this.turnStartCounts.set(
      bindingId,
      (this.turnStartCounts.get(bindingId) ?? 0) + 1,
    );
    this.resolvePendingTurn(bindingId, true);
  }

  private clearTransientState(): void {
    for (const [bindingId] of this.pendingTurns) {
      this.resolvePendingTurn(bindingId, false);
    }
    for (const q of this.queues.values()) {
      for (const item of q) {
        if (item.timer !== undefined) clearTimeout(item.timer);
        item.resolve(false);
      }
    }
    this.queues.clear();
    this.writing.clear();
    this.lastIdleInterruptAt.clear();
    this.turnStartCounts.clear();
    this.readyAfter.clear();
    this.bindingGenerations.clear();
  }

  private clearBindingTransientState(bindingId: string): void {
    this.resolvePendingTurn(bindingId, false);
    const queue = this.queues.get(bindingId);
    if (queue !== undefined) {
      this.queues.delete(bindingId);
      for (const item of queue) {
        if (item.timer !== undefined) clearTimeout(item.timer);
        item.resolve(false);
      }
    }
    this.writing.delete(bindingId);
    this.lastIdleInterruptAt.delete(bindingId);
    this.turnStartCounts.delete(bindingId);
    this.readyAfter.delete(bindingId);
  }

  /** Test seam — restore a fresh instance-like admission state. */
  resetForTest(): void {
    this.lifecycleGeneration += 1;
    this.clearTransientState();
    this.suspended = false;
  }

  /** Queued prompt count for one binding (tests / diagnostics). */
  queuedCount(bindingId: string): number {
    return this.queues.get(bindingId)?.length ?? 0;
  }

  private async drainOne(bindingId: string): Promise<void> {
    const generation = this.lifecycleGeneration;
    const bindingGeneration = this.bindingGenerations.get(bindingId) ?? 0;
    if (!this.activeBinding(bindingId, generation, bindingGeneration)) return;
    if (
      !this.isSeatIdle(bindingId) ||
      this.writing.has(bindingId) ||
      this.pendingTurns.has(bindingId)
    ) return;
    const q = this.queues.get(bindingId);
    if (!q || q.length === 0) return;
    const next = q.shift()!;
    if (q.length === 0) this.queues.delete(bindingId);
    else this.queues.set(bindingId, q);
    const ok = await this.executePrompt(
      bindingId,
      next.text,
      generation,
      bindingGeneration,
    );
    next.resolve(ok);
  }

  private async executePrompt(
    bindingId: string,
    text: string,
    generation: number,
    bindingGeneration: number,
  ): Promise<boolean> {
    if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
      return false;
    }
    this.writing.add(bindingId);
    try {
      const turnStartCount = this.turnStartCounts.get(bindingId) ?? 0;
      const ok = await this.writePasteAndCr(
        bindingId,
        text,
        generation,
        bindingGeneration,
      );
      if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
        return false;
      }
      if (!ok) {
        this.onAttention?.(bindingId, "write-failed");
        return false;
      }
      if (this.stallWatch) {
        // Observer delivery can race the CR writer's promise resolution.
        // Preserve a turn-start seen anywhere during the physical sequence.
        if ((this.turnStartCounts.get(bindingId) ?? 0) !== turnStartCount) {
          return true;
        }
        return await this.awaitTurnStart(
          bindingId,
          generation,
          bindingGeneration,
        );
      }
      return true;
    } finally {
      this.writing.delete(bindingId);
    }
  }

  private async writePasteAndCr(
    bindingId: string,
    text: string,
    generation: number,
    bindingGeneration: number,
  ): Promise<boolean> {
    if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
      return false;
    }
    const [paste, cr] = buildPromptWriteSequence(text);
    // ONE write for the full paste envelope…
    if (!(await Promise.resolve(this.writeFn(bindingId, paste)))) return false;
    if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
      return false;
    }
    // …then a SEPARATE CR write. Never join; never LF.
    if (!(await Promise.resolve(this.writeFn(bindingId, cr)))) return false;
    return this.activeBinding(bindingId, generation, bindingGeneration);
  }

  private awaitTurnStart(
    bindingId: string,
    generation: number,
    bindingGeneration: number,
  ): Promise<boolean> {
    if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      const pending: PendingTurn = {
        generation,
        bindingGeneration,
        resolve,
        timer: undefined,
      };
      pending.timer = setTimeout(() => {
        if (this.pendingTurns.get(bindingId) !== pending) return;
        this.pendingTurns.delete(bindingId);
        pending.timer = undefined;
        if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
          resolve(false);
          return;
        }
        this.onAttention?.(bindingId, "prompt-stalled");
        resolve(false);
      }, this.stallTimeoutMs);
      pending.timer.unref?.();
      this.pendingTurns.set(bindingId, pending);
    });
  }

  private resolvePendingTurn(bindingId: string, ok: boolean): void {
    const pending = this.pendingTurns.get(bindingId);
    if (pending === undefined) return;
    this.pendingTurns.delete(bindingId);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.timer = undefined;
    pending.resolve(
      ok &&
        this.activeBinding(
          bindingId,
          pending.generation,
          pending.bindingGeneration,
        ),
    );
  }
}
