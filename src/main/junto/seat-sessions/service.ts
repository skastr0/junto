/**
 * Seat session transcript lookup, occupant retirement and offboard events.
 */
import { Effect } from "effect";
import type { OffboardMode, SeatSession, TranscriptMissing } from "@shared/seat-sessions";
import type { Canvas } from "@shared/model";
import { ModelService } from "../model/service";
import { harnessSessionLocation, sessionStoreFor } from "../term/session-existence";
import { SeatSessionRepository } from "./repository";
import { recordSessionAtClose, type SessionClose, type SessionRecordSources } from "./session-record";
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
 * harness has written one, or why it has none. A path found here is
 * remembered, so later listings do not probe again.
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
        if (found === undefined) {
          const transcriptMissing: TranscriptMissing = sessionStoreFor(session.harness.trim()) === undefined ? "unsearchable" : "none";
          return { ...session, transcriptMissing };
        }
        yield* repository.noteTranscript(seatId, session.sessionId, found).pipe(Effect.ignore);
        return { ...session, transcriptPath: found };
      }),
    );
  });

/** Retire a replaced occupant without closing a newly pinned session; the sessions it ended. */
export const recordCanvasChange = (
  detail: { readonly previous?: Canvas; readonly next?: Canvas } | undefined,
): Effect.Effect<ReadonlyArray<SessionClose>, never, SeatSessionRepository> =>
  Effect.gen(function* () {
    const canvasName = detail?.next?.name ?? detail?.previous?.name;
    if (detail === undefined || canvasName === undefined) return [];
    const repository = yield* SeatSessionRepository;
    const closes: SessionClose[] = [];
    for (const transition of seatSessionTransitions(detail.previous, detail.next)) {
      const endedAt = Date.now();
      const ended = yield* repository.end(transition.seatId, "reseat", undefined, transition.bindingId).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (ended !== undefined)
        closes.push({ seat: { canvasName, seatId: transition.seatId }, sessionId: ended, endedAt, endedBy: "reseat" });
    }
    return closes;
  });

/** Retire a replaced occupant, then write the record of each session that ended. */
const retireAndRecord = (
  detail: { readonly previous?: Canvas; readonly next?: Canvas },
  log: ((message: string) => void) | undefined,
): Effect.Effect<void, never, SessionRecordSources> =>
  Effect.flatMap(recordCanvasChange(detail), (closes) =>
    Effect.forEach(closes, (close) => recordSessionAtClose(close, log ? { log } : {}), { discard: true }),
  );

/**
 * Follow occupant changes only. Session pins are written by execution, never
 * reconstructed from a canvas copy or from the newest historical session.
 */
export const startSeatSessionRecorder = (
  run: (effect: Effect.Effect<void, never, SessionRecordSources>) => void,
  log?: (message: string) => void,
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
      run(retireAndRecord({ previous: before, next }, log));
    });
    const canvasesChanged = model.subscribeCanvasesChanges((event, next) => {
      if (event._tag === "Removed") previous.delete(event.canvas);
      else if (next) {
        previous.set(event.canvas, next);
        run(retireAndRecord({ next }, log));
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
