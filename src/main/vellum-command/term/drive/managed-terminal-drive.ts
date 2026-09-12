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
  CR,
  DEFAULT_PROMPT_STALL_MS,
  INTERRUPT_BYTE,
  MIN_IDLE_INTERRUPT_GAP_MS,
  PASTE_TO_CR_SETTLE_MS,
  hermesRefusesMultilinePaste,
  payloadMayChip,
} from "./typing";

/** Returns true when the managed seat may accept a typed prompt. */
export type SeatIdleLookup = (bindingId: string) => boolean;

/** Harness id for a binding — used at the paste boundary (Hermes multiline refuse). */
export type SeatHarnessLookup = (bindingId: string) => string | undefined;

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
  | "composer-unreadable"
  | "queue-timeout"
  | "multiline-refused";

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

/**
 * Optional prompt-pending evidence: does the seat's prompt box STILL hold
 * text this drive pasted (harness chip, marker, or payload head)? Consumed
 * from the terminal observer snapshot through promptStillPending.
 *
 * When configured, acknowledgement becomes evidence-gated:
 *  - onTurnStart only resolves a pending turn while evidence says the text
 *    is GONE (a false-working repaint on an unsubmitted chip must not ack);
 *  - clearFailedSubmit skips the Ctrl+C when evidence says there is nothing
 *    left to clear (the submit landed; only the working repaint is late);
 *  - the awaitTurnStart:false fast path refuses to receipt a prompt whose
 *    text is still in the composer.
 */
export type PromptPendingLookup = (bindingId: string) => boolean;

/**
 * Screen-derived composer verdict (agent-state/composer.ts).
 *
 * An idle seat is NOT a free composer: the agent can be done while the
 * operator is mid-sentence. Pasting there appends to their draft and the CR
 * submits it. The verdict is read from the live grid by each harness's
 * composer probes: "empty" is the ONLY state that authorizes typing; "draft"
 * means visible unsubmitted text sits in the box; null means the probes
 * matched nothing (dialog up, mid-transition, or an ungrounded harness) and
 * typing refuses — an unreadable composer is never a writable one. Queueing
 * callers park until the box is proven clear; non-queueing callers are
 * refused and retry from their own source.
 */
export type ComposerVerdictLookup = (
  bindingId: string,
) => "empty" | "draft" | null;

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
  /**
   * Mailbox-only steering: send one mid-turn interrupt before queueing the
   * prompt. Idle seats are never interrupted. Repeated prompts coalesce until
   * the seat reports idle so a mail burst cannot double-tap Ctrl+C.
   */
  readonly interruptIfBusy?: boolean;
  /**
   * When false, a successful paste+CR resolves true without waiting for
   * onTurnStart. Tier B firstTyped doctrine uses this: harnesses with empty
   * or weak working chrome (Muse) never publish working, so stallWatch would
   * force attention, leave firstTyped armed, and re-paste forever.
   * Defaults to the drive-level stallWatch constructor option.
   */
  readonly awaitTurnStart?: boolean;
};

/** Grok TUI trap: paste before ~1.5s post-spawn is swallowed. */
export const GROK_MIN_POST_SPAWN_MS = 1_500;

