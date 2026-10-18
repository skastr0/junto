/**
 * The session record at close: every time a seat session ends, Junto writes
 * what it observed while the session ran, beside the session's notes, as
 * `<seats>/<seat>/sessions/<session>.record.json`.
 *
 * Called once at every end: the agent's own offboard, every cut from outside
 * the session, and a reseat or replaced end. It never fails and never holds
 * the close up for long; a source it cannot read is recorded as unread.
 */
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { SeatAddress } from "@shared/seat-sessions";
import type { SessionEndedBy } from "@shared/seat-session-record";
import type { WorkService } from "../work/service";
import type { SeatSessionRepository } from "./repository";

/** What the record is read from; all of it lives in the core runtime. */
export type SessionRecordSources = SqlClient.SqlClient | SeatSessionRepository | WorkService;

export type SessionClose = {
  readonly seat: SeatAddress;
  /** The session that just ended. */
  readonly sessionId: string;
  readonly endedAt: number;
  readonly endedBy: SessionEndedBy;
};

/** Write the record of a session that just ended. Stub: the builder lands next. */
export const recordSessionAtClose = (_close: SessionClose): Effect.Effect<void, never, SessionRecordSources> =>
  Effect.void;
