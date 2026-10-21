import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Option, Schema } from "effect";
import { DEFAULT_AUTOMATION_LIMITS } from "../../shared/automation";
import {
  AutomationCreateCliArgs,
  AutomationEditCliArgs,
  AutomationHistoryArgs,
  AutomationListArgs,
  AutomationOneCliArgs,
  AutomationShowArgs,
  type AutomationOp,
} from "../../shared/automation-control";
import { mintItemId, mintOpId } from "../../shared/resource-command";
import { OpId } from "../../shared/work-ids";
import type {
  CommandCapability,
  CommandExample,
  CommandSchemaContract,
} from "../core/discovery";
import { DEFAULT_TIMEOUT_MS } from "../core/constants";
import { InputError } from "../core/errors";
import { loadJsonInput } from "../core/json";
import { executeJsonCommand } from "../core/output";
import { WorkSocket } from "../core/socket";

/**
 * `junto automation` (plan 07): list, show, create, edit, enable, disable,
 * run and history over the Automations nodes in this seat's reach. Each verb
 * takes one JSON object, inline, @file or - for stdin. Targets inside it are
 * text (`@name`, `#42`, a `junto://` link); main resolves them. A write mints
 * its opId here, or takes --op-id to retry one, and create mints the
 * automation's id.
 */

const inputArg = Argument.string("input").pipe(
  Argument.withDescription("JSON object, @file path, or - for stdin"),
);

const timeoutOption = Flag.integer("timeout").pipe(
  Flag.optional,
  Flag.withDescription(`Socket call timeout in ms (default ${DEFAULT_TIMEOUT_MS})`),
);

const opIdOption = Flag.string("op-id").pipe(
  Flag.optional,
  Flag.withDescription("Resend a write that timed out with the opId it returned, so it applies once"),
);

const call = (op: AutomationOp, args: unknown, timeout: Option.Option<number>) =>
  Effect.gen(function* () {
    const socket = yield* WorkSocket;
    return yield* socket.call(op, args, Option.getOrUndefined(timeout));
  });

const opIdOf = (given: Option.Option<string>) =>
  Option.match(given, {
    onNone: () => Effect.succeed(mintOpId()),
    onSome: (text) =>
      Schema.decodeUnknownEffect(OpId)(text).pipe(
        Effect.mapError(() => new InputError({ message: "--op-id must be the ULID a write returned", path: "--op-id", received: text })),
      ),
  });

const DESCRIPTIONS = {
  list: "The automations on every Automations node in this seat's reach, or on the one named by target.",
  show: "One automation, with the version an edit names.",
  create:
    "Create an automation on an Automations node: a schedule, poll or change trigger, conditions in when, and actions in then. It is created off unless enabled is true. Targets are @name, #<task number> or a junto:// link, at or below the node and in this seat's reach.",
  edit:
    "Change an automation. Each field in change replaces the stored one; when: [] clears the conditions. baseVersion is the version show printed; a stale one is refused.",
  enable: "Turn an automation on.",
  disable: "Turn an automation off. Its history stays.",
  run: "Fire an automation now, as its trigger would: its conditions are checked and its limits apply.",
  history: "Firings of one automation, or of every automation on the node, newest first: fired with each action's ruling, or skipped and why.",
} as const satisfies Record<string, string>;

type Verb = keyof typeof DESCRIPTIONS;

const read = (verb: "list" | "show" | "history", schema: Schema.Top, input: string, timeout: Option.Option<number>) =>
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

const createCommand = Command.make(
  "create",
  { input: inputArg, opId: opIdOption, timeout: timeoutOption },
  ({ input, opId, timeout }) =>
    executeJsonCommand(
      "automation create",
      Effect.gen(function* () {
        const draft = yield* loadJsonInput(AutomationCreateCliArgs, input);
        return yield* call("automation.create", {
          ...draft,
          opId: yield* opIdOf(opId),
          automationId: mintItemId(),
          enabled: draft.enabled ?? false,
          limits: draft.limits ?? DEFAULT_AUTOMATION_LIMITS,
        }, timeout);
      }),
    ),
).pipe(Command.withDescription(DESCRIPTIONS.create));

