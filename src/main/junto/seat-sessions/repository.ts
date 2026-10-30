import { Cause, Context, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlError, SqlSchema } from "effect/unstable/sql";
import { OFFBOARD_BY, type OffboardBy } from "@shared/seat-offboard";
import {
  newestSessionsFirst,
  SEAT_SESSION_CONTINUATION_MAX_CHARS,
  SEAT_SESSION_DRAIN_ENDS,
  SEAT_SESSION_END_REASONS,
  SEAT_SESSION_NOTES_MAX_CHARS,
  type SeatSession,
  type SeatSessionDrainEnd,
  type SeatSessionEndReason,
} from "@shared/seat-sessions";
import { StateTransactionOperation } from "../state/service";
import { type Fidelity, type HarnessChannel, SESSION_LOCATION_PATH_MAX } from "@shared/harness-domain";
import { admitReportedSessionLocation, harnessSessionLocation } from "../term/session-existence";
import type { SeatClockChanges, SeatClockRecord } from "./operator-offboard";

export class SeatSessionPersistenceError extends Schema.TaggedError<SeatSessionPersistenceError>()(
  "SeatSessionPersistenceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

/** A harness session owned by this machine's seat. */
export type SeatSessionObservation = {
  readonly seatId: string;
  readonly sessionId: string;
  readonly harness: string;
  readonly bindingId?: string;
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

/** What a session's agent left at its offboard: its notes, and the note for the next session. */
export type SeatSessionNotes = {
  readonly notes: string;
  readonly continuation?: string;
};

/**
 * A seat owed its continuation line: which binding is told, and the
 * generation that offboarded, which never is.
 */
export type OwedContinuation = {
  readonly seatId: string;
  readonly bindingId: string;
  readonly offboarded?: string;
  readonly at: number;
};

/**
 * Every harness session each agent seat has run (`seat_sessions`), and the
 * notes the seat's agent left for each. The open row is its durable resume
 * pin, independent of whether its process is running.
 */
export class SeatSessionRepository extends Context.Service<SeatSessionRepository,
  {
    /**
     * Make the observed session the seat's open one. Idempotent: observing the
     * open session again changes nothing. Another open session ends first; an
     * earlier session seen again is reopened with its history.
     */
    readonly record: (
      observation: SeatSessionObservation,
    ) => Effect.Effect<SeatSessionRecordOutcome, SeatSessionPersistenceError>;
    /** The open session of this occupant, never the newest ended session. */
    readonly current: (
      seatId: string,
      bindingId: string,
    ) => Effect.Effect<SeatSessionObservation | undefined, SeatSessionPersistenceError>;
    /** Atomically keep this occupant's pin, or record one before its process starts. */
    readonly pin: (
      observation: SeatSessionObservation & { readonly bindingId: string },
    ) => Effect.Effect<{ readonly sessionId: string; readonly minted: boolean }, SeatSessionPersistenceError>;
    /** A capture cannot take another seat's session, including its ended history. */
    readonly ownedByOtherSeat: (
      observation: SeatSessionObservation,
    ) => Effect.Effect<boolean, SeatSessionPersistenceError>;
    /**
     * End the seat's open session, when it is still `sessionId` if given. Like
     * every close, it saves where the harness keeps the session, if it does.
     */
    readonly end: (
      seatId: string,
      reason: SeatSessionEndReason,
      sessionId?: string,
      bindingId?: string,
    ) => Effect.Effect<string | undefined, SeatSessionPersistenceError>;
    /** The seat's sessions, newest first. */
    readonly list: (seatId: string) => Effect.Effect<ReadonlyArray<SeatSession>, SeatSessionPersistenceError>;
    /**
     * The two rows a card needs of those sessions: the open one on this
     * binding, and why the latest ended session ended. Never the history.
     */
    readonly launch: (
      seatId: string,
      bindingId: string,
    ) => Effect.Effect<
      { readonly open?: SeatSessionObservation; readonly lastEnded?: SeatSessionEndReason },
      SeatSessionPersistenceError
    >;
    /** Keep the session's notes (and continuation) on its row, and record it as offboarded. */
    readonly offboard: (input: SeatSessionOffboard) => Effect.Effect<SeatSession, SeatSessionPersistenceError>;
    /**
     * The notes of these sessions of the seat, by session id. A session that
     * never offboarded has none and is absent. Read only for the few sessions
     * shown in full, so a long history never loads every session's text.
     */
    readonly notesOf: (
      seatId: string,
      sessionIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, SeatSessionNotes>, SeatSessionPersistenceError>;
    /** Whether the seat's agent ran `junto onboard` in this session. */
    readonly onboarded: (seatId: string, sessionId: string) => Effect.Effect<boolean, SeatSessionPersistenceError>;
    /** The seat's agent ran `junto onboard` in this session. The first time stands. */
    readonly markOnboarded: (
      seatId: string,
      sessionId: string,
      at: number,
    ) => Effect.Effect<void, SeatSessionPersistenceError>;
    /** The seat is owed its continuation line; it replaces whatever it was owed before. */
    readonly oweContinuation: (owed: OwedContinuation) => Effect.Effect<void, SeatSessionPersistenceError>;
    /** Every continuation still owed, oldest first. */
    readonly owedContinuations: () => Effect.Effect<ReadonlyArray<OwedContinuation>, SeatSessionPersistenceError>;
    /** The line was typed, or is owed no more. */
    readonly settleContinuation: (bindingId: string) => Effect.Effect<void, SeatSessionPersistenceError>;
    /** The operator offboard clock as last saved; undefined before it ever was. */
    readonly offboardClock: () => Effect.Effect<SeatClockRecord | undefined, SeatSessionPersistenceError>;
    /** Save the operator offboard clock whole: it replaces the one saved before. */
    readonly saveOffboardClock: (record: SeatClockRecord) => Effect.Effect<void, SeatSessionPersistenceError>;
    /** Save only what changed on the clock: the seats named are written, the removed ones go. */
    readonly saveOffboardClockChanges: (changes: SeatClockChanges) => Effect.Effect<void, SeatSessionPersistenceError>;
    /** Every open session, at most one per seat: each seat's current session in one read. */
    readonly openSessions: () => Effect.Effect<
      ReadonlyArray<{ readonly seatId: string; readonly sessionId: string; readonly bindingId?: string }>,
      SeatSessionPersistenceError
    >;
    /** Who ended this session from outside it (the operator, an overseer, the automatic rule). */
    readonly markEnded: (
      seatId: string,
      sessionId: string,
      by: OffboardBy,
    ) => Effect.Effect<void, SeatSessionPersistenceError>;
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
    /**
     * The offboard that detached this session did not go through and the
     * session is the seat's again: it was not offboarded, so it has no
     * wind-down to show. A wind-down that already ended is history and stays.
     */
    readonly cancelDrain: (seatId: string, sessionId: string) => Effect.Effect<void, SeatSessionPersistenceError>;
    /** Remember where the harness keeps a session once it is found. */
    readonly noteTranscript: (
      seatId: string,
      sessionId: string,
      path: string,
    ) => Effect.Effect<void, SeatSessionPersistenceError>;
    /**
     * Where the harness says one of its sessions lives, under the harness
     * contract. Kept on that session's row only while the row has no path,
     * and only when the path resolves inside the harness's store here.
     * Answers whether it was kept.
     */
    readonly noteReportedTranscript: (report: SeatSessionReport) => Effect.Effect<boolean, SeatSessionPersistenceError>;
  }>()("@junto/SeatSessionRepository") {}

/** A seat's harness naming where one of its sessions lives, on a channel. */
export type SeatSessionReport = {
  readonly bindingId: string;
  readonly sessionId: string;
  readonly path: string;
  readonly channel: HarnessChannel;
  readonly fidelity: Fidelity;
};

const SessionRow = Schema.Struct({
  seat_id: Schema.String,
  session_id: Schema.String,
  harness: Schema.String,
  binding_id: Schema.NullOr(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  transcript_path: Schema.NullOr(Schema.String),
  gist: Schema.NullOr(Schema.String),
  started_at: Schema.Number,
  ended_at: Schema.NullOr(Schema.Number),
  end_reason: Schema.NullOr(Schema.String),
  ended_by: Schema.NullOr(Schema.String),
  offboarded_at: Schema.NullOr(Schema.Number),
  drain_detached_at: Schema.NullOr(Schema.Number),
  drain_ended_at: Schema.NullOr(Schema.Number),
  drain_ended_how: Schema.NullOr(Schema.String),
});

/** The columns a launch glance reads: no transcript, no gist, no drain. */
const LAUNCH_COLUMNS =
  "seat_id, session_id, harness, binding_id, cwd, started_at, ended_at, end_reason";
const LaunchRow = Schema.Struct({
  seat_id: Schema.String,
  session_id: Schema.String,
  harness: Schema.String,
  binding_id: Schema.NullOr(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  started_at: Schema.Number,
  ended_at: Schema.NullOr(Schema.Number),
  end_reason: Schema.NullOr(Schema.String),
});
const COLUMNS =
  "s.seat_id, s.session_id, s.harness, s.binding_id, s.cwd, s.transcript_path, s.gist, s.started_at, s.ended_at, s.end_reason, s.ended_by, s.offboarded_at, " +
  "d.detached_at AS drain_detached_at, d.ended_at AS drain_ended_at, d.ended_how AS drain_ended_how";

/** A session with what became of its process after it offboarded, if it did. */
const SESSIONS =
  "seat_sessions s LEFT JOIN seat_session_drains d ON d.seat_id = s.seat_id AND d.session_id = s.session_id";

const isDrainEnd = (value: string | null): value is SeatSessionDrainEnd =>
  value !== null && (SEAT_SESSION_DRAIN_ENDS as ReadonlyArray<string>).includes(value);

const isEndReason = (value: string | null): value is SeatSessionEndReason =>
  value !== null && (SEAT_SESSION_END_REASONS as ReadonlyArray<string>).includes(value);

const isEndedBy = (value: string | null): value is OffboardBy =>
  value !== null && (OFFBOARD_BY as ReadonlyArray<string>).includes(value);

const sessionOf = (row: typeof SessionRow.Type): SeatSession => ({
  seatId: row.seat_id,
  sessionId: row.session_id,
  harness: row.harness,
  ...(row.transcript_path ? { transcriptPath: row.transcript_path } : {}),
  ...(row.gist ? { gist: row.gist } : {}),
  startedAt: Number(row.started_at),
  ...(row.ended_at === null ? {} : { endedAt: Number(row.ended_at) }),
  ...(isEndReason(row.end_reason) ? { endReason: row.end_reason } : {}),
  ...(isEndedBy(row.ended_by) ? { endedBy: row.ended_by } : {}),
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

/** Markdown an agent wrote, trimmed and cut at its bound; null when empty. */
const text = (value: string | undefined, max: number): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max).trimEnd() : null;
};

const probeOf = (row: typeof SessionRow.Type) =>
  ({ harness: row.harness, sessionId: row.session_id, ...(row.cwd ? { cwd: row.cwd } : {}) });

/** Where the harness keeps a closing session, when it keeps one at all. */
const transcriptAtClose = (row: typeof SessionRow.Type): string | null =>
  row.transcript_path ?? bounded(harnessSessionLocation(probeOf(row)), SESSION_LOCATION_PATH_MAX);

export const makeSeatSessionRepositoryLive = (): Layer.Layer<SeatSessionRepository, never, SqlClient.SqlClient> =>
  Layer.effect(
    SeatSessionRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

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
      // The open row, and the latest started one that ended: at most two rows.
      const launchRows = SqlSchema.findAll({
        Request: Schema.String,
        Result: LaunchRow,
        execute: (seatId) => sql.unsafe(
          `SELECT ${LAUNCH_COLUMNS} FROM seat_sessions WHERE seat_id = ? AND ended_at IS NULL
           UNION ALL
           SELECT * FROM (SELECT ${LAUNCH_COLUMNS} FROM seat_sessions WHERE seat_id = ? AND ended_at IS NOT NULL
             ORDER BY started_at DESC LIMIT 1)`,
          [seatId, seatId],
        ),
      });

      // Every close, whatever ends the session, saves where the harness keeps
      // it, so an ended session's record never waits on a later lookup.
      const closeRow = (open: typeof SessionRow.Type, reason: SeatSessionEndReason, now: number) => sql`
        UPDATE seat_sessions SET ended_at = ${Math.max(now, Number(open.started_at))}, end_reason = ${reason},
          transcript_path = ${transcriptAtClose(open)}
        WHERE seat_id = ${open.seat_id} AND session_id = ${open.session_id}
      `;

      const recordIn = Effect.fn("seat-sessions.record-in")(function* (
        observation: SeatSessionObservation,
        now: number,
      ) {
        const { seatId, sessionId, harness } = observation;
        const cwd = bounded(observation.cwd, 4096);
        const current = yield* openRow(seatId);
        const open = current._tag === "None" ? undefined : current.value;
        if (open?.session_id === sessionId) {
          if (observation.bindingId !== undefined && open.binding_id === null)
            yield* sql`UPDATE seat_sessions SET binding_id = ${observation.bindingId} WHERE seat_id = ${seatId} AND session_id = ${sessionId}`;
          return { started: false };
        }
        if (open !== undefined) yield* closeRow(open, observation.endReason ?? "replaced", now);
        const known = yield* knownRow([seatId, sessionId]);
        if (known._tag === "Some") {
          yield* sql`
            UPDATE seat_sessions SET ended_at = NULL, end_reason = NULL, ended_by = NULL, harness = ${harness}, binding_id = ${observation.bindingId ?? null}, cwd = COALESCE(${cwd}, cwd)
            WHERE seat_id = ${seatId} AND session_id = ${sessionId}
          `;
        } else {
          yield* sql`
            INSERT INTO seat_sessions(seat_id, session_id, harness, binding_id, cwd, started_at)
            VALUES (${seatId}, ${sessionId}, ${harness}, ${observation.bindingId ?? null}, ${cwd}, ${now})
          `;
        }
        return { started: true, ...(open ? { ended: open.session_id } : {}) };
      });

      const record = Effect.fn("seat-sessions.record")(function* (observation: SeatSessionObservation) {
        return yield* recordIn(observation, Date.now());
      }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "seat-sessions.record"),
      Effect.mapError(persistence("record")));

      const current = Effect.fn("seat-sessions.current")(function* (seatId: string, bindingId: string) {
        const open = yield* openRow(seatId);
        if (open._tag === "None" || open.value.binding_id !== bindingId) return undefined;
        const row = open.value;
        return { seatId, sessionId: row.session_id, harness: row.harness, bindingId,
          ...(row.cwd ? { cwd: row.cwd } : {}) } satisfies SeatSessionObservation;
      }, Effect.mapError(persistence("current")));

      const pin = Effect.fn("seat-sessions.pin")(function* (observation: SeatSessionObservation & { readonly bindingId: string }) {
        const existing = yield* current(observation.seatId, observation.bindingId);
        if (existing !== undefined && existing.harness === observation.harness)
          return { sessionId: existing.sessionId, minted: false };
        yield* recordIn({ ...observation, endReason: "reseat" }, Date.now());
        return { sessionId: observation.sessionId, minted: true };
      }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "seat-sessions.pin"),
      Effect.mapError((cause) => cause instanceof SeatSessionPersistenceError ? cause : persistence("pin")(cause)));

      const ownedByOtherSeat = Effect.fn("seat-sessions.owner")(function* (observation: SeatSessionObservation) {
        const rows = yield* sql`SELECT seat_id FROM seat_sessions WHERE harness = ${observation.harness}
          AND session_id = ${observation.sessionId} AND seat_id <> ${observation.seatId} LIMIT 1`;
        return rows.length !== 0;
      }, Effect.mapError(persistence("owner")));

      const end = Effect.fn("seat-sessions.end")(function* (seatId: string, reason: SeatSessionEndReason, sessionId?: string, bindingId?: string) {
        const current = yield* openRow(seatId);
        if (current._tag === "None") return undefined;
        const open = current.value;
        if (sessionId !== undefined && open.session_id !== sessionId) return undefined;
        if (bindingId !== undefined && open.binding_id !== bindingId) return undefined;
        yield* closeRow(open, reason, Date.now());
        return open.session_id;
      }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "seat-sessions.end"),
      Effect.mapError(persistence("end")));

      const list = Effect.fn("seat-sessions.list")(function* (seatId: string) {
        return newestSessionsFirst((yield* seatRows(seatId)).map(sessionOf));
      }, Effect.mapError(persistence("list")));

      /**
       * What a card asks of a seat's sessions: the open session on this
       * binding, and why its latest ended one ended. One statement, two rows
       * at most, so a long history never loads for a glance.
       */
      const launch = Effect.fn("seat-sessions.launch")(function* (seatId: string, bindingId: string) {
        const rows = yield* launchRows(seatId);
        const open = rows.find((row) => row.ended_at === null);
        const ended = rows.find((row) => row.ended_at !== null);
        const lastEnded = ended === undefined || !isEndReason(ended.end_reason) ? undefined : ended.end_reason;
        return {
          ...(open !== undefined && open.binding_id === bindingId
            ? {
                open: {
                  seatId,
                  sessionId: open.session_id,
                  harness: open.harness,
                  bindingId,
                  ...(open.cwd ? { cwd: open.cwd } : {}),
                } satisfies SeatSessionObservation,
              }
            : {}),
          ...(lastEnded === undefined ? {} : { lastEnded }),
        };
      }, Effect.mapError(persistence("launch")));

      const offboard = Effect.fn("seat-sessions.offboard")(function* (input: SeatSessionOffboard) {
        return yield* sql.withTransaction(Effect.gen(function* () {
          const now = Date.now();
          // The offboarding session is the seat's current one; a seat whose
          // id the recorder has not seen yet starts its history here.
          yield* recordIn(input, now);
          yield* sql`
            UPDATE seat_sessions SET gist = ${bounded(input.gist, 200)}, offboarded_at = ${now},
              notes = ${text(input.notes, SEAT_SESSION_NOTES_MAX_CHARS)},
              continuation = ${text(input.continuation, SEAT_SESSION_CONTINUATION_MAX_CHARS)}
            WHERE seat_id = ${input.seatId} AND session_id = ${input.sessionId}
          `;
          return sessionOf(yield* oneRow([input.seatId, input.sessionId]));
        })).pipe(
          Effect.provideService(StateTransactionOperation, "seat-sessions.offboard"),
          Effect.mapError(persistence("offboard")),
        );
      });

      const notesRows = SqlSchema.findAll({
        Request: Schema.Tuple([Schema.String, Schema.Array(Schema.String)]),
        Result: Schema.Struct({ session_id: Schema.String, notes: Schema.String, continuation: Schema.NullOr(Schema.String) }),
        execute: ([seatId, sessionIds]) =>
          sql`SELECT session_id, notes, continuation FROM seat_sessions
            WHERE seat_id = ${seatId} AND notes IS NOT NULL AND ${sql.in("session_id", sessionIds)}`,
      });

      const notesOf = Effect.fn("seat-sessions.notes")(function* (seatId: string, sessionIds: ReadonlyArray<string>) {
        const found = new Map<string, SeatSessionNotes>();
        if (sessionIds.length === 0) return found;
        for (const row of yield* notesRows([seatId, [...new Set(sessionIds)]]))
          found.set(row.session_id, { notes: row.notes, ...(row.continuation === null ? {} : { continuation: row.continuation }) });
        return found;
      }, Effect.mapError(persistence("notes")));

      const markEnded = Effect.fn("seat-sessions.ended-by")(function* (seatId: string, sessionId: string, by: OffboardBy) {
        yield* sql`UPDATE seat_sessions SET ended_by = ${by} WHERE seat_id = ${seatId} AND session_id = ${sessionId}`;
      }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "seat-sessions.ended-by"),
      Effect.mapError(persistence("ended-by")));

      const onboardedRow = SqlSchema.findOneOption({
        Request: Schema.Tuple([Schema.String, Schema.String]),
        Result: Schema.Struct({ onboarded_at: Schema.NullOr(Schema.Number) }),
        execute: ([seatId, sessionId]) =>
          sql`SELECT onboarded_at FROM seat_sessions WHERE seat_id = ${seatId} AND session_id = ${sessionId}`,
      });

      const onboarded = Effect.fn("seat-sessions.onboarded")(function* (seatId: string, sessionId: string) {
        const row = yield* onboardedRow([seatId, sessionId]);
        return row._tag === "Some" && row.value.onboarded_at !== null;
      }, Effect.mapError(persistence("onboarded")));

      const markOnboarded = Effect.fn("seat-sessions.onboarded.mark")(function* (seatId: string, sessionId: string, at: number) {
        yield* sql`UPDATE seat_sessions SET onboarded_at = COALESCE(onboarded_at, ${Math.max(0, Math.floor(at))})
          WHERE seat_id = ${seatId} AND session_id = ${sessionId}`;
      }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "seat-sessions.onboarded.mark"),
      Effect.mapError(persistence("onboarded.mark")));

      const oweContinuation = Effect.fn("seat-sessions.continuation.owe")(function* (owed: OwedContinuation) {
        // One owed line per seat and per binding: a later one replaces it.
        yield* sql`INSERT OR REPLACE INTO seat_continuations_owed(seat_id, binding_id, offboarded_generation, owed_at)
          VALUES (${owed.seatId}, ${owed.bindingId}, ${owed.offboarded ?? null}, ${Math.max(0, Math.floor(owed.at))})`;
      }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "seat-sessions.continuation.owe"),
      Effect.mapError(persistence("continuation.owe")));

      const owedRows = SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({
          seat_id: Schema.String,
          binding_id: Schema.String,
          offboarded_generation: Schema.NullOr(Schema.String),
          owed_at: Schema.Number,
        }),
        execute: () => sql`SELECT seat_id, binding_id, offboarded_generation, owed_at FROM seat_continuations_owed ORDER BY owed_at, seat_id`,
      });

      const owedContinuations = Effect.fn("seat-sessions.continuation.owed")(function* () {
        return (yield* owedRows(undefined)).map((row): OwedContinuation => ({
          seatId: row.seat_id,
          bindingId: row.binding_id,
          ...(row.offboarded_generation === null ? {} : { offboarded: row.offboarded_generation }),
          at: Number(row.owed_at),
        }));
      }, Effect.mapError(persistence("continuation.owed")));

      const settleContinuation = Effect.fn("seat-sessions.continuation.settle")(function* (bindingId: string) {
        yield* sql`DELETE FROM seat_continuations_owed WHERE binding_id = ${bindingId}`;
      }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "seat-sessions.continuation.settle"),
      Effect.mapError(persistence("continuation.settle")));

      const clockRows = SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({
          binding_id: Schema.String,
          idle_since: Schema.NullOr(Schema.Number),
          activity_since: Schema.NullOr(Schema.Number),
          offboarded: Schema.Number,
          work_ms: Schema.Number,
          session_id: Schema.NullOr(Schema.String),
          saved_at: Schema.Number,
        }),
        execute: () => sql`SELECT binding_id, idle_since, activity_since, offboarded, work_ms, session_id, saved_at
          FROM seat_offboard_clock ORDER BY binding_id`,
      });

      const offboardClock = Effect.fn("seat-sessions.clock")(function* () {
        const rows = yield* clockRows(undefined);
        if (rows.length === 0) return undefined;
        const seats: Record<string, SeatClockRecord["seats"][string]> = {};
        for (const row of rows) {
          seats[row.binding_id] = {
            ...(row.idle_since === null ? {} : { idleSince: Number(row.idle_since) }),
            ...(row.activity_since === null ? {} : { activitySince: Number(row.activity_since) }),
            ...(row.offboarded === 1 ? { offboarded: true } : {}),
            ...(row.work_ms > 0 ? { workMs: Number(row.work_ms) } : {}),
            ...(row.session_id === null ? {} : { sessionId: row.session_id }),
          };
        }
        return { savedAt: Math.max(...rows.map((row) => Number(row.saved_at))), seats } satisfies SeatClockRecord;
      }, Effect.mapError(persistence("clock")));

      /** An epoch time as the clock table keeps it: whole, never negative. */
      const at = (value: number | undefined): number | null =>
        value === undefined || !Number.isFinite(value) ? null : Math.max(0, Math.floor(value));

      const saveOffboardClock = Effect.fn("seat-sessions.clock.save")(function* (record: SeatClockRecord) {
        const savedAt = at(record.savedAt) ?? 0;
        yield* sql`DELETE FROM seat_offboard_clock`;
        for (const [bindingId, seat] of Object.entries(record.seats)) {
          if (!bindingId) continue;
          yield* sql`INSERT INTO seat_offboard_clock(binding_id, idle_since, activity_since, offboarded, work_ms, session_id, saved_at)
            VALUES (${bindingId}, ${at(seat.idleSince)}, ${at(seat.activitySince)}, ${seat.offboarded === true ? 1 : 0},
              ${at(seat.workMs) ?? 0}, ${seat.sessionId?.trim() ? seat.sessionId.trim() : null}, ${savedAt})`;
        }
      }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "seat-sessions.clock.save"),
      Effect.mapError(persistence("clock.save")));

      const saveOffboardClockChanges = Effect.fn("seat-sessions.clock.changes")(function* (changes: SeatClockChanges) {
        const savedAt = at(changes.savedAt) ?? 0;
        for (const bindingId of changes.removed) yield* sql`DELETE FROM seat_offboard_clock WHERE binding_id = ${bindingId}`;
        for (const [bindingId, seat] of Object.entries(changes.seats)) {
          if (!bindingId) continue;
          yield* sql`INSERT INTO seat_offboard_clock(binding_id, idle_since, activity_since, offboarded, work_ms, session_id, saved_at)
            VALUES (${bindingId}, ${at(seat.idleSince)}, ${at(seat.activitySince)}, ${seat.offboarded === true ? 1 : 0},
              ${at(seat.workMs) ?? 0}, ${seat.sessionId?.trim() ? seat.sessionId.trim() : null}, ${savedAt})
            ON CONFLICT(binding_id) DO UPDATE SET idle_since = excluded.idle_since, activity_since = excluded.activity_since,
              offboarded = excluded.offboarded, work_ms = excluded.work_ms, session_id = excluded.session_id, saved_at = excluded.saved_at`;
        }
      }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "seat-sessions.clock.changes"),
      Effect.mapError(persistence("clock.changes")));

      const openSessionRows = SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ seat_id: Schema.String, session_id: Schema.String, binding_id: Schema.NullOr(Schema.String) }),
        // The one-open-per-seat index: as many rows as seats, never the history.
        execute: () => sql`SELECT seat_id, session_id, binding_id FROM seat_sessions WHERE ended_at IS NULL`,
      });

      const openSessions = Effect.fn("seat-sessions.open")(function* () {
        return (yield* openSessionRows(undefined)).map((row) => ({
          seatId: row.seat_id,
          sessionId: row.session_id,
          ...(row.binding_id === null ? {} : { bindingId: row.binding_id }),
        }));
      }, Effect.mapError(persistence("open")));

      const noteTranscript = Effect.fn("seat-sessions.transcript")(function* (seatId: string, sessionId: string, path: string) {
        const value = bounded(path, 4096);
        if (value === null) return;
        yield* sql`UPDATE seat_sessions SET transcript_path = ${value} WHERE seat_id = ${seatId} AND session_id = ${sessionId}`;
      }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "seat-sessions.transcript"),
      Effect.mapError(persistence("transcript")));

      const reportedRow = SqlSchema.findOneOption({
        Request: Schema.Tuple([Schema.String, Schema.String]),
        Result: SessionRow,
        execute: ([bindingId, sessionId]) =>
          sql.unsafe(`SELECT ${COLUMNS} FROM ${SESSIONS} WHERE s.binding_id = ? AND s.session_id = ?`, [bindingId, sessionId]),
      });

      const noteReportedTranscript = Effect.fn("seat-sessions.transcript.reported")(function* (report: SeatSessionReport) {
        const found = yield* reportedRow([report.bindingId, report.sessionId]);
        if (found._tag === "None" || found.value.transcript_path !== null) return false;
        const row = found.value;
        const location = admitReportedSessionLocation(probeOf(row), report);
        const value = bounded(location?.path, SESSION_LOCATION_PATH_MAX);
        if (value === null) return false;
        yield* sql`UPDATE seat_sessions SET transcript_path = ${value}
          WHERE seat_id = ${row.seat_id} AND session_id = ${row.session_id} AND transcript_path IS NULL`;
        return true;
      }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "seat-sessions.transcript.reported"),
      Effect.mapError(persistence("transcript.reported")));

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

      const cancelDrain = Effect.fn("seat-sessions.drain.cancel")(function* (seatId: string, sessionId: string) {
        yield* sql`
          DELETE FROM seat_session_drains
          WHERE seat_id = ${seatId} AND session_id = ${sessionId} AND ended_at IS NULL
        `;
      }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "seat-sessions.drain.cancel"),
      Effect.mapError(persistence("drain.cancel")));

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
        record,
        current,
        pin,
        ownedByOtherSeat,
        end,
        list,
        launch,
        offboard,
        notesOf,
        markEnded,
        onboarded,
        markOnboarded,
        oweContinuation,
        owedContinuations,
        settleContinuation,
        offboardClock,
        saveOffboardClock,
        saveOffboardClockChanges,
        openSessions,
        noteTranscript,
        noteReportedTranscript,
        beginDrain,
        endDrain,
        closeOpenDrains,
        cancelDrain,
      });
    }),
  );

export const SeatSessionRepositoryLive = makeSeatSessionRepositoryLive();
