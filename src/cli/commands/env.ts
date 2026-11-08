import { Command, Flag } from "effect/cli";
import { Option, Schema } from "effect";
import type {
  CommandCapability,
  CommandExample,
  CommandSchemaContract,
} from "../core/discovery";
import { DEFAULT_TIMEOUT_MS } from "../core/constants";
import { executeReportCommand } from "../core/env-report";
import { EnvReport } from "../../contract/work/discovery";
import { callWorkRpc } from "../core/socket";

/**
 * `junto env report`: a seat reads its own region environment report.
 *
 * What this seat would launch with, from every region that contains it:
 * variable names, the kind of each source, the region it comes from, and
 * whether it could be read. Never a value. No arguments: the seat is the
 * calling process.
 */

const timeoutOption = Flag.Int("timeout").pipe(
  Flag.optional,
  Flag.withDescription(`Socket call timeout in ms (default ${DEFAULT_TIMEOUT_MS})`),
);

const DESCRIPTION =
  "What this seat launches with: variable names, sources, regions and status, never a value. Exits non-zero when a required source is missing.";

const envReportCommand = Command.make("report", { timeout: timeoutOption }, ({ timeout }) =>
  executeReportCommand(
    "env report",
    callWorkRpc(EnvReport, {}, Option.isSome(timeout) ? timeout.value : undefined),
  ),
).pipe(Command.withDescription(DESCRIPTION));

export const envCommand = Command.make("env").pipe(
  Command.withDescription("This seat's region environment"),
  Command.withSubcommands([envReportCommand]),
);

export const envReportSchema: CommandSchemaContract = {
  command_id: "env.report",
  command: "env report",
  schema_id: "env.report.input/v1",
  description: `${DESCRIPTION} Takes no input.`,
  schema: Schema.Struct({}),
};

export const envReportExamples: ReadonlyArray<CommandExample> = [
  {
    command_id: "env.report",
    command: "env report",
    name: "read this seat's environment report",
    description:
      "Run it when a variable you expect is not set. A source that changed since this seat started applies on restart.",
    input: {},
    args: ["env", "report"],
  },
];

export const envReportCapability: CommandCapability = {
  command_id: "env.report",
  command: "env report",
  category: "discovery",
  description: DESCRIPTION,
  schemas: [envReportSchema],
  examples: envReportExamples,
};
