/**
 * A session's record: what Junto observed while one seat session ran, built
 * from facts at the moment the session ended, with no model and no turn.
 *
 * Provenance is the model. A past session is known through kinds of record
 * that are not interchangeable, and onboard keeps them apart:
 *
 *   record      Junto's observation (this file): mail in and out, signals
 *               and their answers, tasks, commits, how the session ended.
 *               Facts, each one labelled as Junto's.
 *   journal     the seat's own words, written with `junto offboard`: its
 *               perspective, present only when it wrote them.
 *   transcript  the harness's full record of the session.
 *
 * Pure, no Node imports (renderer and CLI safe).
 */
import type { OffboardBy } from "./seat-offboard";

export const SESSION_RECORD_VERSION = 1;

/**
 * Who or what ended the session. agent: its own `junto offboard`. operator,
 * overseer, automatic: closed from outside it, with no turn. reseat: the seat
 * moved to another harness or binding. replaced: its id changed for any other
 * reason.
 */
export type SessionEndedBy = "agent" | OffboardBy | "reseat" | "replaced";

/** Most items of one kind a record keeps; the rest are counted. */
export const SESSION_RECORD_LIST_MAX = 50;
/** Longest text an item keeps (a mail's or signal's words), in characters. */
export const SESSION_RECORD_TEXT_MAX = 280;

/**
 * One kind of fact. Read: the items Junto found, newest last, and how many
 * more there were past the cap. Unread: the source could not be read, so the
 * record says nothing about it, which is not the same as there being none.
 */
export type Observed<T> =
  | { readonly read: true; readonly items: ReadonlyArray<T>; readonly more: number }
  | { readonly read: false; readonly reason: string };

export type RecordedMailIn = {
  readonly id: string;
  /** The sending seat's name, or its node id; null when the mail names no sender. */
  readonly from: string | null;
  readonly at: string;
  readonly text: string;
  readonly read_at: string | null;
  /** This seat replied to it during the session. */
  readonly answered: boolean;
};

export type RecordedMailOut = {
  readonly id: string;
  /** The receiving seat's title, or its node id. */
  readonly to: string;
  readonly at: string;
  readonly text: string;
  readonly in_reply_to: string | null;
};

export type RecordedSignal = {
  readonly id: string;
  readonly kind: "escalate" | "blocked" | "feedback";
  readonly text: string;
  readonly raised_at: string;
  readonly state: "open" | "answered" | "dismissed" | "withdrawn";
  readonly answer: { readonly text: string; readonly at: string } | null;
};

export type RecordedTaskMove = {
  /** The board (node id) the task sits on. */
  readonly board: string;
  readonly task: string;
  readonly operation: string;
  readonly from_state: string | null;
  readonly to_state: string;
  readonly at: string;
};

/**
 * A commit the seat made while the session ran. Attributed by Junto's store
 * alone: the seat's post-commit hook reported it under the seat's credential.
 * The subject is git's, read at the close; null when git no longer has it.
 */
export type RecordedCommit = {
  readonly sha: string;
  readonly subject: string | null;
  /** When Junto observed the commit. */
  readonly at: string;
  /** The top level of the repo the commit is in. */
  readonly repo: string;
};

export type SessionRecord = {
  readonly version: typeof SESSION_RECORD_VERSION;
  readonly kind: "junto_observation";
  readonly session: {
    readonly id: string;
    readonly harness: string;
    readonly started_at: string;
    readonly ended_at: string;
    readonly ended_by: SessionEndedBy;
    readonly cwd: string | null;
    readonly transcript_path: string | null;
  };
  readonly mail_in: Observed<RecordedMailIn>;
  readonly mail_out: Observed<RecordedMailOut>;
  readonly signals: Observed<RecordedSignal>;
  readonly tasks: Observed<RecordedTaskMove>;
  readonly commits: Observed<RecordedCommit>;
  readonly written_at: string;
};

/**
 * How `junto onboard` names each kind of record of a past session, once, so
 * the session reading them weighs each for what it is.
 */
export const SESSION_PROVENANCE = {
  record:
    "Junto's observation, recorded when the session ended: the mail it received and sent, the signals it raised and their answers, the tasks it held, the commits it made, and how it ended. Facts, not the seat's words.",
  journal:
    "The seat's own words, written by that session with `junto offboard`: its perspective, present only when it wrote one.",
  transcript: "The harness's full record of the session, to open when the rest is not enough.",
} as const;
