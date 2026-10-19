import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StateSchemaMigrationDatabase } from "./migrations";

/**
 * State migration 21 -> 22. A session's notes, the note for its next session,
 * who ended it and whether it onboarded were files under `~/.junto/seats`
 * beside a `notes_path` column; the continuation ledger and the offboard
 * clock were files there too. All of it lives in this database now. The step
 * rebuilds `seat_sessions` with the new columns and without `notes_path`, and
 * adds the ledger and clock tables. Every session survives with its history.
 *
 * The step retires that file store, so it imports it once, in this same
 * transaction, and nothing reads it after. It only reads: no file is written,
 * moved or deleted. A missing file is skipped; a malformed one is skipped and
 * counted. A file for a session or seat with no row here is never looked at.
 * The text is kept whole.
 *
 * The DDL below is this step's own copy. It never follows the head schema.
 */

const SEAT_SESSIONS_TABLE_SQL = `
  CREATE TABLE seat_sessions (
    seat_id TEXT NOT NULL CHECK (length(seat_id) BETWEEN 1 AND 1024),
    session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 512),
    harness TEXT NOT NULL CHECK (length(harness) BETWEEN 1 AND 64),
    cwd TEXT CHECK (cwd IS NULL OR length(cwd) BETWEEN 1 AND 4096),
    transcript_path TEXT
      CHECK (transcript_path IS NULL OR length(transcript_path) BETWEEN 1 AND 4096),
    gist TEXT CHECK (gist IS NULL OR length(gist) BETWEEN 1 AND 200),
    notes TEXT CHECK (notes IS NULL OR length(notes) >= 1),
    continuation TEXT
      CHECK (continuation IS NULL OR length(continuation) >= 1),
    started_at INTEGER NOT NULL CHECK (started_at >= 0),
    ended_at INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    end_reason TEXT
      CHECK (end_reason IS NULL OR end_reason IN ('offboard', 'reseat', 'replaced')),
    ended_by TEXT CHECK (ended_by IS NULL OR ended_by IN ('operator', 'overseer', 'automatic')),
    offboarded_at INTEGER CHECK (offboarded_at IS NULL OR offboarded_at >= 0),
    onboarded_at INTEGER CHECK (onboarded_at IS NULL OR onboarded_at >= 0),
    binding_id TEXT CHECK (binding_id IS NULL OR length(binding_id) BETWEEN 1 AND 1024),
    PRIMARY KEY (seat_id, session_id),
    CHECK ((ended_at IS NULL) = (end_reason IS NULL))
  ) STRICT, WITHOUT ROWID;
`;

const SEAT_SESSIONS_OPEN_INDEX_SQL = `
  CREATE UNIQUE INDEX seat_sessions_one_open
    ON seat_sessions(seat_id) WHERE ended_at IS NULL
`;

const SEAT_CONTINUATIONS_OWED_TABLE_SQL = `
  CREATE TABLE seat_continuations_owed (
    seat_id TEXT PRIMARY KEY CHECK (length(seat_id) BETWEEN 1 AND 1024),
    binding_id TEXT NOT NULL UNIQUE CHECK (length(binding_id) BETWEEN 1 AND 1024),
    offboarded_generation TEXT
      CHECK (offboarded_generation IS NULL OR length(offboarded_generation) BETWEEN 1 AND 1024),
    owed_at INTEGER NOT NULL CHECK (owed_at >= 0)
  ) STRICT, WITHOUT ROWID;
`;

const SEAT_OFFBOARD_CLOCK_TABLE_SQL = `
  CREATE TABLE seat_offboard_clock (
    binding_id TEXT PRIMARY KEY CHECK (length(binding_id) BETWEEN 1 AND 1024),
    idle_since INTEGER CHECK (idle_since IS NULL OR idle_since >= 0),
    activity_since INTEGER CHECK (activity_since IS NULL OR activity_since >= 0),
    offboarded INTEGER NOT NULL CHECK (offboarded IN (0, 1)),
    work_ms INTEGER NOT NULL CHECK (work_ms >= 0),
    session_id TEXT CHECK (session_id IS NULL OR length(session_id) BETWEEN 1 AND 512),
    saved_at INTEGER NOT NULL CHECK (saved_at >= 0)
  ) STRICT, WITHOUT ROWID;
`;

/** Every column the step keeps, in both shapes of the table. */
const KEPT = [
  "seat_id",
  "session_id",
  "harness",
  "cwd",
  "transcript_path",
  "gist",
  "started_at",
  "ended_at",
  "end_reason",
  "offboarded_at",
  "binding_id",
] as const;

/** What the step takes from the retired files, onto each row. */
const IMPORTED = ["notes", "continuation", "ended_by", "onboarded_at"] as const;

type Stored = Record<(typeof KEPT)[number], string | number | null>;
type Imported = Record<(typeof IMPORTED)[number], string | number | null>;

