/**
 * Operator interlock — the zero-latency half of the typing gate.
 *
 * The drive's screen-derived gates (seat idle, composer verdict) read a
 * rendered grid; a keystroke is invisible to them until the harness repaints,
 * which can lag the physical write by tens of milliseconds. An automated
 * paste+CR admitted in that blind window lands on top of a live operator
 * draft — the "injected but not submitted" chip/draft slop this module
 * exists to prevent.
 *
 * Two mechanisms, both keyed by bindingId:
 *
 *   latches — LocalSessionHost stamps noteInput on every operator write and
 *     noteResize on every operator resize at the moment they arrive, BEFORE
 *     the bytes hit the PTY. The drive treats an active latch like a draft
 *     composer: admission refuses and queue drains wait until the screen
 *     catches up. Resize latched separately because a repaint mid-sequence
 *     can scramble chip collapse timing.
 *
 *   submission hold — the drive wraps the physical paste/settle/CR unit in
 *     beginHold/release. While held, LocalSessionHost.write parks operator
 *     bytes instead of writing them through; the outermost release replays
 *     them in order. Operator input can never interleave inside a paste
 *     envelope or land between paste-end and CR, and replayed bytes arrive
 *     after the submission resolved (submitted chip, cleared composer, or
 *     refused write) — never inside it.
 *
 * Pure synchronous state — no I/O, no fibers. The per-keystroke path cannot
 * afford an Effect boundary; this stays a plain class like the drive.
 */

/** Operator keystroke admission block. Covers burst gap + observer paint lag. */
export const OPERATOR_INPUT_LATCH_MS = 400;

/** Resize admission block. Covers the SIGWINCH repaint churn window. */
export const OPERATOR_RESIZE_LATCH_MS = 250;

/** A parked operator write. Replay re-enters the host write path so lease,
 * epoch, and phase are re-validated against the CURRENT session record — a
 * held keystroke can never leak into a replacement seat generation. */
export type HeldOperatorWrite = {
  readonly replay: () => void;
};

type HoldState = {
  depth: number;
  readonly held: HeldOperatorWrite[];
};

function replayHeldWrites(writes: ReadonlyArray<HeldOperatorWrite>): void {
  for (const write of writes) {
    try {
      write.replay();
    } catch {
      // A replayed write that throws (dead lease teardown) drops like a
      // refused write — never take the drive's span cleanup down with it.
    }
  }
}

function discardHeldWrites(hold: HoldState): void {
  hold.held.length = 0;
}

export class OperatorInterlock {
  private readonly now: () => number;
  private readonly inputUntil = new Map<string, number>();
  private readonly inputVersions = new Map<string, number>();
  private readonly resizeUntil = new Map<string, number>();
  private readonly holds = new Map<string, HoldState>();
  private readonly quietWaiters = new Map<
    string,
    Array<() => void>
  >();

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /**
   * Operator bytes reached the PTY write boundary for this binding. Stamped
   * before lease/phase validation — presence is evidence even when the write
   * itself is refused.
   */
  noteInput(bindingId: string): void {
    this.inputVersions.set(
      bindingId,
      (this.inputVersions.get(bindingId) ?? 0) + 1,
    );
    this.inputUntil.set(bindingId, this.now() + OPERATOR_INPUT_LATCH_MS);
  }

  /** Operator-side resize (modal open, pane reflow) — repaint churn follows. */
  noteResize(bindingId: string): void {
    this.resizeUntil.set(bindingId, this.now() + OPERATOR_RESIZE_LATCH_MS);
  }

  /** Operator input younger than the latch — a draft may exist unseen. */
  inputActive(bindingId: string, at = this.now()): boolean {
    return (this.inputUntil.get(bindingId) ?? 0) > at;
  }

  /** Monotonic operator-input version within the current binding generation. */
  inputVersion(bindingId: string): number {
    return this.inputVersions.get(bindingId) ?? 0;
  }

  /** A resize landed recently — composer evidence may be mid-repaint. */
  resizeActive(bindingId: string, at = this.now()): boolean {
    return (this.resizeUntil.get(bindingId) ?? 0) > at;
  }

  /** Milliseconds until the resize-only quiet window ends (0 when quiet). */
  resizeQuietInMs(bindingId: string, at = this.now()): number {
    return Math.max(0, (this.resizeUntil.get(bindingId) ?? 0) - at);
  }

  /** Either latch — the gate-level "operator activity possible" verdict. */
  gateActive(bindingId: string, at = this.now()): boolean {
    return (
      this.inputActive(bindingId, at) || this.resizeActive(bindingId, at)
    );
  }

  /** Milliseconds until both latches are quiet (0 when already quiet). */
  quietInMs(bindingId: string, at = this.now()): number {
    return Math.max(
      0,
      (this.inputUntil.get(bindingId) ?? 0) - at,
      (this.resizeUntil.get(bindingId) ?? 0) - at,
    );
  }