const writeCommand = (verb: "edit" | "enable" | "disable" | "run", schema: Schema.Top) =>
  Command.make(
    verb,
    { input: inputArg, opId: opIdOption, timeout: timeoutOption },
    ({ input, opId, timeout }) =>
      executeJsonCommand(
        `automation ${verb}`,
        Effect.gen(function* () {
          const args = yield* loadJsonInput(schema, input);
          return yield* call(`automation.${verb}`, { ...(args as object), opId: yield* opIdOf(opId) }, timeout);
        }),
      ),
  ).pipe(Command.withDescription(DESCRIPTIONS[verb]));

export const automationCommand = Command.make("automation").pipe(
  Command.withDescription("Automations in this seat's reach: schedules, polls and changes that mail, create and assign tasks, and comment"),
  Command.withSubcommands([
    listCommand,
    readCommand("show", AutomationShowArgs),
    createCommand,
    writeCommand("edit", AutomationEditCliArgs),
    writeCommand("enable", AutomationOneCliArgs),
    writeCommand("disable", AutomationOneCliArgs),
    writeCommand("run", AutomationOneCliArgs),
    readCommand("history", AutomationHistoryArgs),
  ]),
);

// --- discovery ---------------------------------------------------------------

const SCHEMAS: { readonly [V in Verb]: Schema.Top } = {
  list: AutomationListArgs,
  show: AutomationShowArgs,
  create: AutomationCreateCliArgs,
  edit: AutomationEditCliArgs,
  enable: AutomationOneCliArgs,
  disable: AutomationOneCliArgs,
  run: AutomationOneCliArgs,
  history: AutomationHistoryArgs,
};

const VERBS = Object.keys(SCHEMAS) as ReadonlyArray<Verb>;
const WRITES: ReadonlySet<Verb> = new Set(["create", "edit", "enable", "disable", "run"]);

export const automationSchemas: ReadonlyArray<CommandSchemaContract> = VERBS.map((verb) => ({
  command_id: `automation.${verb}`,
  command: `automation ${verb}`,
  schema_id: `automation.${verb}.input/v1`,
  description: WRITES.has(verb)
    ? `${DESCRIPTIONS[verb]} Returns applied with the new version, or queued with the opId while the editing machine is away.`
    : DESCRIPTIONS[verb],
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
  example(
    "create",
    "mail a seat every weekday morning",
    "Created off; enable it once show reads right.",
    {
      target: "Automations",
      name: "standup reminder",
      trigger: { kind: "schedule", cron: "0 9 * * 1-5", timezone: "America/Sao_Paulo" },
      then: [{ kind: "mail", to: "@cli-lead", text: "Standup in ten minutes" }],
    },
  ),
  example(
    "create",
    "open a review task when a seat goes idle",
    "A change trigger fires on the transition; when holds the states that must be true as it fires.",
    {
      target: "Automations",
      name: "review after work",
      enabled: true,
      trigger: { kind: "change", on: { kind: "seat", seat: "@cli-external", becomes: "idle" } },
      when: [{ kind: "task", task: { node: "CLI tasks" }, becomes: "in-review", holds: true }],
      then: [{ kind: "create-task", node: "CLI tasks", title: "Review the latest commits", assign: "@cli-overseer" }],
      limits: { minIntervalMs: 600_000, maxPerHour: 4 },
    },
  ),
  example(
    "edit",
    "change the schedule",
    "baseVersion is the version show printed.",
    {
      target: "Automations",
      automation: "standup reminder",
      baseVersion: "3",
      change: { trigger: { kind: "schedule", cron: "30 9 * * 1-5", timezone: "America/Sao_Paulo" } },
    },
  ),
  example("enable", "turn an automation on", "Off and on keep the definition and its history.", {
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
  category: WRITES.has(verb) ? "workflow" : "discovery",
  description: DESCRIPTIONS[verb],
  schemas: automationSchemas.filter((schema) => schema.command_id === `automation.${verb}`),
  examples: automationExamples.filter((entry) => entry.command_id === `automation.${verb}`),
}));
