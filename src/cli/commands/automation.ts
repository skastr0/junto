import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Option, Schema } from "effect";
import {
  AutomationHistoryArgs,
  AutomationListArgs,
  AutomationShowArgs,
  type AutomationReadOp,
} from "../../shared/automation-control";
import type {
  CommandCapability,
  CommandExample,
  CommandSchemaContract,
} from "../core/discovery";
import { DEFAULT_TIMEOUT_MS } from "../core/constants";
import { loadJsonInput } from "../core/json";
import { executeJsonCommand } from "../core/output";
import { WorkSocket } from "../core/socket";

/**
 * `junto automation` (plan 07): list, show and history over the Automations
 * nodes in this seat's reach. Each verb takes one JSON object, inline, @file
 * or - for stdin. Seats read automations and write none: the operator and
 * overseers write them with `junto overseer automation`.
 */

const inputArg = Argument.string("input").pipe(
  Argument.withDescription("JSON object, @file path, or - for stdin"),
);

const timeoutOption = Flag.integer("timeout").pipe(
  Flag.optional,
  Flag.withDescription(`Socket call timeout in ms (default ${DEFAULT_TIMEOUT_MS})`),
);

const call = (op: AutomationReadOp, args: unknown, timeout: Option.Option<number>) =>
  Effect.gen(function* () {
    const socket = yield* WorkSocket;
    return yield* socket.call(op, args, Option.getOrUndefined(timeout));
  });

const DESCRIPTIONS = {
  list: "The automations on every Automations node in this seat's reach, or on the one named by target.",
  show: "One automation, with the version an edit names.",
  history: "Firings of one automation, or of every automation on the node, newest first: fired with each action's ruling, interrupted, or skipped and why.",
} as const satisfies Record<string, string>;

type Verb = keyof typeof DESCRIPTIONS;

const read = (verb: Verb, schema: Schema.Top, input: string, timeout: Option.Option<number>) =>
  executeJsonCommand(
    `automation ${verb}`,
    Effect.gen(function* () {
      const args = yield* loadJsonInput(schema, input);
      return yield* call(`automation.${verb}`, args, timeout);
    }),
  );

const listCommand = Command.make(
  "list",
  { input: inputArg.pipe(Argument.optional), timeout: timeoutOption },
  ({ input, timeout }) => read("list", AutomationListArgs, Option.getOrElse(input, () => "{}"), timeout),
).pipe(Command.withDescription(DESCRIPTIONS.list));

const readCommand = (verb: "show" | "history", schema: Schema.Top) =>
  Command.make(verb, { input: inputArg, timeout: timeoutOption }, ({ input, timeout }) => read(verb, schema, input, timeout)).pipe(
    Command.withDescription(DESCRIPTIONS[verb]),
  );

export const automationCommand = Command.make("automation").pipe(
  Command.withDescription("Read the automations in this seat's reach; the operator and overseers write them"),
  Command.withSubcommands([
    listCommand,
    readCommand("show", AutomationShowArgs),
    readCommand("history", AutomationHistoryArgs),
  ]),
);

// --- discovery ---------------------------------------------------------------

const SCHEMAS: { readonly [V in Verb]: Schema.Top } = {
  list: AutomationListArgs,
  show: AutomationShowArgs,
  history: AutomationHistoryArgs,
};

const VERBS = Object.keys(SCHEMAS) as ReadonlyArray<Verb>;

export const automationSchemas: ReadonlyArray<CommandSchemaContract> = VERBS.map((verb) => ({
  command_id: `automation.${verb}`,
  command: `automation ${verb}`,
  schema_id: `automation.${verb}.input/v1`,
  description: DESCRIPTIONS[verb],
  schema: SCHEMAS[verb],
  input_modes: ["inline-json", "@file", "stdin"],
}));

const example = (verb: Verb, name: string, description: string, input: unknown): CommandExample => ({
  command_id: `automation.${verb}`,
  command: `automation ${verb}`,
  name,
  description,
  input,
  args: ["automation", verb, JSON.stringify(input)],
});

export const automationExamples: ReadonlyArray<CommandExample> = [
  example("list", "list the automations in reach", "Names no node, so every Automations node in this seat's reach.", {}),
  example("show", "read one automation", "Its version is what an overseer's edit names.", {
    target: "Automations",
    automation: "standup reminder",
  }),
  example("history", "read the latest firings", "Skipped firings say why: a condition, a limit, or a target out of reach.", {
    target: "Automations",
    automation: "standup reminder",
    limit: 20,
  }),
];

export const automationCapabilities: ReadonlyArray<CommandCapability> = VERBS.map((verb) => ({
  command_id: `automation.${verb}`,
  command: `automation ${verb}`,
  category: "discovery",
  description: DESCRIPTIONS[verb],
  schemas: automationSchemas.filter((schema) => schema.command_id === `automation.${verb}`),
  examples: automationExamples.filter((entry) => entry.command_id === `automation.${verb}`),
}));
