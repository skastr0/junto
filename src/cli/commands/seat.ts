import { Argument, Command, Flag } from "effect/cli";
import { Effect, Option } from "effect";
import {
  SEAT_READ_DEFAULT_FOLLOW_SECONDS,
  SEAT_READ_DEFAULT_LINES,
  SEAT_READ_DEFAULT_TIMEOUT_MS,
  SEAT_READ_MAX_LINES,
  SEAT_READ_MAX_SECONDS,
  SEAT_WAIT_DEFAULT_MS,
  SEAT_WAIT_MAX_MS,
  SEAT_WAIT_REQUEST_UNTIL,
  socketTimeoutFor,
  type SeatReadRequest,
  type SeatWaitRequest,
  type SeatWaitRequestUntil,
} from "../../shared/seat-control";
import {
  TASK_WAIT_DEFAULT_MS,
  TASK_WAIT_MAX_MS,
  TASK_WAIT_UNTIL,
  type TaskWaitArgs,
  type TaskWaitUntil,
} from "../../shared/task-control";
import { parseWaitFor } from "../core/duration";
import { InputError } from "../core/errors";
import { executeJsonCommand } from "../core/output";
import { SeatRead, SeatWait } from "../../contract/work/seat";
import { TaskWait } from "../../contract/work/task";
import { callWorkRpc } from "../core/socket";

const toUndefined = <A>(value: Option.Option<A>) =>
  Option.isSome(value) ? value.value : undefined;

const SEAT_WAIT_UNTIL: ReadonlyArray<SeatWaitRequestUntil> = SEAT_WAIT_REQUEST_UNTIL;

const seatUntilFlag = Flag.String("until").pipe(
  Flag.withDescription(`State to wait for (${SEAT_WAIT_UNTIL.join(" | ")})`),
);

const taskUntilFlag = Flag.String("until").pipe(
  Flag.withDescription(`Task state to wait for (${TASK_WAIT_UNTIL.join(" | ")})`),
);

const timeoutFlag = Flag.String("timeout").pipe(
  Flag.optional,
  Flag.withDescription(
    `Bounded wait as a duration ("600s", "10m") or milliseconds (max ${SEAT_WAIT_MAX_MS / 1000}s, default ${SEAT_WAIT_DEFAULT_MS / 1000}s)`,
  ),
);

/**
 * Parse one bounded duration. A duration the caller can speak ("600s") lowers
 * to the milliseconds the wire carries; an out-of-range value is refused rather
 * than silently clamped, so the caller learns the bound instead of losing time.
 */
const parseBoundedMs = (
  flag: string,
  raw: string | undefined,
  maxMs: number,
  fallbackMs: number,
): { readonly ok: true; readonly ms: number } | { readonly ok: false; readonly message: string } => {
  if (raw === undefined) return { ok: true, ms: fallbackMs };
  const parsed = parseWaitFor(raw);
  if (!parsed.ok) return { ok: false, message: `--${flag}: ${parsed.message}` };
  if (parsed.ms < 1) {
    return { ok: false, message: `--${flag} must be at least 1ms` };
  }
  if (parsed.ms > maxMs) {
    return {
      ok: false,
      message: `--${flag} is capped at ${maxMs / 1000}s; re-issue the wait for the remainder`,
    };
  }
  return { ok: true, ms: parsed.ms };
};

const untilError = (flag: string, raw: string, allowed: ReadonlyArray<string>) =>
  new InputError({
    message: `--${flag} must be one of ${allowed.join(", ")}`,
    path: flag,
    received: raw,
    hint: "the wait answers only on the states it names",
  });

/**
 * Parse `--max-seconds`. Unlike every other duration flag here, a bare number
 * means *seconds* — the flag names its unit — while an explicit duration
 * ("5m", "30000ms") is honored as written. The wire carries whole seconds.
 */
