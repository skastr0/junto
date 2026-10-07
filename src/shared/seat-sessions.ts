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

/**
 * Which seat, on which canvas. Named fields on purpose: both are plain
 * strings, and two bare strings side by side get passed in the wrong order
 * without anything noticing (that is how offboard once stopped closing
 * sessions). A function that needs both takes one of these.
 */
export type SeatAddress = {
  readonly seatId: string;
  readonly canvasName: string;
};

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
  /**
   * What became of the session's process after it offboarded. The seat moved
   * on at the offboard; the process was detached and left to finish. Absent
   * for a session that never offboarded (or did before this was recorded).
   */
  readonly drain?: SeatSessionDrain;
};

/** How a detached session's process came to an end. */
export const SEAT_SESSION_DRAIN_ENDS = ["settled", "cap", "crashed", "quit"] as const;
/**
 * settled: it finished its turn and Junto stopped it. cap: it was still
 * working ten minutes after the offboard and was stopped then, so its
 * transcript ends mid-turn. crashed: it exited by itself with an error.
 * quit: Junto quit while it was winding down.
 */
export type SeatSessionDrainEnd = (typeof SEAT_SESSION_DRAIN_ENDS)[number];

export type SeatSessionDrain = {
  /** When the process was detached from its seat (the offboard). */
  readonly detachedAt: number;
  /** When the process really ended; absent while it is still winding down. */
  readonly endedAt?: number;
  readonly endedHow?: SeatSessionDrainEnd;
};

/** One line for the session's row in the seat's history. */
export const describeSessionDrain = (drain: SeatSessionDrain): string => {
  if (drain.endedHow === undefined) return "Offboarded, winding down";
  switch (drain.endedHow) {
    case "settled":
      return "Offboarded, finished its last turn";
    case "cap":
      return "Offboarded, stopped at the 10 minute limit before its last turn finished";
    case "crashed":
      return "Offboarded, then its process crashed";
    case "quit":
      return "Offboarded, ended when Junto quit";
  }
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
 * How `junto onboard` tells a session that the one before it ended without
 * notes: the operator or Junto ended it with no agent turn, or its id simply
 * changed. Nothing was handed over, so the transcript is the only record.
 */
export const PREVIOUS_WITHOUT_NOTES_FRAMING =
  "The session before this one ended without leaving notes, so nothing was handed over to you. Its transcript is the only record of it. It is history: read it if you need to know what that session was doing, and do not resume its work unless your current instructions or mail ask you to.";

/**
 * What the operator's Offboard buttons send the agent: the offboard prompt
 * for that mode. The notes are always the agent's own to write.
 */
export const composeOffboardAsk = (mode: OffboardMode): string =>
  mode === "continue"
    ? [
        "The operator asks you to offboard and continue in a fresh session.",
        'Finish the step you are on, then run `junto offboard "<notes>" --continue "<note for your next session>"`. The notes say what happened, what is relevant, and why it matters; the continuation says what to pick up next and why.',
        "That command ends this session at once: do it last, with everything the next session needs in the notes. Junto starts a fresh session of this seat right away, and it reads your continuation first.",
      ].join("\n")
    : [
        "The operator asks you to offboard this session.",
        'Finish the step you are on, then run `junto offboard "<notes>"`: what happened, what is relevant, and why it matters, first line the summary.',
        "That command ends this session at once: do it last, with everything worth keeping in the notes. The seat then rests, and its next wake starts a fresh session that reads your notes.",
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
