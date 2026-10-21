import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Option, Schema } from "effect";
import { OP_LIST_MAX, OpListArgs, OpListState, OpShowArgs } from "../../shared/op-control";
import type {
  CommandCapability,
  CommandExample,
  CommandSchemaContract,
} from "../core/discovery";
import { DEFAULT_TIMEOUT_MS } from "../core/constants";
import { InputError } from "../core/errors";
import { executeJsonCommand } from "../core/output";
import { WorkSocket } from "../core/socket";

/**
 * `junto op` (plan 02): what became of this seat's resource writes. Every
 * write returns an opId; `op show` reads one by it, queued, applied, or
 * refused with its error, and `op list` lists them for a session that has
 * none in hand.
 */

const DESCRIPTIONS = {
  show: "What became of one of this seat's writes, by the opId it returned: queued until the editing machine rules it, then applied, or refused with its error.",
  list: `This seat's writes, newest first, each with its opId and state. --state keeps the queued or the refused ones; --limit is 1 to ${OP_LIST_MAX}, 50 when left out.`,
} as const;

const timeoutOption = Flag.integer("timeout").pipe(
  Flag.optional,
  Flag.withDescription(`Socket call timeout in ms (default ${DEFAULT_TIMEOUT_MS})`),
);

const call = (op: "op.show" | "op.list", args: unknown, timeout: Option.Option<number>) =>
  Effect.gen(function* () {
    const socket = yield* WorkSocket;
    return yield* socket.call(op, args, Option.getOrUndefined(timeout));
  });

const checked = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError((error) => new InputError({ message: error.message, hint: "junto schema show op.show or op.list shows the input" })),
  );

const showCommand = Command.make(
  "show",
  { opId: Argument.string("opId").pipe(Argument.withDescription("The opId a write returned")), timeout: timeoutOption },
  ({ opId, timeout }) =>
    executeJsonCommand(
      "op show",
      Effect.gen(function* () {
        const args = yield* checked(OpShowArgs, { opId: opId.trim() });
        return yield* call("op.show", args, timeout);
      }),
    ),
).pipe(Command.withDescription(DESCRIPTIONS.show));

const listCommand = Command.make(
  "list",
  {
    state: Flag.choice("state", OpListState.literals).pipe(Flag.optional, Flag.withDescription("Only the queued or only the refused writes")),
    limit: Flag.integer("limit").pipe(Flag.optional, Flag.withDescription(`How many, 1 to ${OP_LIST_MAX}`)),
    timeout: timeoutOption,
  },
  ({ state, limit, timeout }) =>
    executeJsonCommand(
      "op list",
      Effect.gen(function* () {
        const args = yield* checked(OpListArgs, {
          ...(Option.isSome(state) ? { state: state.value } : {}),
          ...(Option.isSome(limit) ? { limit: limit.value } : {}),
        });
        return yield* call("op.list", args, timeout);
      }),
    ),
).pipe(Command.withDescription(DESCRIPTIONS.list));

export const opCommand = Command.make("op").pipe(
  Command.withDescription("What became of this seat's resource writes, by opId."),
  Command.withSubcommands([showCommand, listCommand]),
);

// --- discovery ---------------------------------------------------------------

export const opSchemas: ReadonlyArray<CommandSchemaContract> = [
  { command_id: "op.show", command: "op show", schema_id: "op.show.input/v1", description: DESCRIPTIONS.show, schema: OpShowArgs },
  { command_id: "op.list", command: "op list", schema_id: "op.list.input/v1", description: DESCRIPTIONS.list, schema: OpListArgs },
];

export const opExamples: ReadonlyArray<CommandExample> = [
  {
    command_id: "op.show",
    command: "op show",
    name: "read what became of a write",
    description: "The opId is the one the write returned, or the one a Timeout named.",
    input: { opId: "01M5EW2K9M5CN3Z3VP1J5EFB0Y" },
    args: ["op", "show", "01M5EW2K9M5CN3Z3VP1J5EFB0Y"],
  },
  {
    command_id: "op.list",
    command: "op list",
    name: "list the writes the editing machine refused",
    description: "Each refusal carries its error; resend a fixed write with a new opId.",
    input: { state: "refused" },
    args: ["op", "list", "--state", "refused"],
  },
];

export const opCapabilities: ReadonlyArray<CommandCapability> = (["show", "list"] as const).map((verb) => ({
  command_id: `op.${verb}`,
  command: `op ${verb}`,
  category: "discovery",
  description: DESCRIPTIONS[verb],
  schemas: opSchemas.filter((schema) => schema.command_id === `op.${verb}`),
  examples: opExamples.filter((entry) => entry.command_id === `op.${verb}`),
}));