  /**
   * Resolve when the latches go quiet. Used by the drive to re-drain a queue
   * that was blocked only by the latch window (no screen event will fire to
   * re-trigger it). Bounded by the latch lengths — never parks long.
   */
  waitQuiet(bindingId: string): Promise<void> {
    const wait = this.quietInMs(bindingId);
    if (wait <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.quietWaiters.get(bindingId) ?? [];
      waiters.push(resolve);
      this.quietWaiters.set(bindingId, waiters);
      const t = setTimeout(() => {
        this.runQuietWaiters(bindingId);
      }, wait + 1);
      t.unref?.();
    });
  }

  private runQuietWaiters(bindingId: string): void {
    if (this.quietInMs(bindingId) > 0) {
      // A newer keystroke/resize extended the window — re-arm for the rest.
      const waiters = this.quietWaiters.get(bindingId);
      if (waiters === undefined || waiters.length === 0) return;
      const t = setTimeout(() => {
        this.runQuietWaiters(bindingId);
      }, this.quietInMs(bindingId) + 1);
      t.unref?.();
      return;
    }
    const waiters = this.quietWaiters.get(bindingId);
    this.quietWaiters.delete(bindingId);
    if (waiters === undefined) return;
    for (const resolve of waiters) resolve();
  }

  /** True while a managed submission span holds operator writes. */
  holding(bindingId: string): boolean {
    return this.holds.has(bindingId);
  }

  /**
   * Called from the operator write path. Returns true when a submission span
   * is in-flight and the write was parked for ordered replay on hold end.
   * Every callback remains intact, so the host re-validates the original
   * lease, epoch, and phase when it replays that write. Do not add a count cap:
   * the current host API has no acknowledged backpressure, and returning
   * false would either drop bytes or bypass the submission hold.
   */
  holdWrite(bindingId: string, write: HeldOperatorWrite): boolean {
    const hold = this.holds.get(bindingId);
    if (hold === undefined) return false;
    hold.held.push(write);
    return true;
  }

  /**
   * Begin a submission span. Depth-tracked so nested drive recovery writes
   * (chip-submit CR and related recovery writes) share the outer span. The returned release
   * is idempotent and owns this exact hold generation.
   */
  beginHold(bindingId: string): () => void {
    let hold = this.holds.get(bindingId);
    if (hold !== undefined) {
      hold.depth += 1;
    } else {
      hold = { depth: 1, held: [] };
      this.holds.set(bindingId, hold);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseHold(bindingId, hold);
    };
  }

  /**
   * End a submission span for legacy binding-key callers. At depth zero the
   * hold lifts and parked operator writes replay in arrival order — after every
   * drive write in the span. New callers should use beginHold's release.
   */
  endHold(bindingId: string): void {
    const hold = this.holds.get(bindingId);
    if (hold === undefined) return;
    this.releaseHold(bindingId, hold);
  }

  private releaseHold(bindingId: string, hold: HoldState): void {
    // A binding id may be reused for a replacement generation. Only the hold
    // state owned by this release may decrement or flush that binding.
    if (this.holds.get(bindingId) !== hold) return;
    hold.depth -= 1;
    if (hold.depth > 0) return;
    this.holds.delete(bindingId);
    replayHeldWrites(hold.held);
    discardHeldWrites(hold);
  }

  /** Parked write count — tests and diagnostics. */
  heldCount(bindingId: string): number {
    return this.holds.get(bindingId)?.held.length ?? 0;
  }

  /**
   * Drop all interlock state for one binding (generation cut). Buffered
   * writes are discarded without replay — they belonged to the dead epoch
   * and the replay revalidation would refuse them anyway.
   */
  dropBinding(bindingId: string): void {
    this.inputUntil.delete(bindingId);
    this.inputVersions.delete(bindingId);
    this.resizeUntil.delete(bindingId);
    const hold = this.holds.get(bindingId);
    if (hold !== undefined) discardHeldWrites(hold);
    this.holds.delete(bindingId);
    this.quietWaiters.delete(bindingId);
  }

  /** Process-level cut (drive suspend): every binding's latches and holds. */
  clearAll(): void {
    this.inputUntil.clear();
    this.inputVersions.clear();
    this.resizeUntil.clear();
    for (const hold of this.holds.values()) discardHeldWrites(hold);
    this.holds.clear();
    this.quietWaiters.clear();
  }
}

/**
 * Process-local interlock shared by the operator write path
 * (LocalSessionHost) and the managed drive. Same singleton pattern as
 * injectionSupervisor — the two planes meet only here.
 */
export const seatOperatorInterlock = new OperatorInterlock();
