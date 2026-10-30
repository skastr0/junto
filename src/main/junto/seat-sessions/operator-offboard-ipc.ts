/**
 * The renderer's calls into operator offboard. Input arrives untyped off IPC
 * and is checked here; whatever is wrong comes back as rows or an answer the
 * screen can show, never as a throw.
 */
import {
  OFFBOARD_REFUSAL_REASON,
  SEAT_OFFBOARD_ACTIONS,
  SEAT_OFFBOARD_MAX_SEATS,
  summarizeOffboardRun,
  type OffboardBy,
  type SeatOffboardAction,
  type SeatOffboardRunResult,
  type SeatOffboardStatus,
} from "@shared/seat-offboard";
import { Schema } from "effect";
import { OFFBOARD_MODES, type OffboardMode } from "@shared/seat-sessions";
import { SEAT_CACHE_DUE_ANSWERS, type SeatCacheDue, type SeatCacheDueAnswerResult } from "@shared/seat-cache-due";
import { CacheQuestion } from "../term/seat-attach";
import { remoteSeatLaunchOf } from "../term/seats-client";
import { answerSeatViewQuestion, seatViewQuestions } from "../term/seat-views";
import { answerSeatCacheDue, CACHE_QUESTION_GONE, runSeatOffboard, seatCacheDueList, seatOffboardStatus } from "./operator-offboard";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const seatIdsOf = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= SEAT_OFFBOARD_MAX_SEATS &&
  value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256)
    ? (value as ReadonlyArray<string>)
    : undefined;

const EMPTY: SeatOffboardRunResult = summarizeOffboardRun([]);

/** Ask, or offboard now, the seats named. `by` is who is calling. */
export const handleSeatOffboardRun = async (
  input: unknown,
  by: OffboardBy = "operator",
): Promise<SeatOffboardRunResult> => {
  if (!isRecord(input)) return EMPTY;
  const seatIds = seatIdsOf(input.seatIds);
  if (seatIds === undefined) return EMPTY;
  const refuseAll = (reason: string): SeatOffboardRunResult =>
    summarizeOffboardRun(seatIds.map((seatId) => ({ seatId, ok: false as const, code: "failed" as const, reason })));
  if (typeof input.canvasName !== "string" || input.canvasName.length === 0) {
    return summarizeOffboardRun(
      seatIds.map((seatId) => ({
        seatId,
        ok: false as const,
        code: "not-a-seat" as const,
        reason: OFFBOARD_REFUSAL_REASON["not-a-seat"],
      })),
    );
  }
  if (!(SEAT_OFFBOARD_ACTIONS as ReadonlyArray<unknown>).includes(input.action)) {
    return refuseAll("Ask the seat to offboard, or offboard it now.");
  }
  if (input.mode !== undefined && !(OFFBOARD_MODES as ReadonlyArray<unknown>).includes(input.mode)) {
    return refuseAll("Offboard to rest or to continue.");
  }
  return runSeatOffboard(
    {
      canvasName: input.canvasName,
      seatIds,
      action: input.action as SeatOffboardAction,
      ...(input.mode !== undefined ? { mode: input.mode as OffboardMode } : {}),
    },
    by,
  );
};

/** What each seat's offboard buttons should say before they are pressed. */
export const handleSeatOffboardStatus = async (
  canvasName: unknown,
  seatIds: unknown,
): Promise<ReadonlyArray<SeatOffboardStatus>> => {
  const ids = seatIdsOf(seatIds);
  if (typeof canvasName !== "string" || canvasName.length === 0 || ids === undefined) return [];
  return seatOffboardStatus(canvasName, ids);
};

const Name = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(256)));
/** The window's answer, closed: these fields only, the question by the link's own pattern. */
const SeatCacheDueAnswerInput = Schema.Struct({
  canvasName: Name, seatId: Name, question: CacheQuestion, answer: Schema.Literals(SEAT_CACHE_DUE_ANSWERS),
});
const decodeAnswer = Schema.decodeUnknownSync(SeatCacheDueAnswerInput, { onExcessProperty: "error" });

/**
 * Every seat due the auto mode's question, as the window lists them: the
 * seats this machine runs, and those a linked machine asked on a view here.
 * A linked seat's size is what its machine last said with its launch state.
 */
export const seatCacheDueHere = async (): Promise<ReadonlyArray<SeatCacheDue>> => {
  const linked = await Promise.all(seatViewQuestions().map(async (asked): Promise<SeatCacheDue> => {
    const launch = await remoteSeatLaunchOf({ bindingId: asked.bindingId, host: asked.machine }).catch(() => undefined);
    const tokens = launch?.offboard?.tokens;
    return { canvasName: asked.canvasName, seatId: asked.seatId, question: asked.question, windowEndsAt: asked.windowEndsAt,
      ...(tokens === undefined ? {} : { tokens }) };
  }));
  return [...seatCacheDueList(), ...linked];
};

/**
 * The operator's answer to the auto mode's question for one seat: Start
 * fresh, or Keep this session. Decoded closed before use, and only the open
 * question for that seat settles: one a view here was asked goes back to the
 * seat's machine on that view, any other to this machine's own.
 */
export const answerSeatCacheDueHere = async (input: unknown): Promise<SeatCacheDueAnswerResult> => {
  let answer: typeof SeatCacheDueAnswerInput.Type;
  try {
    answer = decodeAnswer(input);
  } catch {
    return { ok: false, message: "Start fresh, or keep this session." };
  }
  const linked = seatViewQuestions().find((asked) => asked.question === answer.question);
  if (linked !== undefined)
    return linked.canvasName === answer.canvasName && linked.seatId === answer.seatId
      ? answerSeatViewQuestion(answer.question, answer.answer)
      : { ok: false, message: CACHE_QUESTION_GONE };
  return answerSeatCacheDue({ canvasName: answer.canvasName, seatId: answer.seatId }, answer.question, answer.answer);
};
