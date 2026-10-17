import { Command, Flag } from "effect/unstable/cli";
import { Effect, Option, Schema } from "effect";
import { LOG_READ_DEFAULT_LIMIT, LOG_READ_MAX_LIMIT, MachineLogQuery } from "../../shared/machine-log";
import type { WorkOpName } from "../../shared/work-control";
import type { CommandCapability, CommandExample, CommandSchemaContract } from "../core/discovery";
import { DEFAULT_TIMEOUT_MS } from "../core/constants";
import { parseWaitFor } from "../core/duration";
import { InputError } from "../core/errors";
import { executeJsonCommand } from "../core/output";
import { WorkSocket } from "../core/socket";

/**
 * `junto logs`: this machine's log, read from a seat. The seat sees its own
 * rows, rows of seats it holds terminal.read to, and rows that name no seat;
 * the scope comes from its credential, and `--seat` narrows inside it. A
 * linked machine's log is the owner's `junto machine logs`.
 */

const LOGS_READ_WORK_OP = "logs.read" as WorkOpName;

/** The flags as a person types them, before they become a `MachineLogQuery`. */
export type LogsFlags = {
  readonly since?: string;
  readonly level?: string;
  readonly area?: string;
  readonly operation?: string;
  readonly seat?: string;
  readonly canvas?: string;
  readonly last?: number;
};

const decodeQuery = Schema.decodeUnknownEffect(MachineLogQuery, { onExcessProperty: "error" });

/** `since` is a duration back from now ("15m", "2h") or an ISO time. */
export const lowerLogsFlags = (flags: LogsFlags, now: number = Date.now()) =>
  Effect.gen(function* () {
    let since: number | undefined;
    if (flags.since !== undefined) {
      const duration = parseWaitFor(flags.since);
      const iso = Date.parse(flags.since);
      if (duration.ok) since = Math.max(0, now - duration.ms);
      else if (Number.isFinite(iso) && /^\d{4}-\d{2}-\d{2}/u.test(flags.since)) since = iso;
      else {
        return yield* new InputError({
          message: "--since must be a duration like 15m or 2h, or an ISO time",
          path: "since",
          received: flags.since,
        });
      }
    }
    const raw = {
      ...(since === undefined ? {} : { since }),
      ...(flags.level === undefined ? {} : { level: flags.level }),
      ...(flags.area === undefined ? {} : { area: flags.area }),
      ...(flags.operation === undefined ? {} : { operationId: flags.operation }),
      ...(flags.seat === undefined ? {} : { seat: flags.seat }),
      ...(flags.canvas === undefined ? {} : { canvas: flags.canvas }),
      ...(flags.last === undefined ? {} : { limit: flags.last }),
    };
    return yield* decodeQuery(raw).pipe(
      Effect.mapError(() => new InputError({
        message: "a filter is out of range",
        hint: `level is trace, debug, info, warn, error or fatal; area is lower-case; --last is 1 to ${LOG_READ_MAX_LIMIT}`,
      })),
    );
  });

const optionalString = (name: string, description: string) =>
  Flag.string(name).pipe(Flag.optional, Flag.withDescription(description));

export const logsFilterFlags = {
  since: optionalString("since", "Rows from this long ago (15m, 2h, 1d) or from an ISO time"),
  level: optionalString("level", "Rows at or above this level: trace, debug, info, warn, error, fatal"),
  area: optionalString("area", "One area, such as seats, link, kernel or core"),
  operation: optionalString("operation", "One operation id, at both ends of a link"),
  seat: optionalString("seat", "One seat (canvas node id), within what this seat may read"),
  canvas: optionalString("canvas", "One canvas name"),
  last: Flag.integer("last").pipe(
    Flag.optional,
    Flag.withDescription(`The newest rows to return, oldest first (default ${LOG_READ_DEFAULT_LIMIT}, max ${LOG_READ_MAX_LIMIT})`),
  ),
};

export const logsFlagsOf = (flags: {
  readonly since: Option.Option<string>;
  readonly level: Option.Option<string>;
  readonly area: Option.Option<string>;
  readonly operation: Option.Option<string>;
  readonly seat: Option.Option<string>;
  readonly canvas: Option.Option<string>;
  readonly last: Option.Option<number>;
}): LogsFlags => ({
  ...(Option.isSome(flags.since) ? { since: flags.since.value } : {}),
  ...(Option.isSome(flags.level) ? { level: flags.level.value } : {}),
  ...(Option.isSome(flags.area) ? { area: flags.area.value } : {}),
  ...(Option.isSome(flags.operation) ? { operation: flags.operation.value } : {}),
  ...(Option.isSome(flags.seat) ? { seat: flags.seat.value } : {}),
  ...(Option.isSome(flags.canvas) ? { canvas: flags.canvas.value } : {}),
  ...(Option.isSome(flags.last) ? { last: flags.last.value } : {}),
});

const DESCRIPTION =
  "Read this machine's log: your own rows, rows of seats you may read, and rows naming no seat. Newest rows, oldest first.";

export const logsCommand = Command.make(
  "logs",
  {
    ...logsFilterFlags,
    timeout: Flag.integer("timeout").pipe(
      Flag.optional,
      Flag.withDescription(`Socket call timeout in ms (default ${DEFAULT_TIMEOUT_MS})`),
    ),
  },
  ({ timeout, ...flags }) =>
    executeJsonCommand(
      "logs",
      Effect.gen(function* () {
        const query = yield* lowerLogsFlags(logsFlagsOf(flags));
        const socket = yield* WorkSocket;
        return yield* socket.call(LOGS_READ_WORK_OP, query, Option.isSome(timeout) ? timeout.value : undefined);
      }),
    ),
).pipe(Command.withDescription(DESCRIPTION));

export const logsReadSchema: CommandSchemaContract = {
  command_id: "logs.read",
  command: "logs",
  schema_id: "logs.read.input/v1",
  description: `${DESCRIPTION} Flags lower to this query; since is epoch milliseconds on the wire.`,
  schema: MachineLogQuery,
};

export const logsReadExamples: ReadonlyArray<CommandExample> = [
  {
    command_id: "logs.read",
    command: "logs",
    name: "why did a seat fail to start",
    description: "The newest start row for one seat, with its encoded failure.",
    input: { area: "seats", seat: "agent-01M4G8HNHWGG9BM2YF30KMTZYZ", limit: 1 },
    args: ["logs", "--area", "seats", "--seat", "agent-01M4G8HNHWGG9BM2YF30KMTZYZ", "--last", "1"],
  },
  {
    command_id: "logs.read",
    command: "logs",
    name: "recent errors on this machine",
    description: "Every error row from the last fifteen minutes.",
    input: { level: "error" },
    args: ["logs", "--since", "15m", "--level", "error"],
  },
];

export const logsReadCapability: CommandCapability = {
  command_id: "logs.read",
  command: "logs",
  category: "diagnostic",
  description: DESCRIPTION,
  schemas: [logsReadSchema],
  examples: logsReadExamples,
};
