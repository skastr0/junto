/**
 * The continuation a seat is still owed: after `junto offboard --continue`,
 * the fresh session is told once to read its handoff. The seat may not start
 * for a long time (a paused canvas), and Junto may quit in between, so what
 * is owed is written beside the seat's session notes and armed again when
 * Junto next starts.
 *
 * `<seats root>/<seat>/continuation.pending`: present from the rotation until
 * the line is typed (or the session onboards without it).
 *
 * This is the only module that arms the supervisor's continuation. `owe` is
 * for the offboard closer; `restore` re-arms only what `owe` wrote.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { defaultSeatsRoot, pathSegment } from "./notes-file";

const PENDING_FILE = "continuation.pending";

type Pending = {
  readonly bindingId: string;
  /** The generation that offboarded: never the one to tell. */
  readonly offboarded?: string;
  readonly at: number;
};

/** The supervisor, as this ledger needs it. */
export type ContinuationTarget = {
  readonly armContinuation: (bindingId: string, offboarded: string | undefined) => void;
  readonly setContinuationSettled: (listener: (bindingId: string) => void) => void;
  /** Nothing is owed after all: forget it without typing anything. */
  readonly disarmContinuation: (bindingId: string) => void;
};

const decode = (text: string): Pending | undefined => {
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null) return undefined;
    const { bindingId, offboarded, at } = raw as Record<string, unknown>;
    if (typeof bindingId !== "string" || !bindingId) return undefined;
    if (offboarded !== undefined && typeof offboarded !== "string") return undefined;
    return {
      bindingId,
      ...(offboarded ? { offboarded } : {}),
      at: typeof at === "number" && Number.isFinite(at) ? at : 0,
    };
  } catch {
    return undefined;
  }
};

export class ContinuationLedger {
  /** bindingId → the file that says the seat is owed its continuation. */
  private readonly owed = new Map<string, string>();

  constructor(
    private readonly target: ContinuationTarget,
    private readonly seatsRoot: string = defaultSeatsRoot(),
    private readonly now: () => number = Date.now,
  ) {
    target.setContinuationSettled((bindingId) => this.settle(bindingId));
  }

  private pathFor(seatId: string): string {
    return join(this.seatsRoot, pathSegment(seatId), PENDING_FILE);
  }

  /**
   * The seat offboarded with `--continue` and its session was rotated: its
   * fresh session is owed the continuation line. Written before it is armed,
   * so a quit between the two loses nothing.
   */
  owe(seatId: string, bindingId: string, offboarded: string | undefined): void {
    const path = this.pathFor(seatId);
    const pending: Pending = { bindingId, ...(offboarded ? { offboarded } : {}), at: this.now() };
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
      this.owed.set(bindingId, path);
    } catch (error) {
      // Still owed for this run; only a restart would lose it.
      console.error("[seat-sessions] could not record a pending continuation:", error);
    }
    this.target.armContinuation(bindingId, offboarded);
  }

  /** Arm again every continuation a previous run recorded and never delivered. */
  restore(): number {
    let seats: string[];
    try {
      seats = readdirSync(this.seatsRoot);
    } catch {
      return 0;
    }
    let restored = 0;
    for (const seat of seats) {
      const path = join(this.seatsRoot, seat, PENDING_FILE);
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const pending = decode(text);
      if (pending === undefined) {
        rmSync(path, { force: true });
        continue;
      }
      this.owed.set(pending.bindingId, path);
      this.target.armContinuation(pending.bindingId, pending.offboarded);
      restored += 1;
    }
    return restored;
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
    const path = this.owed.get(bindingId);
    if (path === undefined) return;
    this.owed.delete(bindingId);
    rmSync(path, { force: true });
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
  input.ledger.owe(input.seatId, input.bindingId, input.offboarded);
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
