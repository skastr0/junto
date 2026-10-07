import { Cause, Context, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlError, SqlSchema } from "effect/unstable/sql";
import {
  newestSessionsFirst,
  SEAT_SESSION_DRAIN_ENDS,
  SEAT_SESSION_END_REASONS,
  type SeatSession,
  type SeatSessionDrainEnd,
  type SeatSessionEndReason,
} from "@shared/seat-sessions";
import { StateTransactionOperation } from "../state/service";
import {
  continuationPathOf,
  defaultSeatsRoot,
  removeNotesFile,
  seatSessionNotesPath,
  writeNotesFile,
} from "./notes-file";

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
  /**
   * The note for the next session when this one continues. Absent means the
   * session rests, and any continuation an earlier offboard left is removed.
   */
  readonly continuation?: string;
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
    /** Write the session's notes (and continuation) files, then record it as offboarded. */
    readonly offboard: (input: SeatSessionOffboard) => Effect.Effect<SeatSession, SeatSessionPersistenceError>;
    /**
     * The session offboarded and its process was detached from the seat: it
     * is winding down from `at`. Recording it again starts the wind-down over.
     * Does nothing for a session the seat has no row for.
     */
    readonly beginDrain: (
      seatId: string,
      sessionId: string,
      at: number,
    ) => Effect.Effect<void, SeatSessionPersistenceError>;
    /** The detached process ended, and how. The first end recorded stands. */
    readonly endDrain: (
      seatId: string,
      sessionId: string,
      how: SeatSessionDrainEnd,
      at: number,
    ) => Effect.Effect<void, SeatSessionPersistenceError>;
    /**
     * Close every wind-down still open, as ended by Junto quitting. Run at
     * start: a detached process does not outlive Junto. Answers how many.
     */
    readonly closeOpenDrains: (at: number) => Effect.Effect<number, SeatSessionPersistenceError>;
    /** Remember where the harness keeps a session once it is found. */
    readonly noteTranscript: (
      seatId: string,
      sessionId: string,
      path: string,
    ) => Effect.Effect<void, SeatSessionPersistenceError>;
  }>()("@junto/SeatSessionRepository") {}

const SessionRow = Schema.Struct({
  seat_id: Schema.String,
  session_id: Schema.String,
  harness: Schema.String,
  cwd: Schema.NullOr(Schema.String),
  transcript_path: Schema.NullOr(Schema.String),
  notes_path: Schema.String,
  gist: Schema.NullOr(Schema.String),
  started_at: Schema.Number,
  ended_at: Schema.NullOr(Schema.Number),
  end_reason: Schema.NullOr(Schema.String),
  offboarded_at: Schema.NullOr(Schema.Number),
  drain_detached_at: Schema.NullOr(Schema.Number),
  drain_ended_at: Schema.NullOr(Schema.Number),
  drain_ended_how: Schema.NullOr(Schema.String),
});

const COLUMNS =
  "s.seat_id, s.session_id, s.harness, s.cwd, s.transcript_path, s.notes_path, s.gist, s.started_at, s.ended_at, s.end_reason, s.offboarded_at, " +
  "d.detached_at AS drain_detached_at, d.ended_at AS drain_ended_at, d.ended_how AS drain_ended_how";

/** A session with what became of its process after it offboarded, if it did. */
const SESSIONS =
  "seat_sessions s LEFT JOIN seat_session_drains d ON d.seat_id = s.seat_id AND d.session_id = s.session_id";

const isDrainEnd = (value: string | null): value is SeatSessionDrainEnd =>
  value !== null && (SEAT_SESSION_DRAIN_ENDS as ReadonlyArray<string>).includes(value);

const isEndReason = (value: string | null): value is SeatSessionEndReason =>
  value !== null && (SEAT_SESSION_END_REASONS as ReadonlyArray<string>).includes(value);

const fromRow = (row: typeof SessionRow.Type): SeatSession => ({
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
  ...(row.drain_detached_at === null
    ? {}
    : {
        drain: {
          detachedAt: Number(row.drain_detached_at),
          ...(row.drain_ended_at === null ? {} : { endedAt: Number(row.drain_ended_at) }),
          ...(isDrainEnd(row.drain_ended_how) ? { endedHow: row.drain_ended_how } : {}),
        },
      }),
});

