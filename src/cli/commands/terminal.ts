import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import { InputError } from "../core/errors";
import {
  executeJsonCommand,
  setExitCode,
  writeFailureEnvelope,
} from "../core/output";
import {
  TerminalSocket,
  type TerminalStreamFrame,
} from "../core/terminal-socket";

const bindingIdArg = Args.text({ name: "bindingId" }).pipe(
  Args.withDescription("Stable local terminal binding id"),
);

const dataArg = Args.text({ name: "data" }).pipe(
  Args.withDescription("Exact UTF-8 bytes to write to the PTY"),
);

const colsOption = Options.integer("cols").pipe(
  Options.optional,
  Options.withDescription("Terminal columns (20-300)"),
);

const rowsOption = Options.integer("rows").pipe(
  Options.optional,
  Options.withDescription("Terminal rows (5-120)"),
);

const toUndefined = <A>(value: Option.Option<A>): A | undefined =>
  Option.isSome(value) ? value.value : undefined;

const requireText = (
  value: string,
  path: string,
  maximumBytes = 512,
): Effect.Effect<string, InputError> =>
  Effect.gen(function* () {
    if (
      value.length === 0 ||
      value !== value.trim() ||
      /[\u0000-\u001f\u007f]/u.test(value) ||
      Buffer.byteLength(value, "utf8") > maximumBytes
    ) {
      return yield* Effect.fail(
        new InputError({
          message: `${path} must be non-empty canonical text`,
          path,
        }),
      );
    }
    return value;
  });

const terminalSize = (
  cols: Option.Option<number>,
  rows: Option.Option<number>,
): Effect.Effect<
  { readonly cols?: number; readonly rows?: number },
  InputError
> =>
  Effect.gen(function* () {
    const resolvedCols = toUndefined(cols);
    const resolvedRows = toUndefined(rows);
    if (
      resolvedCols !== undefined &&
      (!Number.isSafeInteger(resolvedCols) ||
        resolvedCols < 20 ||
        resolvedCols > 300)
    ) {
      return yield* Effect.fail(
        new InputError({
          message: "cols must be an integer from 20 through 300",
          path: "cols",
        }),
      );
    }
    if (
      resolvedRows !== undefined &&
      (!Number.isSafeInteger(resolvedRows) ||
        resolvedRows < 5 ||
        resolvedRows > 120)
    ) {
      return yield* Effect.fail(
        new InputError({
          message: "rows must be an integer from 5 through 120",
          path: "rows",
        }),
      );
    }
    return {
      ...(resolvedCols === undefined ? {} : { cols: resolvedCols }),
      ...(resolvedRows === undefined ? {} : { rows: resolvedRows }),
    };
  });

export const renderTerminalStreamEnvelope = (
  frame: TerminalStreamFrame,
): string =>
  JSON.stringify({
    ok: true,
    command: "terminal attach",
    data: frame,
  });

const writeTerminalStreamFrame = (
  frame: TerminalStreamFrame,
): void => {
  process.stdout.write(`${renderTerminalStreamEnvelope(frame)}\n`);
};

const createCommand = Command.make(
  "create",
  {
    bindingId: Options.text("binding-id"),
    cols: colsOption,
    rows: rowsOption,
  },
  ({ bindingId, cols, rows }) =>
    executeJsonCommand(
      "terminal create",
      Effect.gen(function* () {
        const exactBindingId = yield* requireText(
          bindingId,
          "binding-id",
        );
        const size = yield* terminalSize(cols, rows);
        const socket = yield* TerminalSocket;
        return yield* socket.create({
          bindingId: exactBindingId,
          ...size,
        });
      }),
    ),
).pipe(
  Command.withDescription(
    "Create a local geography terminal with the user's login shell",
  ),
);

const createProjectedAgentCommand = Command.make(
  "create",
  {
    canvasName: Options.text("canvas"),
    nodeId: Options.text("node"),
    cols: colsOption,
    rows: rowsOption,
  },
  ({ canvasName, nodeId, cols, rows }) =>
    executeJsonCommand(
      "terminal agent create",
      Effect.gen(function* () {
        const exactCanvasName = yield* requireText(
          canvasName,
          "canvas",
          128,
        );
        const exactNodeId = yield* requireText(nodeId, "node");
        const size = yield* terminalSize(cols, rows);
        const socket = yield* TerminalSocket;
        return yield* socket.createProjectedAgent({
          canvasName: exactCanvasName,
          nodeId: exactNodeId,
          ...size,
        });
      }),
    ),
).pipe(
  Command.withDescription(
    "Start one managed agent resolved from the active Remote projection",
  ),
);

