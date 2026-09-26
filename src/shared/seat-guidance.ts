import { PORTRAIT_SEAT_ID_MAX } from "./portrait-overrides";

/**
 * Seat guidance: the operator's optional soul and instructions for one agent
 * seat, stored one row per seat identity (canvas node id, the same key as
 * portrait overrides) in junto.db `seat_guidance`.
 *
 * - soul: who this agent is. Personality, voice, values. Markdown.
 * - instructions: standing instructions for this seat. Markdown.
 *
 * Both reach the agent through the compiled seat doctrine and `junto onboard`,
 * identically for every harness, as clearly marked operator-authored sections
 * that never outrank the Junto laws. This normalizer is the one gate for the
 * IPC input and the stored rows.
 */

export const SEAT_SOUL_MAX = 4000;
export const SEAT_INSTRUCTIONS_MAX = 8000;
export const SEAT_GUIDANCE_SEAT_ID_MAX = PORTRAIT_SEAT_ID_MAX;

export type SeatGuidance = {
  readonly soul?: string;
  readonly instructions?: string;
};

/** Seat id -> guidance, as the renderer holds it. */
export type SeatGuidanceMap = Readonly<Record<string, SeatGuidance>>;

export type SeatGuidanceSetResult =
  | { readonly ok: true; readonly seatId: string; readonly guidance: SeatGuidance | null }
  | { readonly ok: false; readonly message: string };

/** Main -> renderer: one seat's guidance as it now stands (null is cleared). */
export type SeatGuidanceEvent = {
  readonly seatId: string;
  readonly guidance: SeatGuidance | null;
};

export const isSeatGuidanceSeatId = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= SEAT_GUIDANCE_SEAT_ID_MAX;

/** One markdown field: CRLF to LF, no NUL, trimmed; empty is absent. */
export const cleanGuidanceText = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex -- NUL never belongs in a prompt
  const text = value.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
  return text.length > 0 ? text : undefined;
};

export type SeatGuidanceNormalized =
  | { readonly ok: true; readonly guidance: SeatGuidance | null }
  | { readonly ok: false; readonly message: string };

/**
 * Keep the two known fields, cleaned. Over-long text is refused with a reason
 * (never cut silently); nothing left is a clear, never a row.
 */
export function normalizeSeatGuidance(value: unknown): SeatGuidanceNormalized {
  if (value === null || value === undefined) return { ok: true, guidance: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "seat guidance must be an object" };
  }
  const input = value as Record<string, unknown>;
  const soul = cleanGuidanceText(input.soul);
  const instructions = cleanGuidanceText(input.instructions);
  if (soul !== undefined && soul.length > SEAT_SOUL_MAX) {
    return { ok: false, message: `the soul is ${soul.length} characters; keep it to ${SEAT_SOUL_MAX}` };
  }
  if (instructions !== undefined && instructions.length > SEAT_INSTRUCTIONS_MAX) {
    return {
      ok: false,
      message: `the instructions are ${instructions.length} characters; keep them to ${SEAT_INSTRUCTIONS_MAX}`,
    };
  }
  if (soul === undefined && instructions === undefined) return { ok: true, guidance: null };
  return {
    ok: true,
    guidance: {
      ...(soul !== undefined ? { soul } : {}),
      ...(instructions !== undefined ? { instructions } : {}),
    },
  };
}
