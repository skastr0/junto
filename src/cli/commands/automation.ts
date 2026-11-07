import { Argument, Command, Flag } from "effect/cli";
import { Effect, Option, Schema } from "effect";
import type { Rpc } from "effect/rpc";
import {
  AutomationHistoryArgs,
  AutomationListArgs,
  AutomationShowArgs,
} from "../../shared/automation-control";
import { AutomationHistory, AutomationList, AutomationShow } from "../../contract/work/skill";
import type {
  CommandCapability,
  CommandExample,
  CommandSchemaContract,
} from "../core/discovery";
import { DEFAULT_TIMEOUT_MS } from "../core/constants";
import type { AuthError, InputError, RuntimeDown, WireError } from "../core/errors";
import { loadJsonInput } from "../core/json";
import { executeJsonCommand } from "../core/output";
import { type WorkSocket, callWorkRpc } from "../core/socket";

/**
 * `junto automation` (plan 07): list, show and history over the Automations
 * nodes in this seat's reach. Each verb takes one JSON object, inline, @file
 * or - for stdin. Seats read automations and write none: the operator and
 * overseers write them with `junto overseer automation`.
 */

const inputArg = Argument.String("input").pipe(
  Argument.withDescription("JSON object, @file path, or - for stdin"),
);

const timeoutOption = Flag.Int("timeout").pipe(
  Flag.optional,
  Flag.withDescription(`Socket call timeout in ms (default ${DEFAULT_TIMEOUT_MS})`),
);

/** Automations are kept on the machine that edits the canvas, so a read anywhere else is refused. */
const ON_EDITOR = " Answered only on the machine that edits the canvas; elsewhere it is refused not_available, naming that machine.";

const DESCRIPTIONS = {
  list: `The automations on every Automations node in this seat's reach, or on the one named by target.${ON_EDITOR}`,
  show: `One automation, with the version an edit names.${ON_EDITOR}`,
  history: `Firings of one automation, or of every automation on the node, newest first: fired with each action's ruling, interrupted, or skipped and why.${ON_EDITOR}`,
} as const satisfies Record<string, string>;

type Verb = keyof typeof DESCRIPTIONS;

/** One verb's call: its input decoded by the op's own arguments, then sent. */
const readWith = <R extends typeof AutomationList | typeof AutomationShow | typeof AutomationHistory>(
  rpc: R,
  input: string,
  timeout: Option.Option<number>,
) =>
  Effect.flatMap(loadJsonInput(rpc.payloadSchema, input), (args) =>
    callWorkRpc(rpc, args as Rpc.Payload<R>, Option.getOrUndefined(timeout)));

type AutomationReadAnswer = Rpc.Success<typeof AutomationList> | Rpc.Success<typeof AutomationShow> | Rpc.Success<typeof AutomationHistory>;

/** One read as main answers it; a refusal comes back as main's error, next_step included. */
export const automationRead = (
  verb: Verb,
  input: string,
  timeout: Option.Option<number>,
): Effect.Effect<AutomationReadAnswer, InputError | RuntimeDown | AuthError | WireError, WorkSocket> => {
  switch (verb) {
    case "list":
      return readWith(AutomationList, input, timeout);
    case "show":
      return readWith(AutomationShow, input, timeout);
    case "history":
      return readWith(AutomationHistory, input, timeout);
  }
};

const read = (verb: Verb, input: string, timeout: Option.Option<number>) =>
  executeJsonCommand(`automation ${verb}`, automationRead(verb, input, timeout));

const listCommand = Command.make(
  "list",
  { input: inputArg.pipe(Argument.optional), timeout: timeoutOption },
  ({ input, timeout }) => read("list", Option.getOrElse(input, () => "{}"), timeout),
).pipe(Command.withDescription(DESCRIPTIONS.list));

const readCommand = (verb: "show" | "history") =>
  Command.make(verb, { input: inputArg, timeout: timeoutOption }, ({ input, timeout }) => read(verb, input, timeout)).pipe(
    Command.withDescription(DESCRIPTIONS[verb]),
  );

export const automationCommand = Command.make("automation").pipe(
  Command.withDescription(
    "Read the automations in this seat's reach; the operator and overseers write them. Both work only on the machine that edits the canvas",
  ),
  Command.withSubcommands([
    listCommand,
    readCommand("show"),
    readCommand("history"),
  ]),
);

// --- discovery ---------------------------------------------------------------

export const AUTOMATION_READ_SCHEMAS: { readonly [V in Verb]: Schema.Top } = {
  list: AutomationListArgs,
  show: AutomationShowArgs,
  history: AutomationHistoryArgs,
};

const VERBS = Object.keys(AUTOMATION_READ_SCHEMAS) as ReadonlyArray<Verb>;

export const automationSchemas: ReadonlyArray<CommandSchemaContract> = VERBS.map((verb) => ({
  command_id: `automation.${verb}`,
  command: `automation ${verb}`,
  schema_id: `automation.${verb}.input/v1`,
  description: DESCRIPTIONS[verb],
  schema: AUTOMATION_READ_SCHEMAS[verb],
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
