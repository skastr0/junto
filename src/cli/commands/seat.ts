import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Option } from "effect";
import {
  SEAT_READ_DEFAULT_FOLLOW_SECONDS,
  SEAT_READ_DEFAULT_LINES,
  SEAT_READ_DEFAULT_TIMEOUT_MS,
  SEAT_READ_MAX_LINES,
  SEAT_READ_MAX_SECONDS,
  SEAT_WAIT_DEFAULT_MS,
  SEAT_WAIT_MAX_MS,
  TASK_WAIT_DEFAULT_MS,
  TASK_WAIT_MAX_MS,
  socketTimeoutFor,
  type SeatReadArgs,
  type SeatWaitArgs,
  type SeatWaitUntil,
  type TaskWaitArgs,
  type TaskWaitUntil,
} from "../../shared/seat-control";
import type { WorkOpName } from "../../shared/work-control";
import { parseWaitFor } from "../core/duration";
import { InputError } from "../core/errors";
import { executeJsonCommand } from "../core/output";
import { WorkSocket } from "../core/socket";

const toUndefined = <A>(value: Option.Option<A>) =>
  Option.isSome(value) ? value.value : undefined;

/** Domain call — identity is process-bind on the server, not a payload claim. */
const callDomain = <A>(op: WorkOpName, item: A, timeout?: number) =>
  Effect.gen(function* () {
    const socket = yield* WorkSocket;
    return yield* socket.call(op, item, timeout);
  });

const SEAT_WAIT_UNTIL: ReadonlyArray<SeatWaitUntil> = [
  "idle",
  "attention",
  "working",
  "gone",
  "replied",
];

const TASK_WAIT_UNTIL: ReadonlyArray<TaskWaitUntil> = [
  "completed",
  "input-required",
  "rejected",
];

const seatUntilFlag = Flag.string("until").pipe(
  Flag.withDescription(`State to wait for (${SEAT_WAIT_UNTIL.join(" | ")})`),
);

const taskUntilFlag = Flag.string("until").pipe(
  Flag.withDescription(`Task state to wait for (${TASK_WAIT_UNTIL.join(" | ")})`),
);

const timeoutFlag = Flag.string("timeout").pipe(
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
}): Lowered<SeatWaitArgs> => {
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
      until: input.until as SeatWaitUntil,
      timeoutMs: parsedTimeout.ms,
      ...(input.after !== undefined ? { after: input.after } : {}),
    },
    socketTimeoutMs: socketTimeoutFor(parsedTimeout.ms),
  };
};

/**
 * Lower `seat read <seat> [--lines N] [--since <seq> --since-generation <g>]
 * [--follow --max-seconds S]` onto the wire.
 */
export const lowerSeatRead = (input: {
  readonly seat: string | undefined;
  readonly lines: number | undefined;
  readonly since: string | undefined;
  readonly sinceGeneration: string | undefined;
  readonly follow: boolean;
  readonly maxSeconds: string | undefined;
  readonly brief?: boolean;
}): Lowered<SeatReadArgs> => {
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
    if (input.lines !== undefined || input.since !== undefined || input.sinceGeneration !== undefined ||
        input.follow || input.maxSeconds !== undefined) {
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
  if (input.since !== undefined && input.sinceGeneration === undefined) {
    return {
      ok: false,
      error: new InputError({
        message: "--since requires --since-generation",
        path: "since",
        hint: "an observer sequence belongs to one generation",
        next_step: "copy both from the previous seat read result",
      }),
    };
  }
  let sinceValue: number | undefined;
  if (input.since !== undefined) {
    const parsed = parseWaitFor(input.since);
    if (!parsed.ok || !Number.isInteger(parsed.ms) || parsed.ms < 0) {
      return {
        ok: false,
        error: new InputError({
          message: "--since must be an observer sequence (a whole number)",
          path: "since",
          received: input.since,
        }),
      };
    }
    sinceValue = parsed.ms;
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
      ...(sinceValue !== undefined ? { since: sinceValue } : {}),
      ...(input.sinceGeneration !== undefined
        ? { sinceGeneration: input.sinceGeneration }
        : {}),
      ...(input.follow ? { follow: true } : {}),
      ...(input.follow ? { maxSeconds: parsedMax.ms / 1_000 } : {}),
    },
    socketTimeoutMs: socketTimeoutFor(budgetMs),
  };
};

