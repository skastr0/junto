/**
 * The closing fence: from the instant `junto offboard` is accepted until the
 * seat's process is gone, nothing is typed into that seat.
 *
 * Offboard ends the session at once. Between the offboard being accepted and
 * the process being stopped there is a moment, and between the stop and the
 * exit another; anything typed there (mail, a nudge, a prompt the operator
 * sent, the next session's first line) would start or feed a turn in a
 * session that has just said it is done. So the seat is sealed where the
 * offboard is accepted, and every path that types asks the fence first.
 *
 * A seal names the generation it sealed. It lifts by itself when that
 * generation is no longer the binding's live one (it exited, or a fresh one
 * replaced it): the fence can never hold the session that comes next. The
 * one case where the process lives on is a close that failed before the
 * stop; the closer releases the seal then.
 *
 * What was held is not lost: mail stays in the seat's mailbox and goes to the
 * fresh session, or wakes the resting seat, when the fence lifts.
 */

/** The binding's live generation, or undefined when it has none. */
export type LiveGeneration = (bindingId: string) => string | undefined;

type Seal = { readonly epoch: string | undefined };

export class ClosingFence {
  private readonly seals = new Map<string, Seal>();
  private liveGeneration: LiveGeneration | undefined;
  private readonly lifted = new Set<(bindingId: string) => void>();

  /** How the fence learns which generation a binding is running now. */
  setLiveGeneration(lookup: LiveGeneration): void {
    this.liveGeneration = lookup;
  }

  /** Told when a seal lifts, so what was held for the seat can go out. */
  subscribeLifted(listener: (bindingId: string) => void): () => void {
    this.lifted.add(listener);
    return () => {
      this.lifted.delete(listener);
    };
  }

  /** The seat's `junto offboard` was accepted: keep everything out of this session. */
  seal(bindingId: string | undefined): void {
    if (!bindingId) return;
    this.seals.set(bindingId, { epoch: this.liveGeneration?.(bindingId) });
  }

  /** Nothing may be typed into this seat right now. */
  sealed(bindingId: string): boolean {
    const seal = this.seals.get(bindingId);
    if (seal === undefined) return false;
    // Without a way to tell generations apart the seal holds until released.
    if (this.liveGeneration === undefined) return true;
    const live = this.liveGeneration(bindingId);
    if (live !== undefined && live === seal.epoch) return true;
    // The sealed generation is gone, or another one took its place.
    this.lift(bindingId);
    return false;
  }

  /**
   * The sealed generation's process is gone (or the close failed before it
   * was stopped): typing may resume. Idempotent.
   */
  release(bindingId: string | undefined): void {
    if (bindingId) this.lift(bindingId);
  }

  private lift(bindingId: string): void {
    if (!this.seals.delete(bindingId)) return;
    for (const listener of [...this.lifted]) {
      try {
        listener(bindingId);
      } catch (error) {
        console.error("[closing-fence] listener failed:", error);
      }
    }
  }

  /** Test seam. */
  clearForTest(): void {
    this.seals.clear();
    this.liveGeneration = undefined;
  }
}

/** Process-wide fence (sealed by work control, asked by everything that types). */
export const closingFence = new ClosingFence();

/**
 * Wrap the function that writes Junto's own bytes to a seat's PTY so that a
 * sealed seat takes none. The last line of defence under every higher gate:
 * whatever path forgot to ask the fence still cannot type.
 */
export const fencedWriter =
  <Result>(fence: ClosingFence, write: (bindingId: string, data: string) => Result, refused: Result) =>
  (bindingId: string, data: string): Result =>
    fence.sealed(bindingId) ? refused : write(bindingId, data);
