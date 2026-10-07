import {
  OFFBOARD_MINUTES_MAX,
  OFFBOARD_MINUTES_MIN,
  OFFBOARD_REFUSAL_REASON,
  applyOffboardRulesPatch,
  offboardRulesFor,
  offboardRulesProblem,
  summarizeOffboardRun,
  type OffboardRules,
  type OffboardRulesPatch,
  type OffboardRefusalCode,
  type SeatOffboardAction,
  type SeatOffboardRunInput,
  type SeatOffboardRunResult,
  type SeatOffboardRunRow,
  type SeatOffboardStatus,
} from "@shared/seat-offboard";
import type { OffboardMode } from "@shared/seat-sessions";
import type { JuntoApi } from "@shared/ipc";
import { getJuntoApi } from "./junto-api";
import { agentCountLabel } from "./multi-selection";

/**
 * Offboard from the canvas: the calls and the words behind the two operator
 * actions, for one seat or a whole selection.
 *
 *   ask  the agent is mailed the offboard prompt and writes its own notes
 *   now  Junto ends the session itself: no agent turn, no notes
 *
 * Main decides everything: whether a seat may be closed now, how long it has
 * been motionless, and which action the cache window prefers. This file asks
 * and puts the answers into the operator's words.
 */

// --- calls ---------------------------------------------------------------------

export type SeatOffboardOps = {
  readonly run: (input: SeatOffboardRunInput) => Promise<SeatOffboardRunResult>;
  readonly status: (
    canvasName: string,
    seatIds: ReadonlyArray<string>,
  ) => Promise<ReadonlyArray<SeatOffboardStatus>>;
};

const UNREACHABLE = "Junto could not reach its offboard service.";

const refuseAll = (seatIds: ReadonlyArray<string>): SeatOffboardRunResult =>
  summarizeOffboardRun(seatIds.map((seatId) => ({ seatId, ok: false, code: "failed", reason: UNREACHABLE })));

/** Ask seat by seat through the one-seat call, for a main without seatOffboardRun. */
const askEach = async (
  ask: NonNullable<JuntoApi["seatOffboardAsk"]>,
  input: SeatOffboardRunInput,
): Promise<SeatOffboardRunResult> => {
  const results = await Promise.all(
    input.seatIds.map(async (seatId): Promise<SeatOffboardRunRow> => {
      const answer = await ask(input.canvasName, seatId, input.mode ?? "continue").catch(() => undefined);
      if (answer?.ok === true) return { seatId, ok: true, action: "ask", outcome: "asked", pastWindow: false };
      return { seatId, ok: false, code: "undelivered", reason: answer?.message ?? OFFBOARD_REFUSAL_REASON.undelivered };
    }),
  );
  return summarizeOffboardRun(results);
};

/** The app's own calls. Neither ever throws: a lost call is a refused row per seat. */
export const seatOffboardOps: SeatOffboardOps = {
  run: async (input) => {
    const bridge = getJuntoApi();
    const call = bridge?.seatOffboardRun;
    if (call !== undefined) return call(input).catch(() => refuseAll(input.seatIds));
    if (input.action === "ask" && bridge?.seatOffboardAsk !== undefined) return askEach(bridge.seatOffboardAsk, input);
    return refuseAll(input.seatIds);
  },
  status: async (canvasName, seatIds) => {
    const call = getJuntoApi()?.seatOffboardStatus;
    if (call === undefined) return [];
    return call(canvasName, seatIds).catch(() => []);
  },
};

// --- words ---------------------------------------------------------------------

/** How a refusal reads in a count: "2 are working". */
const REFUSAL_PHRASE: Readonly<Partial<Record<OffboardRefusalCode, (count: number) => string>>> = {
  working: (count) => `${count} ${count === 1 ? "is" : "are"} working`,
  attention: (count) => `${count} ${count === 1 ? "is" : "are"} waiting on you`,
  closing: (count) => `${count} ${count === 1 ? "is" : "are"} already closing`,
  "not-local": (count) => `${count} ${count === 1 ? "runs" : "run"} on another installation`,
  "not-a-seat": (count) => `${count} ${count === 1 ? "is not an agent" : "are not agents"}`,
};

/** Refusals by reason, in first-seen order; codes with no phrase share `rest`. */
const refusalCounts = (rows: ReadonlyArray<SeatOffboardRunRow>, rest: (count: number) => string): string[] => {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.ok) continue;
    const key = REFUSAL_PHRASE[row.code] !== undefined ? row.code : "";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) =>
    key === "" ? rest(count) : REFUSAL_PHRASE[key as OffboardRefusalCode]!(count),
  );
};

/** After Offboard now: "8 closed, 2 are working". */
export const offboardNowLine = (rows: ReadonlyArray<SeatOffboardRunRow>): string => {
  if (rows.length === 0) return "No agent to close.";
  if (rows.length === 1) {
    const only = rows[0]!;
    return only.ok ? "Session closed. The seat is resting." : `Not closed. ${only.reason}`;
  }
  const closed = rows.filter((row) => row.ok).length;
  const reasons = refusalCounts(rows, (count) => `${count} could not be closed`);
  if (closed === 0) return `None closed: ${reasons.join(", ")}`;
  return [`${closed} closed`, ...reasons].join(", ");
};

const MODE_WORDS: Readonly<Record<OffboardMode, string>> = {
  continue: "offboard and continue",
  rest: "offboard and rest",
};