type QueuedPrompt = {
  readonly text: string;
  readonly awaitTurnStart: boolean;
  readonly resolve: (ok: boolean) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

type PendingTurn = {
  readonly generation: number;
  readonly bindingGeneration: number;
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
   * When true (default), a successful paste+CR is accepted only after
   * onTurnStart. Missing acknowledgement resolves false and raises attention;
   * the drive never retries physical input because a late retry could land
   * mid-turn.
   */
  readonly stallWatch?: boolean;
  /**
   * Delay after paste-end before the first CR (default PASTE_TO_CR_SETTLE_MS).
   * Tests set 0 so write counts stay paste+CR without fake timers.
   */
  readonly pasteToCrSettleMs?: number;
  /** Evidence-gated acknowledgement (see PromptPendingLookup). */
  readonly pendingText?: PromptPendingLookup;
  /**
   * Composer paste-chip chrome only (`[Pasted text`). Chip-submit CR reads
   * this when set so Codex payload-head leftovers and Grok `[Pasted:Nlines]`
   * footers cannot queue a second turn. Absent → fall back to pendingText
   * (unit tests that only wire pending).
   */
  readonly pasteChip?: PromptPendingLookup;
  /** Composer typing gate (see ComposerVerdictLookup). */
  readonly composerVerdict?: ComposerVerdictLookup;
  /** Binding → harness id. Absent lookup = no Hermes multiline refuse. */
  readonly harnessFor?: SeatHarnessLookup;
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
  private readonly pasteToCrSettleMs: number;
  private readonly pendingText: PromptPendingLookup | undefined;
  private readonly pasteChip: PromptPendingLookup | undefined;
  private readonly composerVerdict: ComposerVerdictLookup | undefined;
  private readonly harnessFor: SeatHarnessLookup | undefined;

  private readonly queues = new Map<string, QueuedPrompt[]>();
  private readonly writing = new Set<string>();
  private readonly lastIdleInterruptAt = new Map<string, number>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly turnStartCounts = new Map<string, number>();
  private readonly compactNoopCounts = new Map<string, number>();
  /** bindingId → earliest write time (Grok post-spawn, etc.). */
  private readonly readyAfter = new Map<string, number>();
  /** Per-binding generation cut: terminal epoch changes invalidate old writes. */
  private readonly bindingGenerations = new Map<string, number>();
  /** One mailbox interrupt per busy stretch; cleared at the idle boundary. */
  private readonly mailInterrupts = new Map<string, Promise<boolean>>();
  /**
   * Monotonic count of paste envelopes that actually reached the PTY writer.
   * The delivery layer compares it around a failed attempt: an attempt that
   * wrote NOTHING (refused at a gate or race) must not burn at-most-once
   * bookkeeping that exists to stop re-pasting text already on the PTY.
   */
  private readonly pasteWrites = new Map<string, number>();
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
    this.pasteToCrSettleMs = options.pasteToCrSettleMs ?? PASTE_TO_CR_SETTLE_MS;
    this.pendingText = options.pendingText;
    this.pasteChip = options.pasteChip;
    this.composerVerdict = options.composerVerdict;
    this.harnessFor = options.harnessFor;
  }

  /** Hermes never receives a multiline paste — chip never collapses on CR. */
  private refuseHermesMultiline(bindingId: string, text: string): boolean {
    if (!hermesRefusesMultilinePaste(this.harnessFor?.(bindingId), text)) {
      return false;
    }
    this.onAttention?.(bindingId, "multiline-refused");
    return true;
  }

  /**
   * True while a factory write must wait: the agent is mid-turn, a write is
   * already in flight, a turn is pending acknowledgement, or — the operator
   * case this gate exists for — the screen does not prove an empty composer.
   */
  private mustWait(bindingId: string): boolean {
    return (
      !this.isSeatIdle(bindingId) ||
      this.writing.has(bindingId) ||
      this.pendingTurns.has(bindingId) ||
      this.composerBlocked(bindingId)
    );
  }

  /**
   * Fail closed on the screen: only a proven-empty composer is typeable.
   * "draft" holds for the operator; null holds because the box is unreadable
   * (dialog, transition, ungrounded harness). Absent lookup = test seam.
   */
  private composerBlocked(bindingId: string): boolean {
    if (this.composerVerdict === undefined) return false;
    return this.composerVerdict(bindingId) !== "empty";
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
   * Monotonic shutdown cut for product automation.
   *
   * Existing PTY processes and their host generations remain alive. This
   * drive only drops its Vellum Command-owned write authority: queued text resolves
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
    const awaitTurnStart = opts.awaitTurnStart ?? this.stallWatch;
    if (this.refuseHermesMultiline(bindingId, text)) {
      return false;
    }
    if (!ready) {
      this.onAttention?.(bindingId, "not-ready");
      return false;
    }

    if (!queueIfBusy && this.mustWait(bindingId)) return false;

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

    if (this.mustWait(bindingId)) {
      if (!queueIfBusy) return false;
      if (
        opts.interruptIfBusy &&
        !this.isSeatIdle(bindingId) &&
        // Ctrl+C mid-turn also wipes whatever the operator has typed, so it
        // needs the same proven-empty composer as a paste.
        !this.composerBlocked(bindingId) &&
        !this.mailInterrupts.has(bindingId)
      ) {
        // Reserve the coalescing slot before awaiting the physical write so
        // concurrent mailbox appends cannot issue a second Ctrl+C. Sharing the
        // promise also preserves FIFO queue order across the await boundary.
        this.mailInterrupts.set(bindingId, this.interrupt(bindingId));
      }
      if (
        opts.interruptIfBusy &&
        !this.isSeatIdle(bindingId) &&
        !this.composerBlocked(bindingId)
      ) {
        const interruption = this.mailInterrupts.get(bindingId);
        if (interruption !== undefined) {
          const interrupted = await interruption;
          if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
            return false;
          }
          if (!interrupted) {
            if (this.mailInterrupts.get(bindingId) === interruption) {
              this.mailInterrupts.delete(bindingId);
            }
            return false;
          }
        }
      }
      if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
        return false;
      }
      // The interrupt can make the seat idle before its observer event is
      // delivered. Do not miss that boundary and strand the prompt in a queue
      // that was drained just before this call resumed.
      if (!this.mustWait(bindingId)) {
        return this.executePrompt(
          bindingId,
          text,
          generation,
          bindingGeneration,
          awaitTurnStart,
        );
      }
      const timeoutMs = opts.queueTimeoutMs ?? this.queueTimeoutMs;
      return new Promise<boolean>((resolve) => {
        if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
          resolve(false);
          return;
        }
        const entry: QueuedPrompt = {
          text,
          awaitTurnStart,
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
      awaitTurnStart,
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
    this.mailInterrupts.delete(bindingId);
    void this.drainOne(bindingId);
  }

  /**
   * The operator's prompt box went empty (submitted or cleared). Queued
   * factory prompts waited for exactly this boundary.
   */
  onComposerClear(bindingId: string): void {
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
    if (this.pendingText && this.pendingText(bindingId)) {
      // Evidence: our text is still in the prompt box. A working repaint on
      // an unsubmitted chip is a FALSE turn-start — never receipt it.
      return;
    }
    this.resolvePendingTurn(bindingId, true);
  }

  /** Claude accepted `/compact` but the session was already too fresh to compact. */
  onCompactNoop(bindingId: string): void {
    if (this.suspended) return;
    this.compactNoopCounts.set(
      bindingId,
      (this.compactNoopCounts.get(bindingId) ?? 0) + 1,
    );
    if (this.pendingTurns.get(bindingId)?.text === "/compact") {
      this.resolvePendingTurn(bindingId, true);
    }
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
    this.compactNoopCounts.clear();
    this.readyAfter.clear();
    this.mailInterrupts.clear();
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
    this.mailInterrupts.delete(bindingId);
    this.turnStartCounts.delete(bindingId);
    this.compactNoopCounts.delete(bindingId);
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

  /** Paste envelopes that actually reached the PTY writer (see pasteWrites). */
  pasteWriteCount(bindingId: string): number {
    return this.pasteWrites.get(bindingId) ?? 0;
  }

  private async drainOne(bindingId: string): Promise<void> {
    const generation = this.lifecycleGeneration;
    const bindingGeneration = this.bindingGenerations.get(bindingId) ?? 0;
    if (!this.activeBinding(bindingId, generation, bindingGeneration)) return;
    if (this.mustWait(bindingId)) return;
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
      next.awaitTurnStart,
    );
    next.resolve(ok);
  }

  private async executePrompt(
    bindingId: string,
    text: string,
    generation: number,
    bindingGeneration: number,
    awaitTurnStart: boolean = this.stallWatch,
  ): Promise<boolean> {
    if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
      return false;
    }
    // Re-check idle immediately before paste — observer can flip to dialog
    // after the outer gate and before the physical write.
    if (!this.isSeatIdle(bindingId)) {
      this.onAttention?.(bindingId, "not-ready");
      return false;
    }
    this.writing.add(bindingId);
    try {
      // Second check under the writing lock: still refuse if seat left idle
      // or the composer stopped being provably empty (operator typing burst,
      // dialog repaint). Only BEFORE our own paste — after it, our chip is
      // legitimately in the box.
      if (!this.isSeatIdle(bindingId)) {
        this.onAttention?.(bindingId, "not-ready");
        return false;
      }
      if (this.composerBlocked(bindingId)) {
        this.onAttention?.(
          bindingId,
          this.composerVerdict?.(bindingId) === "draft"
            ? "not-ready"
            : "composer-unreadable",
        );
        return false;
      }
      const turnStartCount = this.turnStartCounts.get(bindingId) ?? 0;
      const compactNoopCount = this.compactNoopCounts.get(bindingId) ?? 0;
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
        if (this.pendingText && this.pendingText(bindingId)) {
          // The paste landed (chip/payload visible) but a later write in the
          // sequence was refused: clear the chip this sequence created so the
          // operator never sees a stuck `[Pasted text #N]` (DRV-4 law).
          await this.clearFailedSubmit(
            bindingId,
            generation,
            bindingGeneration,
          );
        } else {
          this.onAttention?.(bindingId, "write-failed");
        }
        return false;
      }
      // Multiline paste chips on Claude/Devin. The second CR is the submit,
      // not a 5s stall recovery — send it as soon as the composer still
      // holds our text and the seat is idle.
      const sentChipCr = await this.writeChipSubmitCrIfNeeded(
        bindingId,
        text,
        generation,
        bindingGeneration,
      );
      if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
        return false;
      }
      if (awaitTurnStart) {
        // Observer delivery can race the CR writer's promise resolution.
        // Preserve a turn-start seen anywhere during the physical sequence.
        if ((this.turnStartCounts.get(bindingId) ?? 0) !== turnStartCount) {
          return true;
        }
        if (
          text === "/compact" &&
          (this.compactNoopCounts.get(bindingId) ?? 0) !== compactNoopCount
        ) {
          return true;
        }
        const started = await this.awaitTurnStart(
          bindingId,
          text,
          generation,
          bindingGeneration,
        );
        if (started) return true;
        if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
          return false;
        }
        // FIRED-LAW (live duplicate fix): the stall window closed without a
        // turn-start ack, but our text has already LEFT the composer — the
        // paste submitted and only the working repaint is late. That is
        // "Fired" per the product law: resolve TRUE, never clear, never
        // attention, never false. Resolving false here is what made the
        // delivery layer re-paste the same message on every idle (the live
        // 4x duplicate report).
        if (this.pendingText && !this.pendingText(bindingId)) {
          return true;
        }
        // No composer chip: first CR was the submit (Codex/Grok). A leftover
        // payload head on a stale idle grid must not recovery-CR or clear.
        if (this.pasteChip && !this.pasteChip(bindingId)) {
          return true;
        }
        // Evidence was late: the chip CR never fired. One recovery CR, and
        // only while the seat is still idle — never into a working turn.
        if (!sentChipCr && this.isSeatIdle(bindingId) && this.chipVisible(bindingId)) {
          if (
            !(await this.writeSubmitCr(bindingId, generation, bindingGeneration))
          ) {
            await this.clearFailedSubmit(
              bindingId,
              generation,
              bindingGeneration,
            );
            return false;
          }
          if ((this.turnStartCounts.get(bindingId) ?? 0) !== turnStartCount) {
            return true;
          }
          const startedRetry = await this.awaitTurnStart(
            bindingId,
            text,
            generation,
            bindingGeneration,
          );
          if (startedRetry) return true;
          if (this.pendingText && !this.pendingText(bindingId)) {
            return true;
          }
        }
        // Law: never leave Vellum Command-authored text as a stuck paste chip.
        await this.clearFailedSubmit(bindingId, generation, bindingGeneration);
        return false;
      }
      // awaitTurnStart false (firstTyped): never receipt a chip. The
      // observer snapshot on this tick still shows the text we just
      // pasted — wait after the recipe CR before deciding. Multiline
      // chips can paint one frame late: two settles, not one, so a
      // clean first look cannot receipt a chip that arrives on the
      // next paint. Same-tick Ctrl+C would interrupt a submit that
      // has not painted yet (and raise prompt-stalled on doctrine).
      const firstTypedSettles = payloadMayChip(text) ? 2 : 1;
      if (this.pendingText && this.pasteToCrSettleMs > 0) {
        for (let i = 0; i < firstTypedSettles; i += 1) {
          if (!(await this.settle(bindingId, generation, bindingGeneration))) {
            return false;
          }
        }
      }
      if (this.pendingText && this.pendingText(bindingId)) {
        // Snapshot-only leftover (Codex payload head / Grok footer) is not a
        // stuck chip — receipt the firstTyped write; never Ctrl+C.
        if (this.pasteChip && !this.pasteChip(bindingId)) {
          return true;
        }
        if (this.isSeatIdle(bindingId)) {
          await this.clearFailedSubmit(
            bindingId,
            generation,
            bindingGeneration,
          );
        }
        return false;
      }
      return true;
    } finally {
      this.writing.delete(bindingId);
    }
  }

  /**
   * After a failed paste+CR, clear residual composer text so operators never
   * see an opaque `[Pasted text #N]` chip from Vellum Command.
   * Claude: idle Ctrl+C with text clears the composer (verification C13);
   * a second idle Ctrl+C on an empty composer can exit — send only one.
   */
  private async clearFailedSubmit(
    bindingId: string,
    generation: number,
    bindingGeneration: number,
  ): Promise<void> {
    if (!this.activeBinding(bindingId, generation, bindingGeneration)) return;
    if (this.pendingText && !this.pendingText(bindingId)) {
      // Evidence: our text already left the composer (the submit landed and
      // only the working repaint is late — D3's ackDelay case). Writing an
      // idle Ctrl+C now would interrupt a WORKING agent. Still raise the
      // stall attention exactly once per call site (D1/D3 both expect the
      // clear attempt to publish prompt-stalled).
      this.onAttention?.(bindingId, "prompt-stalled");
      return;
    }
    const now = this.now();
    if (
      !canSendIdleInterrupt(
        this.lastIdleInterruptAt.get(bindingId),
        now,
        this.idleInterruptGapMs,
      )
    ) {
      this.onAttention?.(bindingId, "prompt-stalled");
      return;
    }
    const ok = await Promise.resolve(
      this.writeFn(bindingId, INTERRUPT_BYTE),
    );
    if (ok) {
      this.lastIdleInterruptAt.set(bindingId, now);
    }
    this.onAttention?.(bindingId, "prompt-stalled");
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
    // Final idle gate at the paste boundary (no durable receipt if refused).
    if (!this.isSeatIdle(bindingId)) {
      return false;
    }
    // Second line: a queued drain must not sneak a Hermes chip through.
    if (this.refuseHermesMultiline(bindingId, text)) {
      return false;
    }
    const [paste, cr] = buildPromptWriteSequence(text);
    // ONE write for the full paste envelope…
    if (!(await Promise.resolve(this.writeFn(bindingId, paste)))) return false;
    this.pasteWrites.set(bindingId, (this.pasteWrites.get(bindingId) ?? 0) + 1);
    if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
      return false;
    }
    // Let paste-end settle before CR — racing ESC[201~ leaves Claude/Devin
    // with a stuck "[Pasted text …]" chip and never submits.
    if (this.pasteToCrSettleMs > 0) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, this.pasteToCrSettleMs);
        t.unref?.();
      });
      if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
        return false;
      }
      if (!this.isSeatIdle(bindingId)) {
        return false;
      }
    }
    // …then a SEPARATE CR write. Never join; never LF.
    if (!(await Promise.resolve(this.writeFn(bindingId, cr)))) return false;
    return this.activeBinding(bindingId, generation, bindingGeneration);
  }

  /**
   * Chip-submit CR: the recipe step ink TUIs need after a multiline paste.
   * Sends immediately when evidence already shows our text in an idle
   * composer; otherwise waits one settle for the observer to paint.
   * Returns true only when a CR was written.
   */
  private async writeChipSubmitCrIfNeeded(
    bindingId: string,
    text: string,
    generation: number,
    bindingGeneration: number,
  ): Promise<boolean> {
    if (!payloadMayChip(text)) return false;
    if (!this.pasteChip && !this.pendingText) return false;
    if (
      await this.tryChipSubmitCr(bindingId, generation, bindingGeneration)
    ) {
      return true;
    }
    if (this.pasteToCrSettleMs > 0) {
      if (
        !(await this.settle(bindingId, generation, bindingGeneration))
      ) {
        return false;
      }
      return this.tryChipSubmitCr(bindingId, generation, bindingGeneration);
    }
    return false;
  }

  private async tryChipSubmitCr(
    bindingId: string,
    generation: number,
    bindingGeneration: number,
  ): Promise<boolean> {
    if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
      return false;
    }
    if (!this.isSeatIdle(bindingId)) return false;
    if (!this.chipVisible(bindingId)) return false;
    return this.writeSubmitCr(bindingId, generation, bindingGeneration);
  }

  /** Chip chrome, or pendingText when the production pasteChip lookup is absent. */
  private chipVisible(bindingId: string): boolean {
    if (this.pasteChip) return this.pasteChip(bindingId);
    return this.pendingText?.(bindingId) === true;
  }

  private async settle(
    bindingId: string,
    generation: number,
    bindingGeneration: number,
  ): Promise<boolean> {
    if (this.pasteToCrSettleMs > 0) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, this.pasteToCrSettleMs);
        t.unref?.();
      });
    }
    return this.activeBinding(bindingId, generation, bindingGeneration);
  }

  /** One extra CR when the first paste+CR did not produce turn-start. */
  private async writeSubmitCr(
    bindingId: string,
    generation: number,
    bindingGeneration: number,
  ): Promise<boolean> {
    if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
      return false;
    }
    return Boolean(await Promise.resolve(this.writeFn(bindingId, CR)));
  }

  private awaitTurnStart(
    bindingId: string,
    text: string,
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
        text,
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
