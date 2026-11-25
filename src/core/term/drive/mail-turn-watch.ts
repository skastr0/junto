/**
 * Did the seat start a turn on the mail the drive typed?
 *
 * `writeMail` returns "written" the moment the last keystroke is out, and the
 * mail is stamped delivered on that word. Nothing watched what the harness did
 * next: a multiline paste whose chip was not yet on screen when the second
 * Enter was due stays in the composer, delivered and unsent. This keeps one
 * count per seat of mail written against turns started, and a record of every
 * mail that was written to an idle seat and showed no turn start within a
 * bound.
 *
 * Only mail written to an idle seat is expected to start a turn. Mail typed
 * into a working seat is steered or queued by the harness and starts nothing
 * of its own, so it is counted as written and never as missed.
 *
 * A miss is a record, not a verdict: a turn start that arrives later marks the
 * miss late (slow harness) and a miss that never resolves is the stuck case.
 * Nothing here writes to a seat or changes delivery.
 */

/** How long an idle seat has to start a turn on mail before it is a miss. */
export const MAIL_TURN_START_BOUND_MS = 10_000;

/** Misses kept in memory, oldest dropped first. */
const MAX_MISSES = 200;

export type MailTurnStats = {
  /** Mail the drive finished typing into this seat. */
  readonly written: number;
  /** Of those, mail typed into an idle seat: each should start a turn. */
  readonly expected: number;
  /** Expected mail whose turn started inside the bound. */
  readonly started: number;
  /** Expected mail with no turn start inside the bound. Includes `late`. */
  readonly missed: number;
  /** Missed mail whose turn started after the bound. */
  readonly late: number;
};

export type MailTurnMiss = {
  readonly bindingId: string;
  /** When the first Enter went out. */
  readonly writtenAt: number;
  readonly boundMs: number;
  /** Size of the mail, never its text. */
  readonly chars: number;
  readonly lines: number;
  /** What the screen showed when the bound ran out. */
  readonly chipOnScreen: boolean;
  readonly textOnScreen: boolean;
  /** Set when a turn started after the bound: how long after the first Enter. */
  readonly lateAfterMs?: number;
};

type MutableMiss = { -readonly [K in keyof MailTurnMiss]: MailTurnMiss[K] };
type MutableStats = { -readonly [K in keyof MailTurnStats]: MailTurnStats[K] };

type Handle = {
  readonly bindingId: string;
  readonly openedAt: number;
  readonly expectTurn: boolean;
  readonly chars: number;
  readonly lines: number;
  startedAt: number | undefined;
  armed: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
};

export type MailTurnHandle = Handle;

export type MailTurnScreen = {
  readonly chipOnScreen: boolean;
  readonly textOnScreen: boolean;
};

export type MailTurnWatchOptions = {
  readonly boundMs: number;
  readonly now: () => number;
  /** Called once per miss, when the bound runs out. */
  readonly onMiss: (miss: MailTurnMiss) => void;
};

const EMPTY: MailTurnStats = { written: 0, expected: 0, started: 0, missed: 0, late: 0 };

export class MailTurnWatch {
  private readonly openByBinding = new Map<string, Set<Handle>>();
  private readonly counts = new Map<string, MailTurnStats>();
  private readonly lateCandidates = new Map<string, MutableMiss[]>();
  private recorded: MutableMiss[] = [];

  constructor(private readonly options: MailTurnWatchOptions) {}

  /** Before the first Enter, so a turn start that races the write is seen. */
  open(
    bindingId: string,
    mail: { readonly expectTurn: boolean; readonly text: string },
  ): MailTurnHandle {
    const handle: Handle = {
      bindingId,
      openedAt: this.options.now(),
      expectTurn: mail.expectTurn,
      chars: mail.text.length,
      lines: mail.text.split("\n").length,
      startedAt: undefined,
      armed: false,
      timer: undefined,
    };
    let set = this.openByBinding.get(bindingId);
    if (set === undefined) this.openByBinding.set(bindingId, (set = new Set()));
    set.add(handle);
    return handle;
  }

