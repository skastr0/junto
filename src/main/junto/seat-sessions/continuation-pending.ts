/**
 * The continuation a seat is still owed: after `junto offboard --continue`,
 * the fresh session is told once to read its handoff. The seat may not start
 * for a long time (a paused canvas), and Junto may quit in between, so what
 * is owed is kept in junto.db (`seat_continuations_owed`) and armed again
 * when Junto next starts, from the line's owing until it is typed (or the
 * session onboards without it).
 *
 * This is the only module that arms the supervisor's continuation. `owe` is
 * for the offboard closer; `restore` re-arms only what `owe` kept.
 */
import { Effect } from "effect";
import { SeatSessionRepository, type OwedContinuation } from "./repository";

/** A runner over the seat sessions store alone: the app's SeatSessionRun is one. */
export type SeatSessionStoreRun = <A, E>(effect: Effect.Effect<A, E, SeatSessionRepository>) => Promise<A>;

/** The supervisor, as this ledger needs it. */
export type ContinuationTarget = {
  readonly armContinuation: (bindingId: string, offboarded: string | undefined) => void;
  readonly setContinuationSettled: (listener: (bindingId: string) => void) => void;
  /** Nothing is owed after all: forget it without typing anything. */
  readonly disarmContinuation: (bindingId: string) => void;
};

/** Where what is owed is kept. */
export type ContinuationStore = {
  readonly keep: (owed: OwedContinuation) => Promise<void>;
  readonly owed: () => Promise<ReadonlyArray<OwedContinuation>>;
  readonly settle: (bindingId: string) => Promise<void>;
};

/** The ledger's store: the seat sessions store, in the runtime this process owns. */
export const continuationStoreIn = (run: SeatSessionStoreRun): ContinuationStore => ({
  keep: (owed) => run(Effect.flatMap(SeatSessionRepository, (sessions) => sessions.oweContinuation(owed))),
  owed: () => run(Effect.flatMap(SeatSessionRepository, (sessions) => sessions.owedContinuations())),
  settle: (bindingId) => run(Effect.flatMap(SeatSessionRepository, (sessions) => sessions.settleContinuation(bindingId))),
});

export class ContinuationLedger {
  /** Bindings this run knows to be owed their line. */
  private readonly owed = new Set<string>();

  constructor(
    private readonly target: ContinuationTarget,
    private readonly store: ContinuationStore,
    private readonly now: () => number = Date.now,
  ) {
    target.setContinuationSettled((bindingId) => this.settle(bindingId));
  }

  /**
   * The seat offboarded with `--continue` and its session was rotated: its
   * fresh session is owed the continuation line. Kept before it is armed,
   * so a quit between the two loses nothing.
   */
  async owe(seatId: string, bindingId: string, offboarded: string | undefined): Promise<void> {
    try {
      await this.store.keep({ seatId, bindingId, ...(offboarded ? { offboarded } : {}), at: this.now() });
      this.owed.add(bindingId);
    } catch (error) {
      // Still owed for this run; only a restart would lose it.
      console.error("[seat-sessions] could not record a pending continuation:", error);
    }
    this.target.armContinuation(bindingId, offboarded);
  }

  /** Arm again every continuation a previous run recorded and never delivered. */
  async restore(): Promise<number> {
    let owed: ReadonlyArray<OwedContinuation>;
    try {
      owed = await this.store.owed();
    } catch (error) {
      console.error("[seat-sessions] could not read the pending continuations:", error);
      return 0;
    }
    for (const entry of owed) {
      this.owed.add(entry.bindingId);
      this.target.armContinuation(entry.bindingId, entry.offboarded);
    }
    return owed.length;
  }

  /**
   * The close that owed this did not go through: the old session goes on and
   * no fresh one is coming, so nothing is owed.
   */
  forgive(bindingId: string): void {
    this.target.disarmContinuation(bindingId);
    this.settle(bindingId);
  }

  /** The line was typed, or the session onboarded without it: nothing is owed. */
  private settle(bindingId: string): void {
    if (!this.owed.delete(bindingId)) return;
    void this.store.settle(bindingId).catch((error: unknown) =>
      console.error("[seat-sessions] could not settle a pending continuation:", error),
    );
  }
}

/**
 * Rotate a continuing seat with its line owed first.
 *
 * The line is owed before the old process is touched, naming the generation
 * that offboarded. Owed any later, the fresh session can be up, typed into
 * and nudged before Junto remembers it has something to say to it.
 */
export const rotateOwing = async <Result extends { readonly ok: boolean }>(input: {
  readonly ledger: Pick<ContinuationLedger, "owe" | "forgive">;
  readonly seatId: string;
  readonly bindingId: string;
  /** The generation that offboarded: never the one to tell. */
  readonly offboarded: string | undefined;
  readonly rotate: () => Promise<Result>;
}): Promise<Result> => {
  await input.ledger.owe(input.seatId, input.bindingId, input.offboarded);
  let result: Result;
  try {
    result = await input.rotate();
  } catch (error) {
    input.ledger.forgive(input.bindingId);
    throw error;
  }
  if (!result.ok) input.ledger.forgive(input.bindingId);
  return result;
};
