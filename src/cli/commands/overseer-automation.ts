import { Effect, Option, Schema } from "effect";
import { DEFAULT_AUTOMATION_LIMITS } from "../../shared/automation";
import {
  AutomationCreateCliArgs,
  AutomationEditCliArgs,
  AutomationOneCliArgs,
  type AutomationWriteOp,
} from "../../shared/automation-control";
import { ItemId } from "../../shared/work-ids";
import type { CommandExample } from "../core/discovery";
import type { InputError } from "../core/errors";
import { loadJsonInput } from "../core/json";
import { opIdOf } from "../core/op-id";

/**
 * `junto overseer automation create|edit|enable|disable|archive|run` (plan
 * 07): only the operator and overseers write automations. Each verb takes one
 * JSON object, inline, @file or - for stdin; this process mints the opId, or
 * takes --op-id to resend one that timed out. A create's automation id is its
 * opId, so a resend names the same automation.
 */

/** What each write takes from the command line; the wire adds the ids. */
export const AUTOMATION_WRITE_CLI_SCHEMAS: { readonly [Op in AutomationWriteOp]: Schema.Top } = {
  "automation.create": AutomationCreateCliArgs,
  "automation.edit": AutomationEditCliArgs,
  "automation.enable": AutomationOneCliArgs,
  "automation.disable": AutomationOneCliArgs,
  "automation.archive": AutomationOneCliArgs,
  "automation.run": AutomationOneCliArgs,
};

/** Until canvas C5 and remote R2 land the store and the ruler, every write is refused. */
const NOT_YET = ". Until the automation store and ruler ship, every write is refused not_available";

export const AUTOMATION_WRITE_DESCRIPTIONS: { readonly [Op in AutomationWriteOp]: string } = {
  "automation.create":
    "Create an automation on an Automations node: a schedule, poll or change trigger, conditions in when, and actions in then. It is created off unless enabled is true. Targets are @name, #<task number> or a junto:// link, at or below the node and in your reach" + NOT_YET,
  "automation.edit":
    "Change an automation. Each field in change replaces the stored one; when: [] clears the conditions. baseVersion is the version show printed; a stale one is refused" + NOT_YET,
  "automation.enable": "Turn an automation on" + NOT_YET,
  "automation.disable": "Turn an automation off. Its history stays" + NOT_YET,
  "automation.archive": "Archive an automation: it never fires again, and its history stays readable" + NOT_YET,
  "automation.run": "Fire an automation now, as its trigger would: its conditions are checked and its limits apply" + NOT_YET,
};

/** The wire args of one write: the input as given, with the ids filled in. */
export const automationWriteArgs = (
  operation: AutomationWriteOp,
  raw: string,
  opId: Option.Option<string>,
) =>
  Effect.gen(function* () {
    // Each schema here decodes without services; Schema.Top does not say so.
    const input: unknown = yield* (loadJsonInput(AUTOMATION_WRITE_CLI_SCHEMAS[operation], raw) as Effect.Effect<unknown, InputError>);
    const minted = yield* opIdOf(opId);
    if (operation !== "automation.create") return { ...(input as object), opId: minted };
    const draft = input as typeof AutomationCreateCliArgs.Type;
    return {
      ...draft,
      opId: minted,
      automationId: ItemId.make(minted),
      enabled: draft.enabled ?? false,
      limits: draft.limits ?? DEFAULT_AUTOMATION_LIMITS,
    };
  });

const example = (verb: string, name: string, description: string, input: unknown): CommandExample => ({
  command_id: `overseer.automation.${verb}`,
  command: `overseer automation ${verb}`,
  name,
  description,
  input,
  args: ["overseer", "automation", verb, JSON.stringify(input)],
});

export const overseerAutomationExamples: ReadonlyArray<CommandExample> = [
  example("create", "mail a seat every weekday morning", "Created off; enable it once show reads right.", {
    target: "Automations",
    name: "standup reminder",
    trigger: { kind: "schedule", cron: "0 9 * * 1-5", timezone: "America/Sao_Paulo" },
    then: [{ kind: "mail", to: "@cli-lead", text: "Standup in ten minutes" }],
  }),
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
  example("edit", "change the schedule", "baseVersion is the version junto automation show printed.", {
    target: "Automations",
    automation: "standup reminder",
    baseVersion: 3,
    change: { trigger: { kind: "schedule", cron: "30 9 * * 1-5", timezone: "America/Sao_Paulo" } },
  }),
  example("enable", "turn an automation on", "Off and on keep the definition and its history.", {
    target: "Automations",
    automation: "standup reminder",
  }),
];
