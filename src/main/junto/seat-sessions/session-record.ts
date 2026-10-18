/**
 * The session record at close: every time a seat session ends, Junto writes
 * what it observed while the session ran, beside the session's notes, as
 * `<seats>/<seat>/sessions/<session>.record.json`.
 *
 * Called once at every end: the agent's own offboard, every cut from outside
 * the session, and a reseat or replaced end. It never fails and never holds
 * the close up for long; a source it cannot read is recorded as unread.
 *
 * Facts only, no model: the session's row (harness, folder, transcript,
 * start), mail in and out, signals raised or answered, moves of the tasks it
 * held, and the commits it made. Every seat may share one worktree and one
 * git author, so a commit is this session's only when the seat's own
 * post-commit hook reported it under the seat's credential (`seat_commits`);
 * git supplies only its subject. Reading them is
 * `gatherSessionFacts`; shaping them into the record is `buildSessionRecord`,
 * pure.
 */
import { readFileSync } from "node:fs";
import { Duration, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SeatAddress } from "@shared/seat-sessions";
import {
  SESSION_RECORD_LIST_MAX,
  SESSION_RECORD_TEXT_MAX,
  SESSION_RECORD_VERSION,
  type Observed,
  type RecordedMailIn,
  type RecordedMailOut,
  type RecordedSignal,
  type RecordedCommit,
  type RecordedTaskMove,
  type SessionEndedBy,
  type SessionRecord,
} from "@shared/seat-session-record";
import { nodeTitle } from "../work/authz";
import { mailboxMessageReadId } from "../work/mailbox-receipts";
import { WorkService } from "../work/service";
import { commitSubject, seatSessionCommits } from "../git/seat-commits";
import { SeatSessionRepository } from "./repository";
import { writeNotesFile } from "./notes-file";

/** What the record is read from; all of it lives in the core runtime. */
export type SessionRecordSources = SqlClient.SqlClient | SeatSessionRepository | WorkService;

export type SessionClose = {
  readonly seat: SeatAddress;
  /** The session that just ended. */
  readonly sessionId: string;
  readonly endedAt: number;
  readonly endedBy: SessionEndedBy;
};

/** `<seats>/<seat>/sessions/<session>.record.json`, beside the session's notes. */
export const sessionRecordPathOf = (notesPath: string): string => notesPath.replace(/\.md$/, ".record.json");

/** How long one source may take before it is recorded as unread. */
const SOURCE_TIMEOUT = Duration.seconds(5);
// ── Facts ──────────────────────────────────────────────────────────────────

type Read<T> = { readonly read: true; readonly items: ReadonlyArray<T> } | { readonly read: false; readonly reason: string };

export type MailInFact = {
  readonly id: string;
  readonly from: string | null;
  readonly at: string;
  readonly text: string;
  readonly readAt: string | null;
};

export type MailOutFact = {
  readonly id: string;
  readonly to: string;
  readonly at: string;
  readonly text: string;
  readonly inReplyTo: string | null;
};

/** Everything the record is made of, read at the close. */
export type SessionFacts = {
  readonly session: {
    readonly id: string;
    readonly harness: string;
    readonly startedAt: number;
    readonly endedAt: number;
    readonly endedBy: SessionEndedBy;
    readonly cwd: string | null;
    readonly transcriptPath: string | null;
  };
  readonly mailIn: Read<MailInFact>;
  readonly mailOut: Read<MailOutFact>;
  readonly signals: Read<RecordedSignal>;
  readonly tasks: Read<RecordedTaskMove>;
  readonly commits: Read<RecordedCommit>;
};

// ── The record (pure) ──────────────────────────────────────────────────────

const iso = (ms: number): string => new Date(ms).toISOString();

/** One line of words, whitespace collapsed and bounded. */
export const clip = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SESSION_RECORD_TEXT_MAX ? `${flat.slice(0, SESSION_RECORD_TEXT_MAX - 1).trimEnd()}…` : flat;
};

/** Oldest first, the newest kept when there are more than the cap. */
const observe = <T, U>(read: Read<T>, at: (item: T) => string, shape: (item: T) => U): Observed<U> => {
  if (!read.read) return { read: false, reason: read.reason };
  const ordered = [...read.items].sort((left, right) => at(left).localeCompare(at(right)));
  const kept = ordered.slice(-SESSION_RECORD_LIST_MAX);
  return { read: true, items: kept.map(shape), more: ordered.length - kept.length };
};

