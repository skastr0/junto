// V4: Args→Argument, Options→Flag. Map: ../effect-v4-import-map.ts
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Option } from "effect";
import { SheetReadArgs } from "../../shared/work-control";
import { DEFAULT_TIMEOUT_MS } from "../core/constants";
import { loadJsonInput } from "../core/json";
import { executeJsonCommand } from "../core/output";
import { WorkSocket } from "../core/socket";

const toUndefined = <A>(value: Option.Option<A>) =>
  Option.isSome(value) ? value.value : undefined;

const jsonInputArg = Argument.string("input").pipe(
  Argument.withDescription("JSON object, @file path, raw JSON string, or - for stdin"),
);

const timeoutOption = Flag.integer("timeout").pipe(
  Flag.optional,
  Flag.withDescription(`Socket call timeout in ms (default ${DEFAULT_TIMEOUT_MS})`),
);

const sheetReadCommand = Command.make(
  "read",
  { input: jsonInputArg, timeout: timeoutOption },
  ({ input, timeout }) =>
    executeJsonCommand(
      "sheet read",
      Effect.gen(function* () {
        const item = yield* loadJsonInput(SheetReadArgs, input);
        const socket = yield* WorkSocket;
        return yield* socket.call("sheet.read", item, toUndefined(timeout));
      }),
    ),
).pipe(
  Command.withDescription(
    "Read a connected sheet (grant sheet.read): columns, rows, and a markdown table. Sheets are operator-authored — there is no write port.",
  ),
);

export const sheetCommand = Command.make("sheet").pipe(
  Command.withDescription(
    "Sheet ops — read the operator's grid; agents never write a sheet",
  ),
  Command.withSubcommands([sheetReadCommand]),
);
