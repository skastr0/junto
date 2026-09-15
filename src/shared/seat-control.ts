import { Schema } from "effect";
import type { AgentSeatState } from "./agent-seat-state";
import { TaskState } from "./work-model";

// Seat wait/observe wire contract — the shared shapes for work-control ops
// `seat.wait`, `seat.read` and `tasks.wait`.
//
// These three ops are read-only over planes that already exist: the seat state
// machine's debounced event stream, the settled observer grid, and the work
// mutation seam. Nothing here grants input, resize, or signal authority, and
// nothing here authors the canvas.
//
// Every wait and every follow is bounded so a stuck peer cannot hang a caller,
// and a bounded read never claims more than the retained window it actually
// returns. Pure module: no Node imports, so the daemon, the CLI and tests share
// one source of truth.

// ---------------------------------------------------------------------------
// Bounds

/** Longest single wait. A caller that needs longer re-issues the wait. */
export const SEAT_WAIT_MAX_MS = 600_000;
export const SEAT_WAIT_DEFAULT_MS = 60_000;
/** Longest task wait. Same ceiling and same reason as the seat wait. */
export const TASK_WAIT_MAX_MS = SEAT_WAIT_MAX_MS;
export const TASK_WAIT_DEFAULT_MS = SEAT_WAIT_DEFAULT_MS;
/** Lines a single read may return, and the default when none is named. */
export const SEAT_READ_MAX_LINES = 2_000;
export const SEAT_READ_DEFAULT_LINES = 40;
/** Bytes a single read may return. A wider window is clipped, not refused. */
export const SEAT_READ_MAX_BYTES = 64 * 1024;
/** Longest bounded follow. */
export const SEAT_READ_MAX_SECONDS = 600;
export const SEAT_READ_DEFAULT_FOLLOW_SECONDS = 30;
/** Budget a single (non-follow) read gets before the transport gives up. */
export const SEAT_READ_DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Vocabulary

/**
 * Seat states a wait can name. Declared here as literals because the wire
 * schema must be a tuple; the `satisfies` clause keeps this list a subset of
 * the product vocabulary, and the exhaustiveness check below keeps it complete.
 */
export const SEAT_STATE_LITERALS = [
  "idle",
  "working",
  "attention",
  "unknown",
  "gone",
] as const satisfies ReadonlyArray<AgentSeatState>;

type MissingSeatState = Exclude<
  AgentSeatState,
  (typeof SEAT_STATE_LITERALS)[number]
>;
/** Compile-time proof the wire vocabulary covers every product seat state. */
export const SEAT_STATES_COMPLETE: MissingSeatState extends never
  ? true
  : ["seat-control is missing a product seat state", MissingSeatState] = true;

export const SeatState = Schema.Literals(SEAT_STATE_LITERALS);
export type SeatState = typeof SeatState.Type;

export const SeatConfidence = Schema.Literals(["high", "low"]);
export type SeatConfidence = typeof SeatConfidence.Type;

export const SeatWaitUntil = Schema.Literals([
  "idle",
  "attention",
  "working",
  "gone",
]);
export type SeatWaitUntil = typeof SeatWaitUntil.Type;

export const TaskWaitUntil = Schema.Literals([
  "completed",
  "input-required",
  "rejected",
]);
export type TaskWaitUntil = typeof TaskWaitUntil.Type;

/** Why a bounded follow returned. */
export const SeatReadStopped = Schema.Literals([
  /** Follow was not requested: this is a single settled read. */
  "not-following",
  /** The settled grid advanced past the caller's cursor. */
  "advanced",
  /** The follow duration elapsed with the cursor still current. */
  "duration",
  /** The generation was replaced, so the old stream is over. */
  "replaced",
]);
export type SeatReadStopped = typeof SeatReadStopped.Type;

/** Error type a bounded wait raises when its deadline passes. */
export const SEAT_TIMEOUT_ERROR = "Timeout" as const;

// ---------------------------------------------------------------------------
// Args

const boundedMs = (max: number) =>
  Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(1)),
    Schema.check(Schema.isLessThanOrEqualTo(max)),
  );