const parseMaxSeconds = (
  raw: string | undefined,
): { readonly ok: true; readonly ms: number } | { readonly ok: false; readonly message: string } => {
  if (raw === undefined) return { ok: true, ms: SEAT_READ_DEFAULT_FOLLOW_SECONDS * 1_000 };
  const trimmed = raw.trim();
  const spelled = /^\d+(?:\.\d+)?$/.test(trimmed) ? `${trimmed}s` : trimmed;
  const parsed = parseWaitFor(spelled);
  if (!parsed.ok) return { ok: false, message: `--max-seconds: ${parsed.message}` };
  if (parsed.ms < 1_000 || parsed.ms % 1_000 !== 0) {
    return {
      ok: false,
      message: '--max-seconds must be a whole number of seconds, or a duration like "5m"',
    };
  }
  if (parsed.ms > SEAT_READ_MAX_SECONDS * 1_000) {
    return {
      ok: false,
      message: `--max-seconds is capped at ${SEAT_READ_MAX_SECONDS}s; re-issue the follow for the remainder`,
    };
  }
  return { ok: true, ms: parsed.ms };
};

type Lowered<A> =
  | { readonly ok: true; readonly args: A; readonly socketTimeoutMs: number }
  | { readonly ok: false; readonly error: InputError };

/**
 * Lower `seat wait <seat|--any> --until <state> [--timeout <duration>]` onto the
 * wire. Kept as a pure function so the flag surface is testable without a
 * running app: the CLI's job here is exactly this translation plus the socket
 * timeout that must sit above the operation's own deadline.
 */
export const lowerSeatWait = (input: {
  readonly seat: string | undefined;
  readonly any: boolean;
  readonly until: string;
  readonly timeout: string | undefined;
  readonly after?: string | undefined;
}): Lowered<SeatWaitRequest> => {
  if (input.seat !== undefined && input.any) {
    return {
      ok: false,
      error: new InputError({
        message: "seat wait takes a seat argument or --any, not both",
        path: "seat",
        hint: "--any waits on the peer seats the caller's edges authorize",
      }),
    };
  }
  if (input.seat === undefined && !input.any) {
    return {
      ok: false,
      error: new InputError({
        message: "seat wait needs a seat argument or --any",
        path: "seat",
        hint: "name the seat to watch, or pass --any for every authorized peer",
        next_step: "junto seat wait <seat> --until idle",
      }),
    };
  }
  if (!(SEAT_WAIT_UNTIL as ReadonlyArray<string>).includes(input.until)) {
    return { ok: false, error: untilError("until", input.until, SEAT_WAIT_UNTIL) };
  }
  if (input.after !== undefined && input.until !== "replied") {
    return {
      ok: false,
      error: new InputError({
        message: "--after applies to --until replied",
        path: "after",
        hint: "--after names the last mail you saw from the peer",
      }),
    };
  }
  const parsedTimeout = parseBoundedMs(
    "timeout",
    input.timeout,
    SEAT_WAIT_MAX_MS,
    SEAT_WAIT_DEFAULT_MS,
  );
  if (!parsedTimeout.ok) {
    return { ok: false, error: new InputError({ message: parsedTimeout.message, path: "timeout" }) };
  }
  return {
    ok: true,
    args: {
      ...(input.seat !== undefined ? { target: input.seat } : { any: true }),
      until: input.until as SeatWaitRequestUntil,
      timeoutMs: parsedTimeout.ms,
      ...(input.after !== undefined ? { after: input.after } : {}),
    },
    socketTimeoutMs: socketTimeoutFor(parsedTimeout.ms),
  };
};

/**
 * Lower `seat read <seat> [--lines N] [--since <cursor>] [--follow --max-seconds S]
 * [--internals]` onto the wire. `--since` takes the `cursor` a previous read
 * answered, as it was printed.
 */
