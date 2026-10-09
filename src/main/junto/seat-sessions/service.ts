/**
 * Seat session transcript lookup, occupant retirement and offboard events.
 */
import { Effect } from "effect";
import type { OffboardMode, SeatSession } from "@shared/seat-sessions";
import type { Canvas } from "@shared/model";
import { ModelService } from "../model/service";
import { harnessSessionLocation } from "../term/session-existence";
import { SeatSessionRepository } from "./repository";
import { seatSessionTransitions } from "./transitions";

/** Where the harness keeps one recorded session, when it can be found now. */
const locate = (session: SeatSession, cwd?: string): string | undefined =>
  harnessSessionLocation({
    harness: session.harness,
    sessionId: session.sessionId,
    ...(cwd ? { cwd } : {}),
  });

/**
 * One seat's sessions, newest first, each with its transcript path when the
 * harness has written one. A path found here is remembered, so later listings
 * do not probe again.
 */
export const listSeatSessions = (
  seatId: string,
  cwd?: string,
): Effect.Effect<ReadonlyArray<SeatSession>, never, SeatSessionRepository> =>
  Effect.gen(function* () {
    const repository = yield* SeatSessionRepository;
    const sessions = yield* repository.list(seatId).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<SeatSession>));
    return yield* Effect.forEach(sessions, (session) =>
      Effect.gen(function* () {
        if (session.transcriptPath !== undefined) return session;
        const found = locate(session, cwd);
        if (found === undefined) return session;
        yield* repository.noteTranscript(seatId, session.sessionId, found).pipe(Effect.ignore);
        return { ...session, transcriptPath: found };
      }),
    );
  });

/** Retire a replaced occupant without closing a newly pinned session. */
export const recordCanvasChange = (
  detail: { readonly previous?: Canvas; readonly next?: Canvas } | undefined,
): Effect.Effect<void, never, SeatSessionRepository> =>
  Effect.gen(function* () {
    if (detail === undefined) return;
    const repository = yield* SeatSessionRepository;
    for (const transition of seatSessionTransitions(detail.previous, detail.next)) {
      yield* repository.end(transition.seatId, "reseat", undefined, transition.bindingId).pipe(Effect.ignore);
    }
  });

/**
 * Follow occupant changes only. Session pins are written by execution, never
 * reconstructed from a canvas copy or from the newest historical session.
 */
export const startSeatSessionRecorder = (
  run: (effect: Effect.Effect<void, never, SeatSessionRepository>) => void,
): Effect.Effect<() => void, never, ModelService | SeatSessionRepository> =>
  Effect.gen(function* () {
    const model = yield* ModelService;
    const previous = new Map<string, Canvas>();
    for (const name of yield* model.listCanvases().pipe(Effect.orElseSucceed(() => []))) {
      const canvas = yield* model.canvas(name).pipe(Effect.orElseSucceed(() => undefined));
      if (!canvas) continue;
      previous.set(name, canvas);
    }
    const changed = model.subscribeChanges((event, next) => {
      const before = previous.get(event.canvas);
      previous.set(event.canvas, next);
      run(recordCanvasChange({ previous: before, next }));
    });
    const canvasesChanged = model.subscribeCanvasesChanges((event, next) => {
      if (event._tag === "Removed") previous.delete(event.canvas);
      else if (next) {
        previous.set(event.canvas, next);
        run(recordCanvasChange({ next }));
      }
    });
    return () => { changed(); canvasesChanged(); };
  });

// ── Offboard events ─────────────────────────────────────────────────────────

export type SeatOffboardEvent = {
  readonly seatId: string;
  readonly canvasName: string;
  readonly sessionId: string;
  readonly at: number;
  /** rest: close the session and let the seat rest. continue: start the next one. */
  readonly mode: OffboardMode;
};

const offboardListeners = new Set<(event: SeatOffboardEvent) => void>();

/**
 * Called once a seat's `junto offboard` has been answered: its notes are on
 * disk and its reply has been written back. A listener (the offboard closer)
 * ends the session at once, in the mode the agent chose.
 */
export const subscribeSeatOffboard = (listener: (event: SeatOffboardEvent) => void): (() => void) => {
  offboardListeners.add(listener);
  return () => {
    offboardListeners.delete(listener);
  };
};

export const announceSeatOffboard = (event: SeatOffboardEvent): void => {
  for (const listener of offboardListeners) {
    try {
      listener(event);
    } catch (error) {
      console.error("[seat-sessions] offboard listener failed:", error);
    }
  }
};
