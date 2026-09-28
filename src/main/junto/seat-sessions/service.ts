/**
 * Seat sessions in the running app: the canvas recorder that notices every
 * session id a seat is given, the listing that finds each session's transcript
 * on disk, and the offboard event the offboard closer listens for.
 */
import { Effect } from "effect";
import type { OffboardMode, SeatSession } from "@shared/seat-sessions";
import type { CanvasChangeDetail } from "../canvases";
import { CanvasesService } from "../canvases";
import { harnessSessionLocation } from "../term/session-existence";
import { SeatSessionRepository, type SeatSessionObservation } from "./repository";
import { seatSessionsOnCanvas, seatSessionTransitions } from "./transitions";

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

const recordAll = (
  repository: SeatSessionRepository["Service"],
  observations: ReadonlyArray<SeatSessionObservation>,
) =>
  Effect.forEach(observations, (observation) => repository.record(observation).pipe(Effect.ignore), {
    discard: true,
  });

/** Apply one canvas commit's session changes. Never fails: history is best effort. */
export const recordCanvasChange = (
  detail: CanvasChangeDetail | undefined,
): Effect.Effect<void, never, SeatSessionRepository> =>
  Effect.gen(function* () {
    if (detail === undefined) return;
    const repository = yield* SeatSessionRepository;
    for (const transition of seatSessionTransitions(detail.previous, detail.next)) {
      if (transition.kind === "start") {
        yield* repository.record(transition.observation).pipe(Effect.ignore);
      } else {
        yield* repository.end(transition.seatId, transition.reason, transition.sessionId).pipe(Effect.ignore);
      }
    }
  });

/**
 * Record every seat's current session from the live canvases, then follow
 * each commit. Idempotent at boot: a session already open is left alone, and
 * one that changed while Junto was closed ends as replaced.
 */
export const startSeatSessionRecorder = (
  run: (effect: Effect.Effect<void, never, SeatSessionRepository>) => void,
): Effect.Effect<() => void, never, CanvasesService | SeatSessionRepository> =>
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    const repository = yield* SeatSessionRepository;
    const documents = yield* canvases.liveDocuments().pipe(Effect.orElseSucceed(() => []));
    yield* recordAll(repository, documents.flatMap(({ doc }) => seatSessionsOnCanvas(doc)));
    return canvases.subscribeChanges((_name, detail) => {
      run(recordCanvasChange(detail));
    });
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
 * Called whenever a seat's agent runs `junto offboard`. The write never
 * touches the running session; a listener (the offboard closer) closes it
 * once the agent is idle, in the mode the agent chose.
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
