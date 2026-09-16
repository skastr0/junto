/**
 * Mid-turn progress watchdog — after turn-start (working), require recent
 * meaningful activity or force attention with reason `turn-stalled`.
 *
 * Does not own seat publication; callers force attention and sticky-hold.
 * Must never publish idle (would drain managed prompt queues).
 */

/** Stable seat reason for mid-turn freeze honesty. */
export const TURN_STALLED_REASON = "turn-stalled" as const;

/**
 * Default wall-clock silence after last progress while working.
 * Delivery-path stall (`DEFAULT_PROMPT_STALL_MS` = 5s) is separate: that only
 * waits for turn-start after paste. This timer arms once the seat is working.
 */
export const DEFAULT_TURN_STALL_MS = 90_000;

export type TurnProgressWatchOptions = {
  readonly now?: () => number;
  /** Silence threshold while armed (default DEFAULT_TURN_STALL_MS). */
  readonly stallMs?: number;
  /** Fired once per arm cycle when silence exceeds stallMs. */
  readonly onStall: (bindingId: string) => void;
};

type ArmedSlot = {
  lastProgressAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
};

/**
 * Per-binding arm / progress / clear. Arming is idempotent; progress resets
 * the deadline; clear drops the timer without firing.
 */
export class TurnProgressWatch {
  private readonly now: () => number;
  private readonly stallMs: number;
  private readonly onStall: (bindingId: string) => void;
  private readonly slots = new Map<string, ArmedSlot>();

  constructor(options: TurnProgressWatchOptions) {
    this.now = options.now ?? (() => Date.now());
    this.stallMs = options.stallMs ?? DEFAULT_TURN_STALL_MS;
    this.onStall = options.onStall;
  }

  /** Start watching a working seat. No-op if already armed. */
  arm(bindingId: string): void {
    if (this.slots.has(bindingId)) return;
    const slot: ArmedSlot = {
      lastProgressAt: this.now(),
      timer: undefined,
    };
    this.slots.set(bindingId, slot);
    this.schedule(bindingId, slot);
  }

  /** Reset the silence clock while armed. No-op if not armed. */
  noteProgress(bindingId: string): void {
    const slot = this.slots.get(bindingId);
    if (!slot) return;
    slot.lastProgressAt = this.now();
    this.schedule(bindingId, slot);
  }

  /** Drop watch without firing (idle, real attention, gone, unbind). */
  clear(bindingId: string): void {
    const slot = this.slots.get(bindingId);
    if (!slot) return;
    if (slot.timer !== undefined) clearTimeout(slot.timer);
    this.slots.delete(bindingId);
  }

  isArmed(bindingId: string): boolean {
    return this.slots.has(bindingId);
  }

  /** Test / diagnostics: last progress epoch-ms while armed. */
  lastProgressAt(bindingId: string): number | undefined {
    return this.slots.get(bindingId)?.lastProgressAt;
  }

  dispose(): void {
    for (const bindingId of [...this.slots.keys()]) {
      this.clear(bindingId);
    }
  }

  private schedule(bindingId: string, slot: ArmedSlot): void {
    if (slot.timer !== undefined) clearTimeout(slot.timer);
    const remaining = Math.max(
      0,
      this.stallMs - (this.now() - slot.lastProgressAt),
    );
    slot.timer = setTimeout(() => {
      if (this.slots.get(bindingId) !== slot) return;
      slot.timer = undefined;
      this.slots.delete(bindingId);
      this.onStall(bindingId);
    }, remaining);
    (
      slot.timer as ReturnType<typeof setTimeout> & { unref?: () => void }
    ).unref?.();
  }
}

/**
 * Fingerprint of observable turn progress for a seat snapshot + optional hook.
 * Seq advances on PTY output; title/osc9 capture chrome-only repaints that
 * still prove the harness is alive. Hook key is state+reason only — never
 * `at`, or every re-observe with a fresh clock would look like progress and
 * clear a sticky turn-stalled hold.
 */
export const progressFingerprint = (
  input: {
    readonly seq: bigint;
    readonly signals: { readonly title: string; readonly osc9: string };
    readonly text?: string;
  },
  hook?: { readonly state: string; readonly reason: string; readonly at?: number } | null,
): string => {
  const hookKey =
    hook === null || hook === undefined
      ? ""
      : `${hook.state}|${hook.reason}`;
  // Cap text so a huge grid never blows the fingerprint; length + tails still
  // change when content scrolls without a title flip.
  const text = input.text ?? "";
  const textKey =
    text.length <= 128
      ? text
      : `${text.length}:${text.slice(0, 48)}…${text.slice(-48)}`;
  return `${input.seq}|${input.signals.title}|${input.signals.osc9}|${textKey}|${hookKey}`;
};