/** What was imported, by kind, and how many files were skipped as malformed. Counts only. */
export type SeatFilesImport = {
  readonly notes: number;
  readonly continuations: number;
  readonly endedBy: number;
  readonly onboarded: number;
  readonly owed: number;
  readonly clock: number;
  readonly malformed: number;
};

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A seat or session id as the retired store named its directory or file: itself, or a digest. */
const segment = (id: string): string =>
  SAFE_SEGMENT.test(id) && !id.includes("..") ? id : `id-${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;

const ENDED_BY: ReadonlyArray<unknown> = ["operator", "overseer", "automatic"];

const finiteTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** An epoch time as the tables keep it: whole, never negative. */
const whole = (value: number): number => Math.max(0, Math.floor(value));

/** A retired file's text; undefined when it is not there, null when it cannot be read. */
const readRetired = (path: string): string | undefined | null => {
  try {
    return readFileSync(path, { encoding: "utf8", flag: "r" });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
  }
};

/**
 * Reads the retired files for the rows this database holds. Each reader
 * takes a file's text as its last writer wrote it, and says null for one it
 * cannot make sense of.
 */
const retiredStore = (seatsRoot: string) => {
  let malformed = 0;
  const take = <T>(path: string, decode: (text: string) => T | null): T | undefined => {
    const text = readRetired(path);
    if (text === undefined) return undefined;
    const value = text === null ? null : decode(text);
    if (value === null) malformed += 1;
    return value ?? undefined;
  };
  const sessionFile = (seatId: string, sessionId: string, suffix: string): string =>
    join(seatsRoot, segment(seatId), "sessions", `${segment(sessionId)}${suffix}`);
  /** Markdown as offboard wrote it: whole, without the blank edges. */
  const markdown = (text: string): string | null => {
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  const json = (text: string): Record<string, unknown> | null => {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  return {
    malformed: () => malformed,
    /** `<seat>/sessions/<session>.md` */
    notes: (seatId: string, sessionId: string) => take(sessionFile(seatId, sessionId, ".md"), markdown),
    /** `<seat>/sessions/<session>.next.md` */
    continuation: (seatId: string, sessionId: string) => take(sessionFile(seatId, sessionId, ".next.md"), markdown),
    /** `<seat>/sessions/<session>.ended.json`: `{ by, at }`. */
    endedBy: (seatId: string, sessionId: string) =>
      take(sessionFile(seatId, sessionId, ".ended.json"), (text) => {
        const marker = json(text);
        return marker !== null && ENDED_BY.includes(marker.by) && typeof marker.at === "number" && Number.isFinite(marker.at)
          ? String(marker.by)
          : null;
      }),
    /** `<seat>/sessions/<session>.onboarded`: an ISO time. */
    onboardedAt: (seatId: string, sessionId: string) =>
      take(sessionFile(seatId, sessionId, ".onboarded"), (text) => {
        const at = Date.parse(text.trim());
        return Number.isFinite(at) && at >= 0 ? whole(at) : null;
      }),
    /** `<seat>/continuation.pending`: `{ bindingId, offboarded?, at }`. */
    owed: (seatId: string) =>
      take(join(seatsRoot, segment(seatId), "continuation.pending"), (text) => {
        const pending = json(text);
        if (pending === null) return null;
        const { bindingId, offboarded, at } = pending;
        if (typeof bindingId !== "string" || bindingId.length === 0 || bindingId.length > 1024) return null;
        if (offboarded !== undefined && (typeof offboarded !== "string" || offboarded.length > 1024)) return null;
        return {
          bindingId,
          offboarded: offboarded ? offboarded : null,
          at: typeof at === "number" && Number.isFinite(at) ? whole(at) : 0,
        };
      }),
    /** `offboard-clock.json`: `{ savedAt, seats: { [bindingId]: entry } }`. */
    clock: () =>
      take(join(seatsRoot, "offboard-clock.json"), (text) => {
        const record = json(text);
        if (record === null || typeof record.savedAt !== "number" || !Number.isFinite(record.savedAt)) return null;
        const seats = record.seats;
        if (typeof seats !== "object" || seats === null || Array.isArray(seats)) return null;
        const savedAt = whole(record.savedAt);
        return Object.entries(seats as Record<string, unknown>).flatMap(([bindingId, value]) => {
          if (bindingId.length === 0 || bindingId.length > 1024) return [];
          const seat = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
          // A clock saved before the status fed it kept when the seat last moved.
          const idleSince = finiteTime(seat.idleSince) ? seat.idleSince : finiteTime(seat.movedAt) ? seat.movedAt : undefined;
          const activitySince = finiteTime(seat.activitySince) ? seat.activitySince : undefined;
          if (idleSince === undefined && activitySince === undefined) return [];
          const sessionId = typeof seat.sessionId === "string" ? seat.sessionId.trim() : "";
          return [
            {
              bindingId,
              idleSince: idleSince === undefined ? null : whole(idleSince),
              activitySince: activitySince === undefined ? null : whole(activitySince),
              offboarded: seat.offboarded === true ? 1 : 0,
              workMs: finiteTime(seat.workMs) ? whole(seat.workMs) : 0,
              sessionId: sessionId.length > 0 && sessionId.length <= 512 ? sessionId : null,
              savedAt,
            },
          ];
        });
      }),
  };
};

/** `~/.junto/seats`, beside the `state` directory that holds this database; undefined for one held in memory. */
const seatsRootOf = (database: StateSchemaMigrationDatabase): string | undefined => {
  const file = String(database.prepare("SELECT file FROM pragma_database_list WHERE name = 'main'").get()?.file ?? "");
  return file === "" ? undefined : join(dirname(dirname(file)), "seats");
};

export const migrateSeatSessionData = (database: StateSchemaMigrationDatabase): SeatFilesImport => {
  const stored = database
    .prepare(`SELECT ${KEPT.join(", ")} FROM seat_sessions ORDER BY seat_id, session_id`)
    .all() as unknown as ReadonlyArray<Stored>;
  const seatsRoot = seatsRootOf(database);
  const files = seatsRoot === undefined ? undefined : retiredStore(seatsRoot);

  const counts = { notes: 0, continuations: 0, endedBy: 0, onboarded: 0, owed: 0, clock: 0 };
  const imported = (row: Stored): Imported => {
    const none: Imported = { notes: null, continuation: null, ended_by: null, onboarded_at: null };
    if (files === undefined) return none;
    const seatId = String(row.seat_id);
    const sessionId = String(row.session_id);
    const notes = files.notes(seatId, sessionId);
    const continuation = files.continuation(seatId, sessionId);
    // Who ended a session is kept only while it is ended, as the repository keeps it.
    const endedBy = row.ended_at === null ? undefined : files.endedBy(seatId, sessionId);
    const onboardedAt = files.onboardedAt(seatId, sessionId);
    if (notes !== undefined) counts.notes += 1;
    if (continuation !== undefined) counts.continuations += 1;
    if (endedBy !== undefined) counts.endedBy += 1;
    if (onboardedAt !== undefined) counts.onboarded += 1;
    return {
      notes: notes ?? null,
      continuation: continuation ?? null,
      ended_by: endedBy ?? null,
      onboarded_at: onboardedAt ?? null,
    };
  };

  database.exec("DROP TABLE seat_sessions");
  database.exec(SEAT_SESSIONS_TABLE_SQL);
  const columns = [...KEPT, ...IMPORTED];
  const insert = database.prepare(
    `INSERT INTO seat_sessions(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  );
  for (const row of stored) {
    const values: Stored & Imported = { ...row, ...imported(row) };
    insert.run(...columns.map((column) => values[column]));
  }
  database.exec(SEAT_SESSIONS_OPEN_INDEX_SQL);
  const kept = Number(database.prepare("SELECT count(*) AS n FROM seat_sessions").get()!.n);
  if (kept !== stored.length) throw new Error("a seat session did not survive the step");
  database.exec(SEAT_CONTINUATIONS_OWED_TABLE_SQL);
  database.exec(SEAT_OFFBOARD_CLOCK_TABLE_SQL);

  if (files === undefined) return { ...counts, malformed: 0 };
  const seats = (
    database
      .prepare("SELECT seat_id AS id FROM seat_sessions UNION SELECT id FROM seats ORDER BY id")
      .all() as unknown as ReadonlyArray<{ readonly id: string }>
  ).map((seat) => String(seat.id));
  const owe = database.prepare(
    "INSERT INTO seat_continuations_owed(seat_id, binding_id, offboarded_generation, owed_at) VALUES (?, ?, ?, ?)",
  );
  const owedBindings = new Set<string>();
  let unowed = 0;
  for (const seatId of seats) {
    if (seatId.length === 0 || seatId.length > 1024) continue;
    const owed = files.owed(seatId);
    if (owed === undefined) continue;
    // A binding is owed its line once; a second seat naming it is malformed.
    if (owedBindings.has(owed.bindingId)) {
      unowed += 1;
      continue;
    }
    owedBindings.add(owed.bindingId);
    owe.run(seatId, owed.bindingId, owed.offboarded, owed.at);
    counts.owed += 1;
  }
  const tick = database.prepare(
    `INSERT INTO seat_offboard_clock(binding_id, idle_since, activity_since, offboarded, work_ms, session_id, saved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const entry of files.clock() ?? []) {
    tick.run(entry.bindingId, entry.idleSince, entry.activitySince, entry.offboarded, entry.workMs, entry.sessionId, entry.savedAt);
    counts.clock += 1;
  }
  const result = { ...counts, malformed: files.malformed() + unowed };
  console.info(
    `[state] 21 -> 22 imported from the retired seat files: ${result.notes} notes, ${result.continuations} continuations, ` +
      `${result.endedBy} ended marks, ${result.onboarded} onboarded marks, ${result.owed} owed continuations, ` +
      `${result.clock} clock entries; ${result.malformed} malformed skipped`,
  );
  return result;
};
