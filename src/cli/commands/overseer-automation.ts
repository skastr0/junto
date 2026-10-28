import { Effect, Option, Schema } from "effect";
import { AUTOMATION_VALUES, DEFAULT_AUTOMATION_LIMITS } from "../../shared/automation";
import {
  AutomationCreateCliArgs,
  AutomationEditCliArgs,
  AutomationMoveCliArgs,
  AutomationOneCliArgs,
  type AutomationWriteOp,
} from "../../shared/automation-control";
import { ItemId } from "../../shared/work-ids";
import type { ContentRef } from "../../shared/content";
import { stageFile } from "../core/content-stage";
import type { CommandExample } from "../core/discovery";
import { InputError } from "../core/errors";
import { loadJsonInput } from "../core/json";
import { opIdOf } from "../core/op-id";

/**
 * `junto overseer automation create|edit|enable|disable|archive|run` (plan
 * 07): only the operator and overseers write automations. Each verb takes one
 * JSON object, inline, @file or - for stdin; this process mints the opId, or
 * takes --op-id to resend one that timed out. A create's automation id is its
 * opId, so a resend names the same automation.
 *
 * A code step (0.11, 05, K4) may name its program by `file`: this process
 * stages the file into the content store and sends the step with its ref as
 * `source`, so code never rides a command line or the socket as text.
 */

/** What each write takes from the command line; the wire adds the ids. */
export const AUTOMATION_WRITE_CLI_SCHEMAS: { readonly [Op in AutomationWriteOp]: Schema.Top } = {
  "automation.create": AutomationCreateCliArgs,
  "automation.edit": AutomationEditCliArgs,
  "automation.enable": AutomationOneCliArgs,
  "automation.disable": AutomationOneCliArgs,
  "automation.move": AutomationMoveCliArgs,
  "automation.archive": AutomationOneCliArgs,
  "automation.run": AutomationOneCliArgs,
};

const braced = (names: ReadonlyArray<string>) => names.map((name) => `{{${name}}}`).join(", ");

/** The values each trigger carries, as the help says them (0.11, 05, A4). */
export const VALUES_HELP = `Text in mail, prompt and comment actions, and a new task's title, may name values of what fired it: ${braced(AUTOMATION_VALUES.every)} on every trigger; ${braced(AUTOMATION_VALUES.task)} on a task change; ${braced(AUTOMATION_VALUES.artifact)} on an artifact change; ${braced(AUTOMATION_VALUES.seat)} on a seat change; ${braced(AUTOMATION_VALUES.signal)} on a signal; and after a code step, {{code.<field>}} for each field its output names. A value the trigger does not carry is refused at save, naming the ones it does. A value is inserted as text, never read again`;

export const AUTOMATION_WRITE_DESCRIPTIONS: { readonly [Op in AutomationWriteOp]: string } = {
  "automation.create":
    `Create an automation on an Automations node: a schedule, poll or change trigger, conditions in when, and actions in then. It is created off unless enabled is true, and runs on the machine named by machine, its short name, or else on the machine that rules the create. Targets are @name, #<task number> or a junto:// link, at or below the node and in your reach. A prompt action {kind: prompt, to: @seat, text} asks the seat to act, as junto msg send --prompt does; mail only tells it. A code step {kind: code, language: typescript or shell, file: ./step.ts, timeoutMs?} runs the program on the automation's machine: this command stages the file into the content store and sends its ref as source, so the code never rides the command line; only the operator and overseers write code. ${VALUES_HELP}`,
  "automation.edit":
    `Change an automation. Each field in change replaces the stored one; when: [] clears the conditions. baseVersion is the version show printed; a stale one is refused. Values in text are checked against the trigger as stored after the change. ${VALUES_HELP}`,
  "automation.enable": "Turn an automation on",
  "automation.disable": "Turn an automation off. Its history stays",
  "automation.move":
    "Run an automation on another machine, named by its short name: that machine fires its schedules, hears its changes and performs its actions from now on. No baseVersion: a move is never an edit, and never goes stale",
  "automation.archive": "Archive an automation: it never fires again, and its history stays readable",
  "automation.run": "Fire an automation now, as its trigger would: its conditions are checked and its limits apply",
};

/** How the content store names a code step's bytes, by its language. */
export const CODE_MEDIA_TYPES = { typescript: "text/typescript", shell: "text/x-shellscript" } as const;