const agentCommand = Command.make("agent").pipe(
  Command.withDescription("Projected managed-agent terminal operations"),
  Command.withSubcommands([createProjectedAgentCommand]),
);

const listCommand = Command.make("list", {}, () =>
  executeJsonCommand(
    "terminal list",
    Effect.gen(function* () {
      const socket = yield* TerminalSocket;
      return yield* socket.list;
    }),
  ),
).pipe(Command.withDescription("List local Vellum Command terminal sessions"));

const getCommand = Command.make(
  "get",
  { bindingId: bindingIdArg },
  ({ bindingId }) =>
    executeJsonCommand(
      "terminal get",
      Effect.gen(function* () {
        const exactBindingId = yield* requireText(bindingId, "bindingId");
        const socket = yield* TerminalSocket;
        return (yield* socket.get(exactBindingId)) ?? null;
      }),
    ),
).pipe(Command.withDescription("Read one local terminal session"));

const killCommand = Command.make(
  "kill",
  { bindingId: bindingIdArg },
  ({ bindingId }) =>
    executeJsonCommand(
      "terminal kill",
      Effect.gen(function* () {
        const exactBindingId = yield* requireText(bindingId, "bindingId");
        const socket = yield* TerminalSocket;
        const killed = yield* socket.kill(exactBindingId);
        if (!killed) yield* setExitCode(1);
        return { bindingId: exactBindingId, killed };
      }),
    ),
).pipe(Command.withDescription("Stop one Vellum Command-owned terminal"));

const writeCommand = Command.make(
  "write",
  { bindingId: bindingIdArg, data: dataArg },
  ({ bindingId, data }) =>
    executeJsonCommand(
      "terminal write",
      Effect.gen(function* () {
        const exactBindingId = yield* requireText(bindingId, "bindingId");
        if (Buffer.byteLength(data, "utf8") > 1024 * 1024) {
          return yield* Effect.fail(
            new InputError({
              message: "terminal write data exceeds 1 MiB",
              path: "data",
            }),
          );
        }
        const socket = yield* TerminalSocket;
        const written = yield* socket.write(exactBindingId, data);
        if (!written) yield* setExitCode(1);
        return { bindingId: exactBindingId, written };
      }),
    ),
).pipe(Command.withDescription("Write exact UTF-8 data to one terminal"));

const resizeCommand = Command.make(
  "resize",
  {
    bindingId: bindingIdArg,
    cols: Options.integer("cols"),
    rows: Options.integer("rows"),
  },
  ({ bindingId, cols, rows }) =>
    executeJsonCommand(
      "terminal resize",
      Effect.gen(function* () {
        const exactBindingId = yield* requireText(bindingId, "bindingId");
        const size = yield* terminalSize(
          Option.some(cols),
          Option.some(rows),
        );
        const socket = yield* TerminalSocket;
        const resized = yield* socket.resize(
          exactBindingId,
          size.cols!,
          size.rows!,
        );
        if (!resized) yield* setExitCode(1);
        return {
          bindingId: exactBindingId,
          cols: size.cols,
          rows: size.rows,
          resized,
        };
      }),
    ),
).pipe(Command.withDescription("Resize one terminal PTY"));

const attachCommand = Command.make(
  "attach",
  { bindingId: bindingIdArg },
  ({ bindingId }) =>
    Effect.gen(function* () {
      const exactBindingId = yield* requireText(bindingId, "bindingId");
      const socket = yield* TerminalSocket;
      yield* socket.attach(exactBindingId, writeTerminalStreamFrame);
    }).pipe(
      Effect.catchAll((error) =>
        setExitCode(1).pipe(
          Effect.zipRight(
            writeFailureEnvelope("terminal attach", error),
          ),
        ),
      ),
    ),
).pipe(
  Command.withDescription(
    "Stream owner-local terminal output, resize, session, and exit frames as NDJSON",
  ),
);

export const terminalCommand = Command.make("terminal").pipe(
  Command.withDescription("Owner-local Vellum Command terminal controls"),
  Command.withSubcommands([
    createCommand,
    agentCommand,
    listCommand,
    getCommand,
    attachCommand,
    writeCommand,
    resizeCommand,
    killCommand,
  ]),
);
