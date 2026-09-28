import { Context, Effect, Layer, Schema } from "effect";
import {
  newestSessionsFirst,
  SEAT_SESSION_END_REASONS,
  type SeatSession,
  type SeatSessionEndReason,
} from "@shared/seat-sessions";
import { StateEngine, type StateEngineError, type StateRow, type StateWriter } from "../state/service";
import { defaultSeatsRoot, seatSessionNotesPath, writeNotesFile } from "./notes-file";

export class SeatSessionPersistenceError extends Schema.TaggedError<SeatSessionPersistenceError>()(
  "SeatSessionPersistenceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

/** A seat's session as the canvas names it: harness, id, and working directory. */
export type SeatSessionObservation = {
  readonly seatId: string;
  readonly sessionId: string;
  readonly harness: string;
  readonly cwd?: string;
  /**
   * Why the seat's open session (if it is another one) ends as this one
   * starts. Defaults to `replaced`.
   */
  readonly endReason?: SeatSessionEndReason;
};

export type SeatSessionRecordOutcome = {
  /** The observed session was not the seat's open one before. */
  readonly started: boolean;
  /** The session this one replaced, when there was one. */
  readonly ended?: string;
};

export type SeatSessionOffboard = SeatSessionObservation & {
  readonly notes: string;
  readonly gist?: string;
};

/**
 * Every harness session each agent seat has run (`seat_sessions`), and the
 * notes the seat's agent left for each. The canvas recorder writes a row when
 * a seat's session id changes; `junto offboard` writes the notes.
 */
export class SeatSessionRepository extends Context.Service<SeatSessionRepository,
  {
    /** Where this seat's notes for this session live (the file may not exist yet). */
    readonly notesPathFor: (seatId: string, sessionId: string) => string;
    /**
     * Make the observed session the seat's open one. Idempotent: observing the
     * open session again changes nothing. Another open session ends first; an
     * earlier session seen again is reopened with its history.
     */
    readonly record: (
      observation: SeatSessionObservation,
    ) => Effect.Effect<SeatSessionRecordOutcome, SeatSessionPersistenceError>;
    /** End the seat's open session, when it is still `sessionId` if given. */
    readonly end: (
      seatId: string,
      reason: SeatSessionEndReason,
      sessionId?: string,
    ) => Effect.Effect<string | undefined, SeatSessionPersistenceError>;
    /** The seat's sessions, newest first. */
    readonly list: (seatId: string) => Effect.Effect<ReadonlyArray<SeatSession>, SeatSessionPersistenceError>;
    /** Write the session's notes file, then record it as offboarded. */
    readonly offboard: (input: SeatSessionOffboard) => Effect.Effect<SeatSession, SeatSessionPersistenceError>;
    /** Remember where the harness keeps a session once it is found. */
    readonly noteTranscript: (
      seatId: string,
      sessionId: string,
      path: string,
    ) => Effect.Effect<void, SeatSessionPersistenceError>;
  }>()("@junto/SeatSessionRepository") {}

type SessionRow = StateRow & {
  readonly seat_id: string;
  readonly session_id: string;
  readonly harness: string;
  readonly cwd: string | null;
  readonly transcript_path: string | null;
  readonly notes_path: string;
  readonly gist: string | null;
  readonly started_at: number;
  readonly ended_at: number | null;
  readonly end_reason: string | null;
  readonly offboarded_at: number | null;
};

const COLUMNS =
  "seat_id, session_id, harness, cwd, transcript_path, notes_path, gist, started_at, ended_at, end_reason, offboarded_at";

const isEndReason = (value: string | null): value is SeatSessionEndReason =>
  value !== null && (SEAT_SESSION_END_REASONS as ReadonlyArray<string>).includes(value);

const fromRow = (row: SessionRow): SeatSession => ({
  seatId: row.seat_id,
  sessionId: row.session_id,
  harness: row.harness,
  ...(row.transcript_path ? { transcriptPath: row.transcript_path } : {}),
  notesPath: row.notes_path,
  ...(row.gist ? { gist: row.gist } : {}),
  startedAt: Number(row.started_at),
  ...(row.ended_at === null ? {} : { endedAt: Number(row.ended_at) }),
  ...(isEndReason(row.end_reason) ? { endReason: row.end_reason } : {}),
  ...(row.offboarded_at === null ? {} : { offboardedAt: Number(row.offboarded_at) }),
});

const persistence = (operation: string) => (error: StateEngineError) =>
  SeatSessionPersistenceError.make({ operation, message: error.message, cause: error });

const bounded = (value: string | undefined, max: number): string | null => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
};