type CodeFile = { readonly index: number; readonly file: string; readonly mediaType: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Where a write's steps sit: a create's `then`, an edit's `change.then`. */
const stepsOf = (operation: AutomationWriteOp, input: unknown): ReadonlyArray<unknown> | undefined => {
  if (!isRecord(input)) return undefined;
  const holder = operation === "automation.create" ? input : operation === "automation.edit" ? input.change : undefined;
  return isRecord(holder) && Array.isArray(holder.then) ? holder.then : undefined;
};

const stepsPath = (operation: AutomationWriteOp, index: number) =>
  operation === "automation.edit" ? `change.then[${index}]` : `then[${index}]`;

/** The code steps that name a file, each checked: a known language, and `file` or `source`, not both. */
export const codeFilesOf = (operation: AutomationWriteOp, input: unknown): Effect.Effect<ReadonlyArray<CodeFile>, InputError> =>
  Effect.gen(function* () {
    const files: CodeFile[] = [];
    const steps = stepsOf(operation, input) ?? [];
    for (const [index, step] of steps.entries()) {
      if (!isRecord(step) || step.kind !== "code" || step.file === undefined) continue;
      const at = stepsPath(operation, index);
      if (typeof step.file !== "string" || step.file.length === 0) {
        return yield* Effect.fail(new InputError({ message: "file is the path of the step's program", path: `${at}.file` }));
      }
      if ("source" in step) {
        return yield* Effect.fail(new InputError({ message: "a code step names its program by file or by source, not both", path: `${at}.file` }));
      }
      const mediaType = CODE_MEDIA_TYPES[step.language as keyof typeof CODE_MEDIA_TYPES];
      if (mediaType === undefined) {
        return yield* Effect.fail(new InputError({
          message: `language is one of ${Object.keys(CODE_MEDIA_TYPES).join(", ")}`,
          path: `${at}.language`,
        }));
      }
      files.push({ index, file: step.file, mediaType });
    }
    return files;
  });

/** The input with each file step's `file` swapped for `source`, the ref it was staged as. */
export const withSources = (
  operation: AutomationWriteOp,
  input: unknown,
  sources: ReadonlyMap<number, ContentRef>,
): unknown => {
  if (sources.size === 0) return input;
  const then = (stepsOf(operation, input) ?? []).map((step, index) => {
    const source = sources.get(index);
    if (source === undefined || !isRecord(step)) return step;
    const { file: _file, ...rest } = step;
    return { ...rest, source };
  });
  const record = input as Record<string, unknown>;
  return operation === "automation.edit"
    ? { ...record, change: { ...(record.change as Record<string, unknown>), then } }
    : { ...record, then };
};

/**
 * The input as given, each code file staged and named by its ref; the rest
 * untouched. The CLI schema takes a code step by file, so the whole write is
 * checked before anything is staged: one that would be refused sends no bytes.
 */
export const stagedInput = (operation: AutomationWriteOp, raw: string) =>
  Effect.gen(function* () {
    // Each schema here decodes without services; Schema.Top does not say so.
    const input: unknown = yield* (loadJsonInput(AUTOMATION_WRITE_CLI_SCHEMAS[operation], raw) as Effect.Effect<unknown, InputError>);
    const files = yield* codeFilesOf(operation, input);
    const sources = new Map<number, ContentRef>();
    for (const one of files) sources.set(one.index, yield* stageFile(one.file, { mediaType: one.mediaType }));
    return withSources(operation, input, sources);
  });

/** The wire args of one write: the input as given, code files staged, with the ids filled in. */
export const automationWriteArgs = (
  operation: AutomationWriteOp,
  raw: string,
  opId: Option.Option<string>,
) =>
  Effect.gen(function* () {
    const input = yield* stagedInput(operation, raw);
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
    "prompt a seat when a task on a board is done, naming the task",
    "{{task.title}} and {{task.link}} are the task that fired it; a prompt asks the seat to act.",
    {
      target: "Automations",
      name: "verify what is done",
      trigger: { kind: "change", on: { kind: "task", task: { node: "Release" }, becomes: "done" } },
      then: [{ kind: "prompt", to: "@product-verify", text: "{{task.title}} is done ({{task.link}}), check it in the real app." }],
    },
  ),
  example(
    "create",
    "check a service every ten minutes in code, and mail what it found",
    "The file is staged into the content store and sent as source; {{code.status}} is a field of its output.",
    {
      target: "Automations",
      name: "service check",
      trigger: { kind: "poll", everyMs: 600_000 },
      then: [
        { kind: "code", language: "typescript", file: "./check-service.ts", timeoutMs: 30_000 },
        { kind: "mail", to: "@tech-lead", text: "service check at {{fired.at}}: {{code.status}}" },
      ],
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
  example("edit", "change the schedule", "baseVersion is the version junto automation show printed.", {
    target: "Automations",
    automation: "standup reminder",
    baseVersion: 3,
    change: { trigger: { kind: "schedule", cron: "30 9 * * 1-5", timezone: "America/Sao_Paulo" } },
  }),
  example("move", "run an automation on the mini", "The new machine starts from the move; no missed slot fires.", {
    target: "Automations",
    automation: "standup reminder",
    machine: "mini",
  }),
  example("enable", "turn an automation on", "Off and on keep the definition and its history.", {
    target: "Automations",
    automation: "standup reminder",
  }),
];