/** Shape what was read at the close into the session's record. */
export const buildSessionRecord = (facts: SessionFacts, writtenAt: number): SessionRecord => {
  const replied = new Set(
    facts.mailOut.read
      ? facts.mailOut.items.flatMap((mail) => (mail.inReplyTo === null ? [] : [mail.inReplyTo]))
      : [],
  );
  return {
    version: SESSION_RECORD_VERSION,
    kind: "junto_observation",
    session: {
      id: facts.session.id,
      harness: facts.session.harness,
      started_at: iso(facts.session.startedAt),
      ended_at: iso(facts.session.endedAt),
      ended_by: facts.session.endedBy,
      cwd: facts.session.cwd,
      transcript_path: facts.session.transcriptPath,
    },
    mail_in: observe(
      facts.mailIn,
      (mail) => mail.at,
      (mail): RecordedMailIn => ({
        id: mail.id,
        from: mail.from,
        at: mail.at,
        text: clip(mail.text),
        read_at: mail.readAt,
        answered: replied.has(mail.id),
      }),
    ),
    mail_out: observe(
      facts.mailOut,
      (mail) => mail.at,
      (mail): RecordedMailOut => ({
        id: mail.id,
        to: mail.to,
        at: mail.at,
        text: clip(mail.text),
        in_reply_to: mail.inReplyTo,
      }),
    ),
    signals: observe(
      facts.signals,
      (signal) => signal.raised_at,
      (signal) => ({ ...signal, text: clip(signal.text), answer: signal.answer && { ...signal.answer, text: clip(signal.answer.text) } }),
    ),
    tasks: observe(facts.tasks, (move) => move.at, (move) => move),
    commits: observe(facts.commits, (commit) => commit.at, (commit) => ({ ...commit, subject: commit.subject && clip(commit.subject) })),
    written_at: iso(writtenAt),
  };
};

// ── Reading the facts ──────────────────────────────────────────────────────

const unread = (reason: string) => ({ read: false as const, reason });

/** A source read within its time, or recorded as unread with why. */
const bounded = <T>(what: string, effect: Effect.Effect<Read<T>, unknown>): Effect.Effect<Read<T>> =>
  effect.pipe(
    Effect.timeoutOrElse({ duration: SOURCE_TIMEOUT, orElse: () => Effect.succeed(unread(`${what} took too long to read`)) }),
    Effect.catchCause(() => Effect.succeed(unread(`${what} could not be read`))),
  );

type JsonObject = Record<string, unknown>;

const parseObject = (json: string | null): JsonObject => {
  if (json === null) return {};
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
  } catch {
    return {};
  }
};

/** A message's words: its text parts, joined. */
const textOfParts = (json: string): string => {
  try {
    const parts: unknown = JSON.parse(json);
    if (!Array.isArray(parts)) return "";
    return parts
      .flatMap((part) =>
        typeof part === "object" && part !== null && (part as JsonObject).kind === "text" && typeof (part as JsonObject).text === "string"
          ? [(part as JsonObject).text as string]
          : [],
      )
      .join(" ");
  } catch {
    return "";
  }
};

const stringOr = (value: unknown, fallback: string | null): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : fallback;

type SessionRow = {
  readonly harness: string;
  readonly binding_id: string | null;
  readonly cwd: string | null;
  readonly transcript_path: string | null;
  readonly started_at: number;
};

type MessageRow = {
  readonly node_id: string;
  readonly message_id: string;
  readonly parts_json: string;
  readonly metadata_json: string | null;
  readonly received_at: string;
};

type SignalRow = {
  readonly signal_id: string;
  readonly kind: RecordedSignal["kind"];
  readonly text: string;
  readonly created_at: number;
  readonly state: RecordedSignal["state"];
  readonly response_text: string | null;
  readonly response_at: number | null;
};

type TransitionRow = {
  readonly node_id: string;
  readonly item_id: string;
  readonly operation: string;
  readonly from_state: string | null;
  readonly to_state: string;
  readonly received_at: string;
};

