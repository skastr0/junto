/**
 * How `junto onboard` shows one past session: by provenance. Junto's record
 * of it, the seat's own journal when it wrote one, and its transcript are
 * kept apart and named for what they are (`SESSION_PROVENANCE`), never
 * blended into one account.
 */
import type { SeatSession } from "@shared/seat-sessions";
import type { SessionRecord } from "@shared/seat-session-record";
import { readNotesFile } from "./notes-file";
import { readSessionRecord, sessionRecordPathOf } from "./session-record";

/** The record's facts, without what the session's own row already says. */
const factsOf = (record: SessionRecord) => ({
  ended_by: record.session.ended_by,
  mail_in: record.mail_in,
  mail_out: record.mail_out,
  signals: record.signals,
  tasks: record.tasks,
});

/**
 * Junto's record of the session: inline when asked, else where it is. Null
 * when the session has none (it ended before records were kept).
 */
export const pastRecordOf = (session: SeatSession, inline: boolean) => {
  const record = session.endedAt === undefined ? undefined : readSessionRecord(session.notesPath);
  if (record === undefined) return { record: null };
  return inline ? { record: factsOf(record) } : { record_path: sessionRecordPathOf(session.notesPath) };
};

/**
 * The seat's own journal of the session: present only when it offboarded
 * with notes. `text` inline when asked; `in: "handoff"` when the handoff
 * already carries it.
 */
export const pastJournalOf = (session: SeatSession, options: { readonly inline: boolean; readonly inHandoff: boolean }) => {
  if (session.offboardedAt === undefined) return { journal: null };
  const text = options.inline && !options.inHandoff ? readNotesFile(session.notesPath) : undefined;
  return {
    journal: {
      gist: session.gist ?? null,
      path: session.notesPath,
      ...(text === undefined ? {} : { text }),
      ...(options.inHandoff ? { in: "handoff" as const } : {}),
    },
  };
};