  /** The mail is written: count it and, when a turn is expected, start the clock. */
  arm(handle: MailTurnHandle, screen: () => MailTurnScreen): void {
    if (handle.armed) return;
    handle.armed = true;
    this.bump(handle.bindingId, { written: 1, ...(handle.expectTurn ? { expected: 1 } : {}) });
    if (!handle.expectTurn) {
      this.release(handle);
      return;
    }
    if (handle.startedAt !== undefined) {
      this.bump(handle.bindingId, { started: 1 });
      this.release(handle);
      return;
    }
    handle.timer = setTimeout(() => {
      handle.timer = undefined;
      if (!this.release(handle)) return;
      let shown: MailTurnScreen;
      try {
        shown = screen();
      } catch {
        shown = { chipOnScreen: false, textOnScreen: false };
      }
      const miss: MutableMiss = {
        bindingId: handle.bindingId,
        writtenAt: handle.openedAt,
        boundMs: this.options.boundMs,
        chars: handle.chars,
        lines: handle.lines,
        ...shown,
      };
      this.bump(handle.bindingId, { missed: 1 });
      this.recorded.push(miss);
      if (this.recorded.length > MAX_MISSES) this.recorded.shift();
      const late = this.lateCandidates.get(handle.bindingId) ?? [];
      late.push(miss);
      if (late.length > MAX_MISSES) late.shift();
      this.lateCandidates.set(handle.bindingId, late);
      this.options.onMiss(miss);
    }, this.options.boundMs);
    handle.timer.unref?.();
  }

  /** The write did not complete: the mail was never typed, so nothing is owed. */
  discard(handle: MailTurnHandle): void {
    if (handle.armed) return;
    handle.armed = true;
    this.release(handle);
  }

  /** An accepted turn start on the seat. */
  turnStarted(bindingId: string): void {
    const now = this.options.now();
    for (const handle of [...(this.openByBinding.get(bindingId) ?? [])]) {
      handle.startedAt = now;
      if (!handle.armed) continue;
      this.bump(bindingId, { started: 1 });
      this.release(handle);
    }
    const late = this.lateCandidates.get(bindingId);
    if (late !== undefined) {
      for (const miss of late) {
        miss.lateAfterMs = now - miss.writtenAt;
        this.bump(bindingId, { late: 1 });
      }
      this.lateCandidates.delete(bindingId);
    }
  }

  /** The seat's process was replaced: open clocks end without a verdict. */
  forget(bindingId: string): void {
    for (const handle of [...(this.openByBinding.get(bindingId) ?? [])]) {
      handle.armed = true;
      this.release(handle);
    }
    this.lateCandidates.delete(bindingId);
  }

  /** Every open clock ends without a verdict. Counts and misses are kept. */
  forgetAll(): void {
    for (const bindingId of [...this.openByBinding.keys()]) this.forget(bindingId);
    this.lateCandidates.clear();
  }

  /** Counts and misses cleared too (test seam). */
  reset(): void {
    this.forgetAll();
    this.counts.clear();
    this.recorded = [];
  }

  stats(bindingId: string): MailTurnStats {
    return this.counts.get(bindingId) ?? EMPTY;
  }

  /** Every seat's counts, and their sum. */
  allStats(): { readonly total: MailTurnStats; readonly seats: ReadonlyMap<string, MailTurnStats> } {
    const total: MutableStats = { ...EMPTY };
    for (const one of this.counts.values()) {
      total.written += one.written;
      total.expected += one.expected;
      total.started += one.started;
      total.missed += one.missed;
      total.late += one.late;
    }
    return { total, seats: new Map(this.counts) };
  }

  /** Misses, oldest first, optionally for one seat. */
  misses(bindingId?: string): ReadonlyArray<MailTurnMiss> {
    return bindingId === undefined
      ? [...this.recorded]
      : this.recorded.filter((miss) => miss.bindingId === bindingId);
  }

  private bump(bindingId: string, by: Partial<MailTurnStats>): void {
    const was = this.stats(bindingId);
    this.counts.set(bindingId, {
      written: was.written + (by.written ?? 0),
      expected: was.expected + (by.expected ?? 0),
      started: was.started + (by.started ?? 0),
      missed: was.missed + (by.missed ?? 0),
      late: was.late + (by.late ?? 0),
    });
  }

  /** Takes the handle out of the open set. False when it was already out. */
  private release(handle: Handle): boolean {
    if (handle.timer !== undefined) clearTimeout(handle.timer);
    handle.timer = undefined;
    const set = this.openByBinding.get(handle.bindingId);
    const had = set?.delete(handle) === true;
    if (set !== undefined && set.size === 0) this.openByBinding.delete(handle.bindingId);
    return had;
  }
}
