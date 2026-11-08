/**
 * Detaching a seat's process when it offboards, and winding it down.
 *
 * This joins the three parts of a drain: the host, which takes the process
 * off its seat and keeps it alive under a drain key; the seat-state reading,
 * which says when that process has gone quiet; and the drain manager, which
 * decides when it is done and writes down how it ended. Rotation calls
 * `detach` and moves on; nothing here is ever awaited for the seat's sake.
 *
 * Everything comes in through ports, so the whole path runs in a test
 * without the app.
 */
import type { SeatSessionDrainEnd } from "@shared/seat-sessions";
import { SessionDrainManager } from "./drain";
import type { DetachedGeneration, RotatingSeat } from "./rotate";

export type SeatDrainPorts = {
  readonly host: {
    /** Take the binding's running process off its seat; undefined when it cannot be. */
    readonly drain: (bindingId: string) => { readonly drainKey: string } | undefined;
    readonly stopDraining: (drainKey: string, reason: string) => boolean;
    readonly onDrainEnded: (listener: (drainKey: string, code: number | undefined) => void) => () => void;
  };
  /** The detached process reads idle between turns, right now. */
  readonly isIdle: (drainKey: string) => boolean;
  /** Told whenever a detached process's state is read again, with its drain key. */
  readonly subscribeDrainState: (listener: (drainKey: string) => void) => () => void;
  /** Stop the process still on the seat and wait for it to be gone (bounded). */
  readonly stopSeat: (bindingId: string) => Promise<void>;
  readonly record: {
    readonly begin: (seatId: string, sessionId: string, at: number) => Promise<unknown>;
    readonly end: (seatId: string, sessionId: string, how: SeatSessionDrainEnd, at: number) => Promise<unknown>;
    /** The offboard did not go through: the session keeps no wind-down. */
    readonly cancel: (seatId: string, sessionId: string) => Promise<unknown>;
  };
  /** How long a stop asked for at once waits for the process to be gone. */
  readonly stopWaitMs?: number;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
};

const STOP_WAIT_MS = 10_000;

export type SeatDrain = {
  /** Rotation's port: take the old process off the seat, now. */
  readonly detach: (
    seat: RotatingSeat,
    seatId: string,
    endedSessionId: string | undefined,
  ) => Promise<DetachedGeneration>;
  /** Sessions of this seat still winding down: never the fresh session's id. */
  readonly drainingSessionIds: (seatId: string) => ReadonlyArray<string>;
  /** Junto is quitting: record what was still winding down as ended by that. */
  readonly quit: () => void;
  readonly dispose: () => void;
};

export const composeSeatDrain = (ports: SeatDrainPorts): SeatDrain => {
  // One line of writes per session, in order: the end never overtakes the begin.
  const writes = new Map<string, Promise<unknown>>();
  const write = (seatId: string, sessionId: string, what: string, run: () => Promise<unknown>): void => {
    // A seat that named no session has no row to write beside.
    if (sessionId === "") return;
    const key = `${seatId}\u0000${sessionId}`;
    const next = (writes.get(key) ?? Promise.resolve())
      .then(run)
      .catch((error: unknown) => ports.log?.(`could not record ${what} of ${sessionId}: ${String(error)}`))
      .finally(() => {
        if (writes.get(key) === next) writes.delete(key);
      });
    writes.set(key, next);
  };

  const ended = new Map<string, Set<() => void>>();
  const manager = new SessionDrainManager({
    isIdle: ports.isIdle,
    stop: (drainKey) => void ports.host.stopDraining(drainKey, "offboard"),
    record: {
      begin: (session, at) =>
        write(session.seatId, session.sessionId, "the drain", () =>
          ports.record.begin(session.seatId, session.sessionId, at),
        ),
      cancel: (session) =>
        write(session.seatId, session.sessionId, "the cancelled drain", () =>
          ports.record.cancel(session.seatId, session.sessionId),
        ),
      end: (session, how, at) => {
        ports.log?.(`${session.seatId}: its offboarded session ended (${how})`);
        write(session.seatId, session.sessionId, "the end", () =>
          ports.record.end(session.seatId, session.sessionId, how, at),
        );
      },
    },
    ...(ports.now ? { now: ports.now } : {}),
    ...(ports.log ? { log: ports.log } : {}),
  });

  const offEnded = ports.host.onDrainEnded((drainKey, code) => {
    manager.noteExit(drainKey, code);
    for (const waiter of ended.get(drainKey) ?? []) waiter();
    ended.delete(drainKey);
  });
  const offState = ports.subscribeDrainState((drainKey) => manager.noteState(drainKey));

  const stopDrained = (drainKey: string): Promise<void> =>
    new Promise((resolve) => {
      if (!manager.draining().some((session) => session.drainKey === drainKey)) return resolve();
      const timer = setTimeout(done, ports.stopWaitMs ?? STOP_WAIT_MS);
      timer.unref?.();
      const waiters = ended.get(drainKey) ?? new Set();
      ended.set(drainKey, waiters);
      function done(): void {
        clearTimeout(timer);
        waiters.delete(done);
        resolve();
      }
      waiters.add(done);
      // Not a wind-down that ended: the session is the seat's again.
      manager.abandon(drainKey);
    });

  return {
    detach: async (seat, seatId, endedSessionId) => {
      const detached = ports.host.drain(seat.bindingId);
      if (detached === undefined) {
        // Nothing running, or a process that cannot be left to wind down
        // (already stopping, or no screen to read it by): it is stopped, as
        // before, and the seat waits only for that.
        await ports.stopSeat(seat.bindingId);
        return { stopNow: async () => undefined };
      }
      ports.log?.(`${seatId}: its offboarded session is detached and winding down`);
      manager.begin({ seatId, sessionId: endedSessionId ?? "", drainKey: detached.drainKey });
      return { stopNow: () => stopDrained(detached.drainKey) };
    },
    drainingSessionIds: (seatId) =>
      manager
        .draining()
        .filter((session) => session.seatId === seatId && session.sessionId !== "")
        .map((session) => session.sessionId),
    quit: () => manager.quit(),
    dispose: () => {
      offEnded();
      offState();
    },
  };
};