const persistence = (operation: string) => (error: SqlError.SqlError | Schema.SchemaError | Cause.NoSuchElementError) =>
  SeatSessionPersistenceError.make({ operation, message: error.message, cause: error });

const bounded = (value: string | undefined, max: number): string | null => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
};

/** `seatsRoot` defaults to `~/.junto/seats` under the Junto home at build time. */
export const makeSeatSessionRepositoryLive = (
  seatsRoot?: string,
): Layer.Layer<SeatSessionRepository, never, SqlClient.SqlClient> =>
  Layer.effect(
    SeatSessionRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const root = seatsRoot ?? defaultSeatsRoot();
      const notesPathFor = (seatId: string, sessionId: string) =>
        seatSessionNotesPath(root, seatId, sessionId);

      const openRow = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: SessionRow,
        execute: (seatId) => sql.unsafe(`SELECT ${COLUMNS} FROM ${SESSIONS} WHERE s.seat_id = ? AND s.ended_at IS NULL`, [seatId]),
      });
      const oneRow = SqlSchema.findOne({
        Request: Schema.Tuple([Schema.String, Schema.String]),
        Result: SessionRow,
        execute: ([seatId, sessionId]) => sql.unsafe(`SELECT ${COLUMNS} FROM ${SESSIONS} WHERE s.seat_id = ? AND s.session_id = ?`, [seatId, sessionId]),
      });
      const knownRow = SqlSchema.findOneOption({
        Request: Schema.Tuple([Schema.String, Schema.String]),
        Result: Schema.Struct({ session_id: Schema.String }),
        execute: ([seatId, sessionId]) => sql`SELECT session_id FROM seat_sessions WHERE seat_id = ${seatId} AND session_id = ${sessionId}`,
      });
      const seatRows = SqlSchema.findAll({
        Request: Schema.String,
        Result: SessionRow,
        execute: (seatId) => sql.unsafe(`SELECT ${COLUMNS} FROM ${SESSIONS} WHERE s.seat_id = ?`, [seatId]),
      });

      const recordIn = Effect.fn("seat-sessions.record-in")(function* (
        observation: SeatSessionObservation,
        now: number,
      ) {
        const { seatId, sessionId, harness } = observation;
        const cwd = bounded(observation.cwd, 4096);
        const current = yield* openRow(seatId);
        const open = current._tag === "None" ? undefined : current.value;
        if (open?.session_id === sessionId) return { started: false };
        if (open !== undefined) {
          yield* sql`
            UPDATE seat_sessions SET ended_at = ${Math.max(now, Number(open.started_at))}, end_reason = ${observation.endReason ?? "replaced"}
            WHERE seat_id = ${seatId} AND session_id = ${open.session_id}
          `;
        }
        const known = yield* knownRow([seatId, sessionId]);
        if (known._tag === "Some") {
          yield* sql`
            UPDATE seat_sessions SET ended_at = NULL, end_reason = NULL, harness = ${harness}, cwd = COALESCE(${cwd}, cwd)
            WHERE seat_id = ${seatId} AND session_id = ${sessionId}
          `;
        } else {
          yield* sql`
            INSERT INTO seat_sessions(seat_id, session_id, harness, cwd, notes_path, started_at)
            VALUES (${seatId}, ${sessionId}, ${harness}, ${cwd}, ${notesPathFor(seatId, sessionId)}, ${now})
          `;
        }
        return { started: true, ...(open ? { ended: open.session_id } : {}) };
      });

      const record = Effect.fn("seat-sessions.record")(function* (observation: SeatSessionObservation) {
        return yield* recordIn(observation, Date.now());
      }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "seat-sessions.record"),
      Effect.mapError(persistence("record")));

      const end = Effect.fn("seat-sessions.end")(function* (seatId: string, reason: SeatSessionEndReason, sessionId?: string) {
        const current = yield* openRow(seatId);
        if (current._tag === "None") return undefined;
        const open = current.value;
        if (sessionId !== undefined && open.session_id !== sessionId) return undefined;
        yield* sql`
          UPDATE seat_sessions SET ended_at = ${Math.max(Date.now(), Number(open.started_at))}, end_reason = ${reason}
          WHERE seat_id = ${seatId} AND session_id = ${open.session_id}
        `;
        return open.session_id;
      }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "seat-sessions.end"),
      Effect.mapError(persistence("end")));

      const list = Effect.fn("seat-sessions.list")(function* (seatId: string) {
        return newestSessionsFirst((yield* seatRows(seatId)).map(fromRow));
      }, Effect.mapError(persistence("list")));

      const offboard = Effect.fn("seat-sessions.offboard")(function* (input: SeatSessionOffboard) {
        const path = notesPathFor(input.seatId, input.sessionId);
        yield* Effect.try({
          try: () => {
            writeNotesFile(path, input.notes);
            // The latest offboard decides: a plain one withdraws a handoff.
            if (input.continuation === undefined) removeNotesFile(continuationPathOf(path));
            else writeNotesFile(continuationPathOf(path), input.continuation);
          },
          catch: (cause) =>
            SeatSessionPersistenceError.make({
              operation: "offboard.notes",
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        });
        return yield* sql.withTransaction(Effect.gen(function* () {
          const now = Date.now();
          // The offboarding session is the seat's current one; a seat whose
          // id the recorder has not seen yet starts its history here.
          yield* recordIn(input, now);
          yield* sql`
            UPDATE seat_sessions SET gist = ${bounded(input.gist, 200)}, offboarded_at = ${now}, notes_path = ${path}
            WHERE seat_id = ${input.seatId} AND session_id = ${input.sessionId}
          `;
          return fromRow(yield* oneRow([input.seatId, input.sessionId]));
        })).pipe(
          Effect.provideService(StateTransactionOperation, "seat-sessions.offboard"),
          Effect.mapError(persistence("offboard")),
        );
      });

      const noteTranscript = Effect.fn("seat-sessions.transcript")(function* (seatId: string, sessionId: string, path: string) {
        const value = bounded(path, 4096);
        if (value === null) return;
        yield* sql`UPDATE seat_sessions SET transcript_path = ${value} WHERE seat_id = ${seatId} AND session_id = ${sessionId}`;
      }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "seat-sessions.transcript"),
      Effect.mapError(persistence("transcript")));

      const beginDrain = Effect.fn("seat-sessions.drain.begin")(function* (seatId: string, sessionId: string, at: number) {
        const known = yield* knownRow([seatId, sessionId]);
        if (known._tag === "None") return;
        yield* sql`
          INSERT INTO seat_session_drains(seat_id, session_id, detached_at)
          VALUES (${seatId}, ${sessionId}, ${at})
          ON CONFLICT(seat_id, session_id)
          DO UPDATE SET detached_at = excluded.detached_at, ended_at = NULL, ended_how = NULL
        `;
      }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "seat-sessions.drain.begin"),
      Effect.mapError(persistence("drain.begin")));

      const endDrain = Effect.fn("seat-sessions.drain.end")(function* (
        seatId: string,
        sessionId: string,
        how: SeatSessionDrainEnd,
        at: number,
      ) {
        // The end cannot precede the detach, whatever the clocks said.
        yield* sql`
          UPDATE seat_session_drains SET ended_at = MAX(${at}, detached_at), ended_how = ${how}
          WHERE seat_id = ${seatId} AND session_id = ${sessionId} AND ended_at IS NULL
        `;
      }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "seat-sessions.drain.end"),
      Effect.mapError(persistence("drain.end")));

      const openDrains = SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ seat_id: Schema.String, session_id: Schema.String }),
        execute: () => sql`SELECT seat_id, session_id FROM seat_session_drains WHERE ended_at IS NULL`,
      });

      const closeOpenDrains = Effect.fn("seat-sessions.drain.close-open")(function* (at: number) {
        const open = yield* openDrains(undefined);
        if (open.length === 0) return 0;
        yield* sql`
          UPDATE seat_session_drains SET ended_at = MAX(${at}, detached_at), ended_how = 'quit'
          WHERE ended_at IS NULL
        `;
        return open.length;
      }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "seat-sessions.drain.close-open"),
      Effect.mapError(persistence("drain.close-open")));

      return SeatSessionRepository.of({
        notesPathFor,
        record,
        end,
        list,
        offboard,
        noteTranscript,
        beginDrain,
        endDrain,
        closeOpenDrains,
      });
    }),
  );

export const SeatSessionRepositoryLive = makeSeatSessionRepositoryLive();
