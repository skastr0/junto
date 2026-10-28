import { Effect, Option, Schema } from "effect";
import { DEFAULT_AUTOMATION_LIMITS } from "../../shared/automation";
import {
  AutomationCreateCliArgs,
  AutomationEditCliArgs,
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
  "automation.archive": AutomationOneCliArgs,
  "automation.run": AutomationOneCliArgs,
};

export const AUTOMATION_WRITE_DESCRIPTIONS: { readonly [Op in AutomationWriteOp]: string } = {
  "automation.create":
    "Create an automation on an Automations node: a schedule, poll or change trigger, conditions in when, and actions in then. It is created off unless enabled is true. Targets are @name, #<task number> or a junto:// link, at or below the node and in your reach",
  "automation.edit":
    "Change an automation. Each field in change replaces the stored one; when: [] clears the conditions. baseVersion is the version show printed; a stale one is refused",
  "automation.enable": "Turn an automation on",
  "automation.disable": "Turn an automation off. Its history stays",
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

/** Stands in for a staged ref while the write is checked, so a write that would be refused stages nothing. */
const placeholder = (mediaType: string): ContentRef => ({ sha256: "0".repeat(64), byteLength: 0, mediaType }) as ContentRef;

const decodeInput = (schema: Schema.Top, value: unknown) =>
  (Schema.decodeUnknownEffect(schema as Schema.Codec<unknown, unknown>, { onExcessProperty: "error" })(value) as Effect.Effect<unknown, Schema.SchemaError>).pipe(
    Effect.mapError((error) => new InputError({ message: error.message, path: "input" })),
  );

/** The input as given, each code file staged and named by its ref; the rest untouched. */
export const stagedInput = (operation: AutomationWriteOp, raw: string) =>
  Effect.gen(function* () {
    const schema = AUTOMATION_WRITE_CLI_SCHEMAS[operation];
    const parsed: unknown = yield* loadJsonInput(Schema.Unknown, raw);
    const files = yield* codeFilesOf(operation, parsed);
    if (files.length === 0) return yield* decodeInput(schema, parsed);
    yield* decodeInput(schema, withSources(operation, parsed, new Map(files.map((one) => [one.index, placeholder(one.mediaType)]))));
    const sources = new Map<number, ContentRef>();
    for (const one of files) sources.set(one.index, yield* stageFile(one.file, { mediaType: one.mediaType }));
    return yield* decodeInput(schema, withSources(operation, parsed, sources));
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
