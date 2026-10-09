import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Option, Schema } from "effect";
import type { WorkOpName } from "../../shared/work-control";
import type {
  CommandCapability,
  CommandExample,
  CommandSchemaContract,
} from "../core/discovery";
import { DEFAULT_TIMEOUT_MS } from "../core/constants";
import { executeJsonCommand } from "../core/output";
import { WorkSocket } from "../core/socket";

/**
 * `junto references list` and `junto references read <name>`: the operator's
 * references in this seat's scope, the app's and those of every region that
 * contains the seat. `junto onboard` names them; nothing sends them. The name
 * is a plain argument, not JSON. The seat is the calling process.
 */
const LIST_OP = "references.list" as WorkOpName;
const READ_OP = "references.read" as WorkOpName;

const timeoutOption = Flag.integer("timeout").pipe(
  Flag.optional,
  Flag.withDescription(`Socket call timeout in ms (default ${DEFAULT_TIMEOUT_MS})`),
);

const LIST_DESCRIPTION =
  "The references this seat can read: name, description, where each comes from, size and when it changed. Never a body.";
const READ_DESCRIPTION =
  "Read one reference by name. When a region and the app both have the name, the innermost region's is returned.";

const call = (op: WorkOpName, args: unknown, timeout: Option.Option<number>) =>
  Effect.gen(function* () {
    const socket = yield* WorkSocket;
    return yield* socket.call(op, args, Option.isSome(timeout) ? timeout.value : undefined);
  });

const referencesListCommand = Command.make("list", { timeout: timeoutOption }, ({ timeout }) =>
  executeJsonCommand("references list", call(LIST_OP, {}, timeout)),
).pipe(Command.withDescription(LIST_DESCRIPTION));

const referencesReadCommand = Command.make(
  "read",
  {
    name: Argument.string("name").pipe(
      Argument.withDescription("Reference name, as junto references list prints it"),
    ),
    timeout: timeoutOption,
  },
  ({ name, timeout }) => executeJsonCommand("references read", call(READ_OP, { name }, timeout)),
).pipe(Command.withDescription(READ_DESCRIPTION));

export const referencesCommand = Command.make("references").pipe(
  Command.withDescription("The operator's references this seat can read"),
  Command.withSubcommands([referencesListCommand, referencesReadCommand]),
);

export const referencesSchemas: ReadonlyArray<CommandSchemaContract> = [
  {
    command_id: "references.list",
    command: "references list",
    schema_id: "references.list.input/v1",
    description: `${LIST_DESCRIPTION} Takes no input.`,
    schema: Schema.Struct({}),
  },
  {
    command_id: "references.read",
    command: "references read",
    schema_id: "references.read.input/v1",
    description: `${READ_DESCRIPTION} The name is typed as a plain argument: junto references read <name>.`,
    schema: Schema.Struct({ name: Schema.String }),
  },
];

export const referencesExamples: ReadonlyArray<CommandExample> = [
  {
    command_id: "references.list",
    command: "references list",
    name: "list the references this seat can read",
    description: "Onboard names them too. Run this for sizes and for anything written since you onboarded.",
    input: {},
    args: ["references", "list"],
  },
  {
    command_id: "references.read",
    command: "references read",
    name: "read one reference",
    description: "Read a reference when the work in front of you calls for it, not before.",
    input: { name: "style" },
    args: ["references", "read", "style"],
  },
];

export const referencesCapabilities: ReadonlyArray<CommandCapability> = [
  {
    command_id: "references.list",
    command: "references list",
    category: "discovery",
    description: LIST_DESCRIPTION,
    schemas: [referencesSchemas[0]!],
    examples: [referencesExamples[0]!],
  },
  {
    command_id: "references.read",
    command: "references read",
    category: "discovery",
    description: READ_DESCRIPTION,
    schemas: [referencesSchemas[1]!],
    examples: [referencesExamples[1]!],
  },
];
