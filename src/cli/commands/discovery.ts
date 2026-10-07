import { Argument, Command } from "effect/unstable/cli";
import { Effect } from "effect";
import { WORK_PROTOCOL_VERSION } from "../../shared/work-control";
import { CLI_NAME, CLI_VERSION } from "../core/constants";
import { allExamples, allSchemas, commandCapabilities, renderSchemaContract } from "../core/discovery";
import { InputError } from "../core/errors";
import { executeJsonCommand } from "../core/output";
export { pingCommand, doctorCommand, capabilitiesCommand, onboardCommand, offboardCommand } from "./seat-discovery";

const targetArg = Argument.string("target").pipe(
  Argument.withDescription("Schema id, command id, or command name"),
);

const matchesTarget = (
  target: string,
  entry: { readonly command_id: string; readonly command: string; readonly schema_id?: string },
) => {
  const normalized = target.trim();
  return (
    entry.command_id === normalized ||
    entry.command === normalized ||
    entry.schema_id === normalized
  );
};

const schemaListCommand = Command.make("list", {}, () =>
  executeJsonCommand(
    "schema list",
    Effect.succeed({
      schemas: allSchemas.map((schema) => ({
        command_id: schema.command_id,
        command: schema.command,
        schema_id: schema.schema_id,
        description: schema.description,
        accepts_batch: schema.accepts_batch ?? false,
      })),
    }),
  ),
).pipe(Command.withDescription("List JSON input schemas"));

const schemaShowCommand = Command.make("show", { target: targetArg }, ({ target }) =>
  executeJsonCommand(
    "schema show",
    Effect.gen(function* () {
      const schema = allSchemas.find((entry) => matchesTarget(target, entry));
      if (!schema) {
        return yield* Effect.fail(
          new InputError({ message: `No schema found for ${target}`, path: "target" }),
        );
      }
      return renderSchemaContract(schema);
    }),
  ),
).pipe(Command.withDescription("Show one JSON input schema"));

export const schemaCommand = Command.make("schema").pipe(
  Command.withDescription("Schema discovery"),
  Command.withSubcommands([schemaListCommand, schemaShowCommand]),
);

const examplesListCommand = Command.make("list", {}, () =>
  executeJsonCommand(
    "examples list",
    Effect.succeed({
      examples: allExamples.map((example) => ({
        command_id: example.command_id,
        command: example.command,
        name: example.name,
        ...(example.description ? { description: example.description } : {}),
      })),
    }),
  ),
).pipe(Command.withDescription("List executable examples"));

const examplesShowCommand = Command.make("show", { target: targetArg }, ({ target }) =>
  executeJsonCommand(
    "examples show",
    Effect.gen(function* () {
      const examples = allExamples.filter((entry) => matchesTarget(target, entry));
      const first = examples[0];
      if (!first) {
        return yield* Effect.fail(
          new InputError({ message: `No examples found for ${target}`, path: "target" }),
        );
      }
      return {
        command_id: first.command_id,
        command: first.command,
        examples: examples.map((example) => ({
          name: example.name,
          ...(example.description ? { description: example.description } : {}),
          ...(example.args ? { args: example.args } : {}),
          ...(example.input !== undefined ? { input: example.input } : {}),
        })),
      };
    }),
  ),
).pipe(Command.withDescription("Show examples for one command"));

export const examplesCommand = Command.make("examples").pipe(
  Command.withDescription("Example discovery"),
  Command.withSubcommands([examplesListCommand, examplesShowCommand]),
);

// Static CLI capability catalog (not live edges — use `capabilities` for that).
export const staticCapabilitiesData = {
  cli: { name: CLI_NAME, version: CLI_VERSION },
  protocol_version: WORK_PROTOCOL_VERSION,
  input_modes: ["inline-json", "@file", "stdin"],
  output: {
    success: { stream: "stdout", envelope: "{ ok: true, command, data }" },
    failure: { stream: "stderr", envelope: "{ ok: false, command, error }" },
  },
  batch: {
    outcome_values: ["succeeded", "partial_failure", "failed"],
    default_concurrency: 5,
    partial_failure_exit_code: 1,
  },
  commands: commandCapabilities,
};