/** Read the facts of a session that just ended. Never fails. */
export const gatherSessionFacts = (close: SessionClose) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const work = yield* WorkService;
    const { canvasName, seatId } = close.seat;
    const rows = yield* sql
      .unsafe<SessionRow>(
        "SELECT harness, binding_id, cwd, transcript_path, started_at FROM seat_sessions WHERE seat_id = ? AND session_id = ?",
        [seatId, close.sessionId],
      )
      .pipe(Effect.orElseSucceed((): ReadonlyArray<SessionRow> => []));
    const row = rows[0];
    const startedAt = row === undefined ? close.endedAt : Number(row.started_at);
    const since = iso(startedAt);
    const until = iso(close.endedAt);
    const topology = yield* work.readTopology(canvasName).pipe(Effect.option);
    const titleOf = (nodeId: string): string => {
      if (topology._tag === "None") return nodeId;
      const node = topology.value.canvas.nodes.get(nodeId as never);
      return node === undefined ? nodeId : nodeTitle(node) || nodeId;
    };
    const actorSeats =
      topology._tag === "None"
        ? undefined
        : topology.value.actorRefs.filter((actor) => actor.canvasName === canvasName && actor.nodeId === seatId).map((actor) => actor.seatId);

    const mailIn = bounded<MailInFact>(
      "this seat's inbox",
      Effect.gen(function* () {
        const messages = yield* sql.unsafe<MessageRow>(
          `SELECT node_id, message_id, parts_json, metadata_json, received_at FROM work_messages
           WHERE canvas_name = ? AND node_id = ? AND role = 'user' AND received_at >= ? AND received_at <= ?`,
          [canvasName, seatId, since, until],
        );
        const ids = messages.map((message) => mailboxMessageReadId(canvasName, seatId, message.message_id));
        const receipts =
          ids.length === 0
            ? []
            : yield* sql.unsafe<{ delivery_id: string; accepted_at: string }>(
                `SELECT delivery_id, accepted_at FROM work_delivery_receipts WHERE delivery_id IN (${ids.map(() => "?").join(", ")})`,
                ids,
              );
        const readAt = new Map(receipts.map((receipt) => [receipt.delivery_id, receipt.accepted_at]));
        return {
          read: true as const,
          items: messages.map((message): MailInFact => {
            const metadata = parseObject(message.metadata_json);
            return {
              id: message.message_id,
              from: stringOr(metadata.senderName, stringOr(metadata.senderNodeId, null)),
              at: message.received_at,
              text: textOfParts(message.parts_json),
              readAt: readAt.get(mailboxMessageReadId(canvasName, seatId, message.message_id)) ?? null,
            };
          }),
        };
      }),
    );

    const mailOut = bounded<MailOutFact>(
      "this seat's sent mail",
      Effect.gen(function* () {
        // Sent by this seat: named as its sender, or stamped with its actor seat.
        const asActor = actorSeats ?? [];
        const messages = yield* sql.unsafe<MessageRow>(
          `SELECT node_id, message_id, parts_json, metadata_json, received_at FROM work_messages
           WHERE canvas_name = ? AND node_id <> ? AND received_at >= ? AND received_at <= ?
             AND (json_extract(metadata_json, '$.senderNodeId') = ?${
               asActor.length === 0 ? "" : ` OR actor_seat_id IN (${asActor.map(() => "?").join(", ")})`
             })`,
          [canvasName, seatId, since, until, seatId, ...asActor],
        );
        return {
          read: true as const,
          items: messages.map((message): MailOutFact => ({
            id: message.message_id,
            to: titleOf(message.node_id),
            at: message.received_at,
            text: textOfParts(message.parts_json),
            inReplyTo: stringOr(parseObject(message.metadata_json).inReplyTo, null),
          })),
        };
      }),
    );

    const signals = bounded<RecordedSignal>(
      "this seat's signals",
      Effect.gen(function* () {
        const raised = yield* sql.unsafe<SignalRow>(
          `SELECT signal_id, kind, text, created_at, state, response_text, response_at FROM agent_signals
           WHERE canvas_name = ? AND node_id = ?
             AND ((created_at >= ? AND created_at <= ?) OR (response_at >= ? AND response_at <= ?))`,
          [canvasName, seatId, startedAt, close.endedAt, startedAt, close.endedAt],
        );
        return {
          read: true as const,
          items: raised.map((signal): RecordedSignal => ({
            id: signal.signal_id,
            kind: signal.kind,
            text: signal.text,
            raised_at: iso(Number(signal.created_at)),
            state: signal.state,
            answer:
              signal.response_text === null || signal.response_at === null
                ? null
                : { text: signal.response_text, at: iso(Number(signal.response_at)) },
          })),
        };
      }),
    );

    const tasks = bounded<RecordedTaskMove>(
      "the tasks this seat held",
      Effect.gen(function* () {
        if (actorSeats === undefined) return unread("the canvas could not be read");
        if (actorSeats.length === 0) return { read: true as const, items: [] };
        const moves = yield* sql.unsafe<TransitionRow>(
          `SELECT node_id, item_id, operation, from_state, to_state, received_at FROM work_task_transitions
           WHERE canvas_name = ? AND actor_seat_id IN (${actorSeats.map(() => "?").join(", ")})
             AND received_at >= ? AND received_at <= ?`,
          [canvasName, ...actorSeats, since, until],
        );
        return {
          read: true as const,
          items: moves.map((move): RecordedTaskMove => ({
            board: move.node_id,
            task: move.item_id,
            operation: move.operation,
            from_state: move.from_state,
            to_state: move.to_state,
            at: move.received_at,
          })),
        };
      }),
    );

    const commits = bounded<RecordedCommit>(
      "this seat's commits",
      Effect.gen(function* () {
        const made = yield* seatSessionCommits({ canvasName, seatId, sessionId: close.sessionId, startedAt, endedAt: close.endedAt });
        // Git is asked only for the commits the record keeps; the rest are counted.
        const kept = made.slice(-SESSION_RECORD_LIST_MAX);
        const subjects = yield* Effect.forEach(
          kept,
          (commit) => Effect.promise(() => commitSubject(commit.repo, commit.sha).catch(() => undefined)),
          { concurrency: 4 },
        );
        const items = made.map((commit): RecordedCommit => ({
          sha: commit.sha,
          subject: subjects[kept.indexOf(commit)]?.subject ?? null,
          at: iso(commit.observedAt),
          repo: commit.repo,
        }));
        return { read: true as const, items };
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    );

    const cwd = row?.cwd ?? null;
    const transcriptPath = row?.transcript_path ?? null;
    const [inbox, sent, raised, held, made] = yield* Effect.all(
      [mailIn, mailOut, signals, tasks, commits],
      { concurrency: "unbounded" },
    );
    const facts: SessionFacts = {
      session: {
        id: close.sessionId,
        harness: row?.harness ?? "unknown",
        startedAt,
        endedAt: close.endedAt,
        endedBy: close.endedBy,
        cwd,
        transcriptPath,
      },
      mailIn: inbox,
      mailOut: sent,
      signals: raised,
      tasks: held,
      commits: made,
    };
    return facts;
  });