export const lowerSeatRead = (input: {
  readonly seat: string | undefined;
  readonly lines: number | undefined;
  readonly since: string | undefined;
  readonly follow: boolean;
  readonly maxSeconds: string | undefined;
  readonly brief?: boolean;
  readonly internals?: boolean;
}): Lowered<SeatReadRequest> => {
  if (input.brief === true) {
    if (input.seat !== undefined) {
      return {
        ok: false,
        error: new InputError({
          message: "seat read --brief reads every peer and takes no seat",
          path: "seat",
          next_step: "junto seat read --brief",
        }),
      };
    }
    if (input.lines !== undefined || input.since !== undefined || input.follow ||
        input.maxSeconds !== undefined || input.internals === true) {
      return {
        ok: false,
        error: new InputError({
          message: "seat read --brief returns no screen, so it takes no --lines, --since or --follow",
          path: "brief",
        }),
      };
    }
    return { ok: true, args: { brief: true }, socketTimeoutMs: socketTimeoutFor(SEAT_READ_DEFAULT_TIMEOUT_MS) };
  }
  if (input.seat === undefined) {
    return {
      ok: false,
      error: new InputError({
        message: "seat read needs a seat argument, or --brief for every peer",
        path: "seat",
        next_step: "junto seat read <seat>",
      }),
    };
  }
  const seat = input.seat;
  const since = input.since?.trim();
  if (since !== undefined && since.length === 0) {
    return {
      ok: false,
      error: new InputError({
        message: "--since takes the cursor a previous seat read answered",
        path: "since",
        next_step: `junto seat read ${seat}`,
      }),
    };
  }
  if (
    input.lines !== undefined &&
    (input.lines < 1 || input.lines > SEAT_READ_MAX_LINES)
  ) {
    return {
      ok: false,
      error: new InputError({
        message: `--lines must be between 1 and ${SEAT_READ_MAX_LINES}`,
        path: "lines",
        received: input.lines,
      }),
    };
  }
  if (!input.follow && input.maxSeconds !== undefined) {
    return {
      ok: false,
      error: new InputError({
        message: "--max-seconds applies to --follow",
        path: "max-seconds",
      }),
    };
  }
  const parsedMax = parseMaxSeconds(input.maxSeconds);
  if (!parsedMax.ok) {
    return {
      ok: false,
      error: new InputError({ message: parsedMax.message, path: "max-seconds" }),
    };
  }
  const budgetMs = input.follow ? parsedMax.ms : SEAT_READ_DEFAULT_TIMEOUT_MS;
  return {
    ok: true,
    args: {
      target: seat,
      ...(input.lines !== undefined ? { lines: input.lines } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(input.follow ? { follow: true } : {}),
      ...(input.follow ? { maxSeconds: parsedMax.ms / 1_000 } : {}),
      ...(input.internals === true ? { internals: true } : {}),
    },
    socketTimeoutMs: socketTimeoutFor(budgetMs),
  };
};

/** Lower `task wait <task> --until <state> [--timeout]` onto the task verb (plan 04). */
export const lowerTaskWait = (input: {
  readonly task: string;
  readonly until: string;
  readonly timeout: string | undefined;
}): Lowered<TaskWaitArgs> => {
  if (!(TASK_WAIT_UNTIL as ReadonlyArray<string>).includes(input.until)) {
    return { ok: false, error: untilError("until", input.until, TASK_WAIT_UNTIL) };
  }
  const parsedTimeout = parseBoundedMs(
    "timeout",
    input.timeout,
    TASK_WAIT_MAX_MS,
    TASK_WAIT_DEFAULT_MS,
  );
  if (!parsedTimeout.ok) {
    return { ok: false, error: new InputError({ message: parsedTimeout.message, path: "timeout" }) };
  }
  return {
    ok: true,
    args: {
      task: input.task,
      until: input.until as TaskWaitUntil,
      timeoutMs: parsedTimeout.ms,
    },
    socketTimeoutMs: socketTimeoutFor(parsedTimeout.ms),
  };
};

// --- seat ---

const seatWaitCommand = Command.make(
  "wait",
  {
    seat: Argument.String("seat").pipe(
      Argument.optional,
      Argument.withDescription("Seat to watch (canvas node id); omit with --any"),
    ),
    any: Flag.Boolean("any").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Wait on every currently authorized peer seat instead of one named seat",
      ),
    ),
    until: seatUntilFlag,
    timeout: timeoutFlag,
    after: Flag.String("after").pipe(
      Flag.optional,
      Flag.withDescription("With --until replied: only the peer's mail after this message id answers"),
    ),
  },
  ({ seat, any, until, timeout, after }) =>
    executeJsonCommand(
      "seat wait",
      Effect.gen(function* () {
        const lowered = lowerSeatWait({
          seat: toUndefined(seat),
          any,
          until,
          timeout: toUndefined(timeout),
          after: toUndefined(after),
        });
        if (!lowered.ok) return yield* Effect.fail(lowered.error);
        return yield* callWorkRpc(SeatWait, lowered.args, lowered.socketTimeoutMs);
      }),
    ),
).pipe(
  Command.withDescription(
    "Wait for a seat to reach a collaboration state (idle, working, waiting-on-operator, blocked, ready-for-review, done), or with --until replied for its mail to you (grant seat.wait). Bounded: returns the state (and the reply), or a typed timeout. Every connected seat is reachable: mail it, whatever its state.",
  ),
);

