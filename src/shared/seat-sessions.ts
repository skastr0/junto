/**
 * Seat sessions: the ordered list of harness sessions one agent seat has
 * lived through, and the notes each left behind.
 *
 * A seat (keyed by its canvas node id, like its guidance and look) runs one
 * harness session at a time. Every time its session id is pinned, captured, or
 * rotated, Junto records a row: which harness, which id, where the harness
 * keeps that session on disk, and where the seat's own notes for it live.
 * `junto offboard` writes those notes; `junto onboard` hands the latest back
 * to the next session so it knows what came before and where to look.
 */

export const SEAT_SESSION_END_REASONS = ["offboard", "reseat", "replaced"] as const;
/**
 * Why a session stopped being the seat's current one. offboard: Junto rotated
 * the seat after a handoff. reseat: the seat moved to another harness or
 * binding. replaced: the id changed for any other reason.
 */
export type SeatSessionEndReason = (typeof SEAT_SESSION_END_REASONS)[number];

export type SeatSession = {
  readonly seatId: string;
  readonly sessionId: string;
  readonly harness: string;
  /** Where the harness keeps this session: a transcript, directory, or database. */
  readonly transcriptPath?: string;
  /** Where this session's offboard notes live (the file exists once offboarded). */
  readonly notesPath: string;
  /** The notes' first line, once the session has offboarded. */
  readonly gist?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly endReason?: SeatSessionEndReason;
  /** Last time the agent wrote notes for this session. */
  readonly offboardedAt?: number;
};

/** The notes the seat's agent writes when it offboards, as markdown. */
export const SEAT_SESSION_NOTES_MAX_CHARS = 16_000;
/** The note a continuing session leaves for the next one, as markdown. */
export const SEAT_SESSION_CONTINUATION_MAX_CHARS = 8_000;
export const SEAT_SESSION_GIST_MAX_CHARS = 160;

/** How many of the latest offboard notes `junto onboard` carries inline. */
export const ONBOARD_PAST_NOTES_DEFAULT = 5;
export const ONBOARD_PAST_NOTES_MAX = 20;
/** Past sessions `junto onboard` lists at all; older ones are counted. */
export const ONBOARD_PAST_SESSIONS_MAX = 30;

/**
 * How `junto onboard` and the doctrine behind `junto docs` frame the past sessions. Short
 * and firm: they are history to read, not work to pick up.
 */
export const PAST_SESSIONS_FRAMING =
  "These are PAST sessions of this seat: context for continuity, not ongoing tasks. Do not resume their work unless your current instructions or mail ask you to.";

/**
 * How a session offboards. rest: the notes close the session and the seat
 * rests; its next wake starts a fresh session. continue: the notes plus a
 * note for the next session, and Junto starts that session right away.
 */
export const OFFBOARD_MODES = ["rest", "continue"] as const;
export type OffboardMode = (typeof OFFBOARD_MODES)[number];

/**
 * How `junto onboard` frames the continuation note: the one exception to
 * past sessions being context only, because it is an explicit handoff.
 */
export const CONTINUATION_FRAMING =
  "Left for you by your previous session: an explicit handoff, the one exception to past sessions being context only. Pick this up now, unless your current instructions or mail say otherwise.";

/**
 * What the operator's Offboard buttons send the agent: the offboard prompt
 * for that mode. The notes are always the agent's own to write.
 */
export const composeOffboardAsk = (mode: OffboardMode): string =>
  mode === "continue"
    ? [
        "The operator asks you to offboard and continue in a fresh session.",
        'Finish the step you are on, then run `junto offboard "<notes>" --continue "<note for your next session>"`. The notes say what happened, what is relevant, and why it matters; the continuation says what to pick up next and why.',
        "When you go idle, Junto starts a fresh session of this seat that reads your continuation first and carries on.",
      ].join("\n")
    : [
        "The operator asks you to offboard this session.",
        'Finish the step you are on, then run `junto offboard "<notes>"`: what happened, what is relevant, and why it matters, first line the summary.',
        "When you go idle, Junto closes this session and the seat rests. Its next wake starts a fresh session that reads your notes.",
      ].join("\n");

/**
 * The first message of a fresh session that continues one which ran
 * `junto offboard --continue`: one line, typed once the harness can take it.
 * It is the seat's own request carried over, not doctrine; `junto onboard`
 * hands the session its continuation note.
 */
export const CONTINUATION_LINE =
  "Continuing from your previous session. Run `junto onboard` to read your handoff.";

/**
 * The one-line gist of a session's notes: the first line with text, without
 * markdown heading or list markers, whitespace collapsed, and bounded.
 */
export const gistOfNotes = (notes: string): string | undefined => {
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!line) continue;
    return line.length > SEAT_SESSION_GIST_MAX_CHARS
      ? `${line.slice(0, SEAT_SESSION_GIST_MAX_CHARS - 1).trimEnd()}…`
      : line;
  }
  return undefined;
};

/** Newest first: the current session leads, then by when each started. */
export const newestSessionsFirst = (
  sessions: ReadonlyArray<SeatSession>,
): SeatSession[] =>
  [...sessions].sort((left, right) => {
    const leftOpen = left.endedAt === undefined ? 1 : 0;
    const rightOpen = right.endedAt === undefined ? 1 : 0;
    if (leftOpen !== rightOpen) return rightOpen - leftOpen;
    return right.startedAt - left.startedAt;
  });

/**
 * Where one seat's offboard stands, for the operator. asked: the operator
 * sent the offboard prompt. saved: the agent wrote its notes. resting: the
 * session closed and the seat rests. started: a fresh session started.
 * waiting: the fresh session is ready and starts when the canvas plays.
 * failed: Junto could not close the session (see message).
 */
export const SEAT_OFFBOARD_STAGES = ["asked", "saved", "resting", "started", "waiting", "failed"] as const;
export type SeatOffboardStage = (typeof SEAT_OFFBOARD_STAGES)[number];

export type SeatOffboardProgress = {
  readonly seatId: string;
  readonly canvasName: string;
  readonly mode: OffboardMode;
  readonly stage: SeatOffboardStage;
  readonly at: number;
  /** When the operator asked for this offboard; absent when the agent chose it. */
  readonly askedAt?: number;
  readonly message?: string;
};

export type SeatOffboardAskResult = { readonly ok: true } | { readonly ok: false; readonly message: string };