/**
 * `seat wait <seat|--any> --until <state> [--timeout <duration>]`.
 *
 * Exactly one of `target` and `any`. `any` means the currently authorized peer
 * seats — connected agent nodes whose edge holds the `seat.wait` port — never
 * every seat on the machine.
 */
export const SeatWaitArgs = Schema.Struct({
  /** Canvas node id of the seat to watch. */
  target: Schema.optionalKey(
    Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  ),
  /** Watch every currently authorized peer seat instead of one named seat. */
  any: Schema.optionalKey(Schema.Boolean),
  until: SeatWaitUntil,
  timeoutMs: Schema.optionalKey(boundedMs(SEAT_WAIT_MAX_MS)),
})
  .pipe(
    Schema.check(
      Schema.makeFilter((args) => {
        const hasTarget = args.target !== undefined;
        const wantsAny = args.any === true;
        if (hasTarget && wantsAny) {
          return "seat.wait takes exactly one of target or any";
        }
        if (!hasTarget && !wantsAny) {
          return "seat.wait requires a target seat or any: true";
        }
        return true;
      }),
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type SeatWaitArgs = typeof SeatWaitArgs.Type;

/**
 * `seat read <seat> [--lines N] [--since <seq>] [--follow] [--max-seconds S]`.
 *
 * `sinceGeneration` is the generation the caller's `since` sequence belongs to.
 * A read never concatenates a replacement generation into the old stream: when
 * the generation moved, the response says so and returns only the current
 * generation's window.
 */
export const SeatReadArgs = Schema.Struct({
  target: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  /** Retained lines to return, counted back from the newest line. */
  lines: Schema.optionalKey(boundedMs(SEAT_READ_MAX_LINES)),
  /** Observer sequence the caller last saw. */
  since: Schema.optionalKey(
    Schema.Number.pipe(
      Schema.check(Schema.isInt()),
      Schema.check(Schema.isGreaterThanOrEqualTo(0)),
    ),
  ),
  /** Generation `since` was observed in; required with `since`. */
  sinceGeneration: Schema.optionalKey(Schema.String),
  follow: Schema.optionalKey(Schema.Boolean),
  maxSeconds: Schema.optionalKey(boundedMs(SEAT_READ_MAX_SECONDS)),
})
  .pipe(
    Schema.check(
      Schema.makeFilter((args) =>
        args.since !== undefined && args.sinceGeneration === undefined
          ? "seat.read since requires sinceGeneration (a sequence belongs to one generation)"
          : true,
      ),
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type SeatReadArgs = typeof SeatReadArgs.Type;

/** `tasks wait <task> --until <state> [--timeout <duration>]`. */
export const TaskWaitArgs = Schema.Struct({
  /** Canvas node id of the task sink holding the task. */
  target: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  taskId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  until: TaskWaitUntil,
  timeoutMs: Schema.optionalKey(boundedMs(TASK_WAIT_MAX_MS)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type TaskWaitArgs = typeof TaskWaitArgs.Type;

// ---------------------------------------------------------------------------
// Results

/**
 * One observed seat state. `generation` is the session generation the terminal
 * host reports; `epoch` is the generation the state event belongs to. They
 * agree while the seat is occupied by the generation that produced the event.
 */
export const SeatWaitResult = Schema.Struct({
  target: Schema.String,
  state: SeatState,
  reason: Schema.String,
  confidence: SeatConfidence,
  generation: Schema.String,
  epoch: Schema.String,
  at: Schema.Number,
});
export type SeatWaitResult = typeof SeatWaitResult.Type;

/**
 * One bounded read of a settled observer grid.
 *
 * `seq` is the observer journal sequence of the grid the text came from, and
 * `epoch` is that grid's generation. `generation` is the generation the
 * returned window belongs to — it equals the seat's current session generation
 * whenever the window is current, and the window's own generation when the seat
 * was replaced while the read was in flight. `replaced` is true when the
 * returned window is not the caller's cursor generation, either because the
 * caller's cursor generation is gone or because the seat has since moved to a
 * new one: a replacement is explicit, never concatenated, and the text always
 * belongs to the generation the result names. `truncated` means the retained
 * window or the byte bound clipped the result: this is the settled tail, never
 * a claim of the full transcript.
 */
export const SeatReadResult = Schema.Struct({
  target: Schema.String,
  state: SeatState,
  reason: Schema.String,
  confidence: SeatConfidence,
  epoch: Schema.String,
  generation: Schema.String,
  replaced: Schema.Boolean,
  seq: Schema.Number,
  text: Schema.String,
  lineCount: Schema.Number,
  bytes: Schema.Number,
  truncated: Schema.Boolean,
  stopped: SeatReadStopped,
});
export type SeatReadResult = typeof SeatReadResult.Type;

/** One observed task state. `epoch` is the task's defect generation. */
export const TaskWaitResult = Schema.Struct({
  taskId: Schema.String,
  state: TaskState,
  epoch: Schema.Number,
  at: Schema.Number,
});
export type TaskWaitResult = typeof TaskWaitResult.Type;

// ---------------------------------------------------------------------------
// Lowering helpers (CLI input → wire args)

/** Clamp a spoken line count onto the wire bound. */
export const clampReadLines = (lines: number | undefined): number => {
  if (lines === undefined) return SEAT_READ_DEFAULT_LINES;
  if (!Number.isFinite(lines)) return SEAT_READ_DEFAULT_LINES;
  return Math.max(1, Math.min(SEAT_READ_MAX_LINES, Math.trunc(lines)));
};

/** Clamp a spoken follow duration onto the wire bound, in seconds. */
export const clampFollowSeconds = (seconds: number | undefined): number => {
  if (seconds === undefined) return SEAT_READ_DEFAULT_FOLLOW_SECONDS;
  if (!Number.isFinite(seconds)) return SEAT_READ_DEFAULT_FOLLOW_SECONDS;
  return Math.max(1, Math.min(SEAT_READ_MAX_SECONDS, Math.trunc(seconds)));
};

/**
 * Socket wait for one bounded operation. The transport's own timeout must sit
 * above the operation's deadline, or a healthy wait would be reported as a
 * dropped socket; the slack covers response framing.
 */
export const socketTimeoutFor = (deadlineMs: number, slackMs = 5_000): number =>
  deadlineMs + slackMs;

/** UTF-8 length without a Node-only dependency, so the module stays portable. */
export const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).length;

/**
 * Clip one line to at most `maxBytes` UTF-8 bytes, cutting on a code-point
 * boundary. Slicing by UTF-16 units would return far more than the budget for
 * multibyte text (and could split a surrogate pair).
 */
const clipLineToBytes = (line: string, maxBytes: number): string => {
  let bytes = 0;
  let kept = "";
  for (const point of line) {
    const cost = utf8ByteLength(point);
    if (bytes + cost > maxBytes) break;
    bytes += cost;
    kept += point;
  }
  return kept;
};

/** Clip text to the read byte bound on a line boundary. */
export const clipReadText = (
  lines: ReadonlyArray<string>,
  maxBytes = SEAT_READ_MAX_BYTES,
): { readonly lines: ReadonlyArray<string>; readonly truncated: boolean } => {
  const kept: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const lineBytes = utf8ByteLength(line);
    // The separator is charged only between two kept lines, which is exactly
    // what the joined text costs: N lines carry N-1 newlines.
    const cost = kept.length === 0 ? lineBytes : lineBytes + 1;
    if (bytes + cost > maxBytes) {
      truncated = true;
      break;
    }
    bytes += cost;
    kept.unshift(line);
  }
  if (kept.length === 0 && lines.length > 0) {
    // One line longer than the whole budget: return it clipped to the budget
    // rather than returning nothing, and report whether the clip actually cut.
    const only = lines[lines.length - 1]!;
    const clipped = clipLineToBytes(only, maxBytes);
    return { lines: [clipped], truncated: clipped.length < only.length };
  }
  return { lines: kept, truncated };
};