const seatReadCommand = Command.make(
  "read",
  {
    seat: Argument.String("seat").pipe(
      Argument.optional,
      Argument.withDescription("Seat to observe (canvas node id); omit with --brief"),
    ),
    brief: Flag.Boolean("brief").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Every peer you may read in one call: identity, state, preamble and recent mail, without screens",
      ),
    ),
    lines: Flag.Int("lines").pipe(
      Flag.optional,
      Flag.withDescription(
        `Retained lines to return (max ${SEAT_READ_MAX_LINES}, default ${SEAT_READ_DEFAULT_LINES})`,
      ),
    ),
    since: Flag.String("since").pipe(
      Flag.optional,
      Flag.withDescription("The cursor a previous read answered: return only what is new since it"),
    ),
    follow: Flag.Boolean("follow").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Hold until the seat's screen or state moves past the cursor, or --max-seconds elapses",
      ),
    ),
    maxSeconds: Flag.String("max-seconds").pipe(
      Flag.optional,
      Flag.withDescription(
        `Bounded follow as seconds or a duration (max ${SEAT_READ_MAX_SECONDS}, default ${SEAT_READ_DEFAULT_FOLLOW_SECONDS})`,
      ),
    ),
    internals: Flag.Boolean("internals").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Overseer only: add the harness and process internals the core observes"),
    ),
  },
  ({ seat, brief, lines, since, follow, maxSeconds, internals }) =>
    executeJsonCommand(
      "seat read",
      Effect.gen(function* () {
        const lowered = lowerSeatRead({
          seat: toUndefined(seat),
          brief,
          lines: toUndefined(lines),
          since: toUndefined(since),
          follow,
          maxSeconds: toUndefined(maxSeconds),
          internals,
        });
        if (!lowered.ok) return yield* Effect.fail(lowered.error);
        return yield* callWorkRpc(SeatRead, lowered.args, lowered.socketTimeoutMs);
      }),
    ),
).pipe(
  Command.withDescription(
    "Read a seat in one call (grant terminal.read): who it is, its collaboration state and since when, its preamble, recent mail between you, and the settled tail of its screen. Read-only. Every connected seat is reachable: mail it, whatever its state. --follow holds until the screen moves; --brief reads every peer without screens.",
  ),
);

export const seatCommand = Command.make("seat").pipe(
  Command.withDescription(
    "Observe and wait on authorized peer seats — bounded, read-only",
  ),
  Command.withSubcommands([seatWaitCommand, seatReadCommand]),
);

// --- task wait (registered by the task command) ---

export const taskWaitCommand = Command.make(
  "wait",
  {
    task: Argument.String("task").pipe(
      Argument.withDescription("A task: #42, its id, or a junto:// ref"),
    ),
    until: taskUntilFlag,
    timeout: timeoutFlag,
  },
  ({ task, until, timeout }) =>
    executeJsonCommand(
      "task wait",
      Effect.gen(function* () {
        const lowered = lowerTaskWait({
          task,
          until,
          timeout: toUndefined(timeout),
        });
        if (!lowered.ok) return yield* Effect.fail(lowered.error);
        return yield* callWorkRpc(TaskWait, lowered.args, lowered.socketTimeoutMs);
      }),
    ),
).pipe(
  Command.withDescription(
    `Wait for a task on a task node in this seat's reach to reach a state (${TASK_WAIT_UNTIL.join(" | ")}). Bounded: ${TASK_WAIT_DEFAULT_MS / 1000}s by default, at most ${TASK_WAIT_MAX_MS / 1000}s, with a typed timeout.`,
  ),
);