/**
 * Write the record of a session that just ended, beside its notes. Never
 * fails: what could not be read says so in the record, and a record that
 * could not be written is logged.
 */
export const recordSessionAtClose = (
  close: SessionClose,
  options: { readonly now?: () => number; readonly log?: (message: string) => void } = {},
): Effect.Effect<void, never, SessionRecordSources> =>
  Effect.gen(function* () {
    const sessions = yield* SeatSessionRepository;
    const facts = yield* gatherSessionFacts(close);
    const record = buildSessionRecord(facts, options.now?.() ?? Date.now());
    const path = sessionRecordPathOf(sessions.notesPathFor(close.seat.seatId, close.sessionId));
    yield* Effect.sync(() => writeNotesFile(path, JSON.stringify(record, null, 2)));
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => options.log?.(`the record of session ${close.sessionId} of ${close.seat.seatId} was not written: ${String(cause)}`)),
    ),
  );

/** A session's record as written at its close; undefined when there is none or it cannot be read. */
export const readSessionRecord = (notesPath: string): SessionRecord | undefined => {
  try {
    const parsed = JSON.parse(readFileSync(sessionRecordPathOf(notesPath), "utf8")) as Partial<SessionRecord>;
    if (parsed.kind !== "junto_observation" || parsed.version !== SESSION_RECORD_VERSION) return undefined;
    // A record written before Junto kept commits says nothing about them.
    return { ...(parsed as SessionRecord), commits: parsed.commits ?? { read: false, reason: "recorded before Junto kept commits" } };
  } catch {
    return undefined;
  }
};
