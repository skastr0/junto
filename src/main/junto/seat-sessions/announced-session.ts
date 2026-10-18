/**
 * Whether a session id a seat announced (read from its screen, or found in
 * its harness's store) may be taken as that seat's own session. Never another
 * seat's, and never one this seat already ended: `junto onboard` shows those
 * as history, so they reach the screen of every session that follows. The
 * capture write and every reader of an announced id ask this same question.
 */
import { Effect } from "effect";
import type { SeatSessionObservation, SeatSessionPersistenceError, SeatSessionRepository } from "./repository";

/** Why the announced id is not this seat's session, or undefined when it may be. */
export const announcedSessionRefusal = (
  sessions: SeatSessionRepository["Service"],
  observation: Pick<SeatSessionObservation, "seatId" | "harness" | "sessionId">,
): Effect.Effect<string | undefined, SeatSessionPersistenceError> =>
  Effect.gen(function* () {
    if (yield* sessions.ownedByOtherSeat(observation)) return "harness session already belongs to another seat";
    const history = yield* sessions.list(observation.seatId);
    if (history.some((session) => session.sessionId === observation.sessionId && session.endedAt !== undefined))
      return "capture cannot reopen a session this seat ended";
    return undefined;
  });
