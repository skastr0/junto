// V4: Args→Argument, Options→Flag. Map: ../effect-v4-import-map.ts
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Option, Schema } from "effect";
import {
  ContentMaterializeArgs,
  ContentPathArgs,
  ContentStatArgs,
  type WorkOpName,
} from "../../shared/work-control";
import { DEFAULT_TIMEOUT_MS } from "../core/constants";
import { loadJsonInput } from "../core/json";
import { executeJsonCommand } from "../core/output";
import { WorkSocket } from "../core/socket";

const jsonInputArg = Argument.string("input").pipe(
  Argument.withDescription("JSON object, @file path, raw JSON string, or - for stdin"),
);

const timeoutOption = Flag.integer("timeout").pipe(
  Flag.optional,
  Flag.withDescription(`Socket call timeout in ms (default ${DEFAULT_TIMEOUT_MS})`),
);

const toUndefined = <A>(value: Option.Option<A>): A | undefined =>
  Option.isSome(value) ? value.value : undefined;

const callContent = <S extends Schema.Top>(
  op: WorkOpName,
  schema: S,
  input: string,
  timeout: number | undefined,
) =>
  Effect.gen(function* () {
    const args = yield* loadJsonInput(schema, input);
    const socket = yield* WorkSocket;
    return yield* socket.call(op, args, timeout);
  });

const contentPathCommand = Command.make(
  "path",
  { input: jsonInputArg, timeout: timeoutOption },
  ({ input, timeout }) =>
    executeJsonCommand(
      "content path",
      callContent("content.path", ContentPathArgs, input, toUndefined(timeout)),
    ),
).pipe(Command.withDescription("Resolve an authorized task ContentRef to its canonical local path"));

const contentStatCommand = Command.make(
  "stat",
  { input: jsonInputArg, timeout: timeoutOption },
  ({ input, timeout }) =>
    executeJsonCommand(
      "content stat",
      callContent("content.stat", ContentStatArgs, input, toUndefined(timeout)),
    ),
).pipe(Command.withDescription("Read availability and local path metadata for an authorized task ContentRef"));

const contentMaterializeCommand = Command.make(
  "materialize",
  { input: jsonInputArg, timeout: timeoutOption },
  ({ input, timeout }) =>
    executeJsonCommand(
      "content materialize",
      callContent(
        "content.materialize",
        ContentMaterializeArgs,
        input,
        toUndefined(timeout),
      ),
    ),
).pipe(Command.withDescription("Copy an authorized task ContentRef into its Junto task workspace"));

export const contentCommand = Command.make("content").pipe(
  Command.withDescription("Authorized task content access"),
  Command.withSubcommands([
    contentPathCommand,
    contentStatCommand,
    contentMaterializeCommand,
  ]),
);