/** `seatsRoot` defaults to `~/.junto/seats` under the Junto home at build time. */
export const makeSeatSessionRepositoryLive = (
  seatsRoot?: string,
): Layer.Layer<SeatSessionRepository, never, StateEngine> =>
  Layer.effect(
    SeatSessionRepository,
    Effect.gen(function* () {
      const state = yield* StateEngine;
      const root = seatsRoot ?? defaultSeatsRoot();
      const notesPathFor = (seatId: string, sessionId: string) =>
        seatSessionNotesPath(root, seatId, sessionId);

      const openRow = (writer: StateWriter, seatId: string) =>
        writer.get<SessionRow>(`SELECT ${COLUMNS} FROM seat_sessions WHERE seat_id = ? AND ended_at IS NULL`, [seatId]);

      const recordIn = (
        writer: StateWriter,
        observation: SeatSessionObservation,
        now: number,
      ): SeatSessionRecordOutcome => {
        const { seatId, sessionId, harness } = observation;
        const cwd = bounded(observation.cwd, 4096);
        const open = openRow(writer, seatId);
        if (open?.session_id === sessionId) return { started: false };
        if (open !== undefined) {
          writer.run(
            "UPDATE seat_sessions SET ended_at = ?, end_reason = ? WHERE seat_id = ? AND session_id = ?",
            [Math.max(now, Number(open.started_at)), observation.endReason ?? "replaced", seatId, open.session_id],
          );
        }
        const known = writer.get<SessionRow>(
          "SELECT session_id FROM seat_sessions WHERE seat_id = ? AND session_id = ?",
          [seatId, sessionId],
        );
        if (known !== undefined) {
          writer.run(
            "UPDATE seat_sessions SET ended_at = NULL, end_reason = NULL, harness = ?, cwd = COALESCE(?, cwd) WHERE seat_id = ? AND session_id = ?",
            [harness, cwd, seatId, sessionId],
          );
        } else {
          writer.run(
            `INSERT INTO seat_sessions(seat_id, session_id, harness, cwd, notes_path, started_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [seatId, sessionId, harness, cwd, notesPathFor(seatId, sessionId), now],
          );
        }
        return { started: true, ...(open ? { ended: open.session_id } : {}) };
      };

      const record = (observation: SeatSessionObservation) =>
        state
          .transaction("seat-sessions.record", (writer) => recordIn(writer, observation, Date.now()))
          .pipe(Effect.mapError(persistence("record")));

      const end = (seatId: string, reason: SeatSessionEndReason, sessionId?: string) =>
        state
          .transaction("seat-sessions.end", (writer) => {
            const open = openRow(writer, seatId);
            if (open === undefined) return undefined;
            if (sessionId !== undefined && open.session_id !== sessionId) return undefined;
            writer.run(
              "UPDATE seat_sessions SET ended_at = ?, end_reason = ? WHERE seat_id = ? AND session_id = ?",
              [Math.max(Date.now(), Number(open.started_at)), reason, seatId, open.session_id],
            );
            return open.session_id;
          })
          .pipe(Effect.mapError(persistence("end")));

      const list = (seatId: string) =>
        state
          .read("seat-sessions.list", (reader) =>
            newestSessionsFirst(
              reader
                .all<SessionRow>(`SELECT ${COLUMNS} FROM seat_sessions WHERE seat_id = ?`, [seatId])
                .map(fromRow),
            ),
          )
          .pipe(Effect.mapError(persistence("list")));

      const offboard = (input: SeatSessionOffboard) =>
        Effect.gen(function* () {
          const path = notesPathFor(input.seatId, input.sessionId);
          yield* Effect.try({
            try: () => writeNotesFile(path, input.notes),
            catch: (cause) =>
              SeatSessionPersistenceError.make({
                operation: "offboard.notes",
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          });
          return yield* state
            .transaction("seat-sessions.offboard", (writer) => {
              const now = Date.now();
              // The offboarding session is the seat's current one; a seat whose
              // id the recorder has not seen yet starts its history here.
              recordIn(writer, input, now);
              writer.run(
                "UPDATE seat_sessions SET gist = ?, offboarded_at = ?, notes_path = ? WHERE seat_id = ? AND session_id = ?",
                [bounded(input.gist, 200), now, path, input.seatId, input.sessionId],
              );
              return fromRow(
                writer.get<SessionRow>(
                  `SELECT ${COLUMNS} FROM seat_sessions WHERE seat_id = ? AND session_id = ?`,
                  [input.seatId, input.sessionId],
                )!,
              );
            })
            .pipe(Effect.mapError(persistence("offboard")));
        });

      const noteTranscript = (seatId: string, sessionId: string, path: string) =>
        state
          .transaction("seat-sessions.transcript", (writer) => {
            const value = bounded(path, 4096);
            if (value === null) return;
            writer.run(
              "UPDATE seat_sessions SET transcript_path = ? WHERE seat_id = ? AND session_id = ?",
              [value, seatId, sessionId],
            );
          })
          .pipe(Effect.mapError(persistence("transcript")));

      return SeatSessionRepository.of({ notesPathFor, record, end, list, offboard, noteTranscript });
    }),
  );

export const SeatSessionRepositoryLive = makeSeatSessionRepositoryLive();