/** After Ask to offboard: "Asked 3 agents to offboard and continue. 1 could not be asked." */
export const askOffboardLine = (mode: OffboardMode, rows: ReadonlyArray<SeatOffboardRunRow>): string => {
  if (rows.length === 0) return "No agent to ask.";
  if (rows.length === 1) {
    const only = rows[0]!;
    return only.ok ? `Asked to ${MODE_WORDS[mode]}.` : `Not asked. ${only.reason}`;
  }
  const asked = rows.filter((row) => row.ok).length;
  const reasons = refusalCounts(rows, (count) => `${count} could not be asked`);
  if (asked === 0) return `None asked: ${reasons.join(", ")}`;
  return [`Asked ${agentCountLabel(asked)} to ${MODE_WORDS[mode]}`, ...reasons].join(", ");
};

/** Whether a result line is good news, mixed, or bad: the line's colour. */
export const offboardLineTone = (rows: ReadonlyArray<SeatOffboardRunRow>): "done" | "partial" | "refused" => {
  const ok = rows.filter((row) => row.ok).length;
  if (ok === rows.length && rows.length > 0) return "done";
  return ok === 0 ? "refused" : "partial";
};

const minutesWords = (minutes: number): string => {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
};

/**
 * What the operator reads above the buttons. One seat: how long it has sat
 * still and which side of the cache window that is. A selection: how many
 * are past the window. Empty when there is nothing to say.
 */
export const offboardIdleLine = (statuses: ReadonlyArray<SeatOffboardStatus>): string => {
  if (statuses.length === 0) return "";
  if (statuses.length === 1) {
    const only = statuses[0]!;
    if (only.idleMinutes === null) return "";
    return only.pastWindow
      ? `Idle ${minutesWords(only.idleMinutes)}, past the cache window: a turn now is expensive.`
      : `Idle ${minutesWords(only.idleMinutes)}, inside the cache window: a turn is still cheap.`;
  }
  const past = statuses.filter((status) => status.pastWindow).length;
  if (past === 0) return "None is past the cache window.";
  if (past < statuses.length) return `${past} of ${statuses.length} are past the cache window.`;
  return past === 2 ? "Both are past the cache window." : `All ${past} are past the cache window.`;
};

/** "180k", "1.2M", "850": a token estimate at the precision it has. */
const tokensWords = (tokens: number): string => {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
};

/**
 * What one seat's current session has done: time spent working, and the
 * size of its transcript as a token estimate. Either may be unknown (the
 * size is, when the transcript cannot be found); empty when both are.
 */
export const offboardSessionLine = (
  workMinutes: number | null | undefined,
  tokens: number | null | undefined,
): string => {
  const work = typeof workMinutes === "number" ? `${minutesWords(workMinutes)} of work` : undefined;
  const size = typeof tokens === "number" ? `about ${tokensWords(tokens)} tokens` : undefined;
  if (work === undefined && size === undefined) return "";
  return `This session: ${[work, size].filter((part) => part !== undefined).join(", ")}.`;
};

/** The action to mark as preferred: one seat's own; a selection has none. */
export const offboardPreferred = (statuses: ReadonlyArray<SeatOffboardStatus>): SeatOffboardAction | undefined =>
  statuses.length === 1 ? statuses[0]!.preferred : undefined;

/**
 * Why Offboard now cannot be pressed, or undefined when it can. One seat:
 * its own reason. A selection stays pressable while any seat can be closed;
 * the result line then says which were not.
 */
export const offboardNowBlock = (statuses: ReadonlyArray<SeatOffboardStatus>): string | undefined => {
  if (statuses.length === 0) return undefined;
  if (statuses.some((status) => status.now.allowed)) return undefined;
  if (statuses.length === 1) {
    const now = statuses[0]!.now;
    return now.allowed ? undefined : now.reason;
  }
  return "None of these agents can be closed right now.";
};

// --- the automatic rules -------------------------------------------------------

/**
 * A change to the offboard rules, judged before it is sent: the patch to
 * save, or why the rules it would leave cannot be saved (main refuses the
 * same patch with the same sentence).
 */
export const planOffboardRulesChange = (
  rules: OffboardRules,
  patch: OffboardRulesPatch,
): { readonly ok: true; readonly patch: OffboardRulesPatch } | { readonly ok: false; readonly problem: string } => {
  const problem = offboardRulesProblem(applyOffboardRulesPatch(rules, patch));
  return problem === undefined ? { ok: true, patch } : { ok: false, problem };
};

/**
 * A new override for one harness, seeded with what that harness runs on
 * today: the window, and each rule's switch and minutes, so the row never
 * shows a blank and later installation changes do not move it.
 */
export const seedHarnessOverride = (rules: OffboardRules, harness: string): OffboardRulesPatch => {
  const set = offboardRulesFor(rules, harness);
  return {
    harness: {
      [harness]: {
        cacheWindowMinutes: set.cacheWindowMinutes,
        auto: { enabled: set.auto.enabled, minutes: set.auto.minutes },
        nudge: { enabled: set.nudge.enabled, minutes: set.nudge.minutes },
      },
    },
  };
};

/** A typed minutes value, or undefined when it is not a whole number in range. */
export const parseOffboardMinutes = (raw: string): number | undefined => {
  const text = raw.trim();
  if (!/^\d+$/u.test(text)) return undefined;
  const minutes = Number(text);
  return minutes >= OFFBOARD_MINUTES_MIN && minutes <= OFFBOARD_MINUTES_MAX ? minutes : undefined;
};