/** Lower `tasks wait <task> --target <sink> --until <state> [--timeout]`. */
export const lowerTaskWait = (input: {
  readonly task: string;
  readonly target: string;
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
      target: input.target,
      taskId: input.task,
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
    seat: Argument.string("seat").pipe(
      Argument.optional,
      Argument.withDescription("Seat to watch (canvas node id); omit with --any"),
    ),
    any: Flag.boolean("any").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Wait on every currently authorized peer seat instead of one named seat",
      ),
    ),
    until: seatUntilFlag,
    timeout: timeoutFlag,
    after: Flag.string("after").pipe(
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
        return yield* callDomain("seat.wait", lowered.args, lowered.socketTimeoutMs);
      }),
    ),
).pipe(
  Command.withDescription(
    "Wait for a seat to reach a state, or with --until replied for its mail to you (grant seat.wait). Bounded: returns the observed state, reason, confidence and generation (and the reply), or a typed timeout.",
  ),
);

const seatReadCommand = Command.make(
  "read",
  {
    seat: Argument.string("seat").pipe(
      Argument.optional,
      Argument.withDescription("Seat to observe (canvas node id); omit with --brief"),
    ),
    brief: Flag.boolean("brief").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Every peer you may read in one call: identity, state, preamble and recent mail, without screens",
      ),
    ),
    lines: Flag.integer("lines").pipe(
      Flag.optional,
      Flag.withDescription(
        `Retained lines to return (max ${SEAT_READ_MAX_LINES}, default ${SEAT_READ_DEFAULT_LINES})`,
      ),
    ),
    since: Flag.string("since").pipe(
      Flag.optional,
      Flag.withDescription(
        "Observer sequence the caller last saw; pair with --since-generation",
      ),
    ),
    sinceGeneration: Flag.string("since-generation").pipe(
      Flag.optional,
      Flag.withDescription(
        "Generation --since was observed in; required with --since, and a different current generation is reported as replaced",
      ),
    ),
    follow: Flag.boolean("follow").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Hold until the settled grid advances past the cursor, the generation is replaced, or --max-seconds elapses",
      ),
    ),
    maxSeconds: Flag.string("max-seconds").pipe(
      Flag.optional,
      Flag.withDescription(
        `Bounded follow as seconds or a duration (max ${SEAT_READ_MAX_SECONDS}, default ${SEAT_READ_DEFAULT_FOLLOW_SECONDS})`,
      ),
    ),
  },
  ({ seat, brief, lines, since, sinceGeneration, follow, maxSeconds }) =>
    executeJsonCommand(
      "seat read",
      Effect.gen(function* () {
        const lowered = lowerSeatRead({
          seat: toUndefined(seat),
          brief,
          lines: toUndefined(lines),
          since: toUndefined(since),
          sinceGeneration: toUndefined(sinceGeneration),
          follow,
          maxSeconds: toUndefined(maxSeconds),
        });
        if (!lowered.ok) return yield* Effect.fail(lowered.error);
        return yield* callDomain("seat.read", lowered.args, lowered.socketTimeoutMs);
      }),
    ),
).pipe(
  Command.withDescription(
    "Read a seat in one call (grant terminal.read): who it is, its state and since when, its live preamble, recent mail between you, and a bounded window of its settled terminal grid. Read-only: no input, resize, or signal. --follow holds until the grid advances; --brief reads every peer without screens.",
  ),
);

export const seatCommand = Command.make("seat").pipe(
  Command.withDescription(
    "Observe and wait on authorized peer seats — bounded, read-only",
  ),
  Command.withSubcommands([seatWaitCommand, seatReadCommand]),
);

// --- tasks wait (registered by the tasks command) ---

export const tasksWaitCommand = Command.make(
  "wait",
  {
    task: Argument.string("task").pipe(
      Argument.withDescription("Task id to wait on"),
    ),
    target: Flag.string("target").pipe(
      Flag.withDescription("Task sink node id that holds the task"),
    ),
    until: taskUntilFlag,
    timeout: timeoutFlag,
  },
  ({ task, target, until, timeout }) =>
    executeJsonCommand(
      "tasks wait",
      Effect.gen(function* () {
        const lowered = lowerTaskWait({
          task,
          target,
          until,
          timeout: toUndefined(timeout),
        });
        if (!lowered.ok) return yield* Effect.fail(lowered.error);
        return yield* callDomain("tasks.wait", lowered.args, lowered.socketTimeoutMs);
      }),
    ),
).pipe(
  Command.withDescription(
    "Wait for a task on a connected sink to reach a state. Uses work change events and current task-edge authority; bounded, with a typed timeout.",
  ),
);
