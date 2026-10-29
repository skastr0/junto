import { Effect, Option, Schema } from "effect";
import { ACTION_KIND_OFF, actionKindInBuild, AUTOMATION_VALUES, type CodeLanguage, DEFAULT_AUTOMATION_LIMITS } from "../../shared/automation";
import { DATE_PATTERN_WORDS, VALUE_FORMATS } from "../../shared/automation-formats";
import { VAULT_ENABLED } from "../../shared/features";
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
import { decodeJsonText, loadJsonInput } from "../core/json";
import { artifactLabelOf, foldArtifactLabels, notALabel } from "../../shared/artifact-labels";
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

// Code steps, the signal action and its secret form are said only where this build carries them (0.11 gates; the vault is 0.12).
const SIGNALS = actionKindInBuild("signal");
const CODE = actionKindInBuild("code");

/** The values each trigger carries, as the help says them (0.11, 05, A4), and the formats a value takes (0.11/09). */
export const VALUES_HELP = `Text in mail, prompt, comment and append-artifact actions, a new task's title${SIGNALS ? ", a new artifact's title and body, a signal's title, detail and artifact form title, and an answerTo document's title" : " and a new artifact's title and body"} may name values of what fired it: ${braced(AUTOMATION_VALUES.every)} on every trigger; ${braced(AUTOMATION_VALUES.task)} on a task change; ${braced(AUTOMATION_VALUES.artifact)} on an artifact change; ${braced(AUTOMATION_VALUES.seat)} on a seat change; ${braced(AUTOMATION_VALUES.signal)} on a signal${SIGNALS ? `; ${braced(AUTOMATION_VALUES.answered)} on an answered signal, and {{raised.<name>}} for any value the firing that raised it carried, such as {{raised.task.title}}` : ""}${CODE ? "; and after a code step, {{code.<field>}} for each field its output names" : ""}. A value may carry formats, applied left to right: {{fired.at|date:YYYY-MM-DD}} writes a time in a pattern of ${DATE_PATTERN_WORDS}, in the automation's time zone (its schedule's, else its machine's); |slug, |lower, |upper and |trim, as in {{task.title|slug}}. A format outside ${VALUE_FORMATS.join(", ")} is refused at save, and so is a value the trigger does not carry, naming the ones it does. A value is inserted as text, never read again`;

const SIGNAL_HELP = `A signal action {kind: signal, signal, title, detail?, show?, form?, id?, answerTo?} raises a signal in the operator's needs-you feed, from the automation, one per firing, never merged: escalate (a question, waiting on the operator), blocked, or feedback (asks for a review), each in the section a seat's would land in, or notice, only to read and clear. show names artifacts it opens. form, on escalate or blocked only, is what the operator answers in: {kind: text}, {kind: artifact, node, title?, labels?, minWords?} a document in that Artifacts node, titled from the signal unless named, of at least minWords, ${VAULT_ENABLED ? "{kind: secret, name} a region secret, " : ""}or {kind: proof}. answerTo, never on notice, is where the answer goes: {kind: seat, to: @seat} prompts the seat with the signal and the answer; {kind: document, node, title} makes a new document in that Artifacts node, its title naming the step's own values and, said when the answer comes, ${braced(AUTOMATION_VALUES.answered)}; {kind: append, to: <artifact>} appends a dated section. id names the step, 1 to 32 lower-case letters, digits and dashes, unique in the automation; a step with answerTo and no id gets one at save. A change watch {kind: answered, automation: {node, automationId}, step?, signal?} fires when the operator answers a signal that automation raised, on the same Automations node; step narrows to one signal step by its id, as junto automation show prints it (a step without one is given an id with automation edit first), and signal to escalate, blocked or feedback.${VAULT_ENABLED ? " A secret answer is never a value, only its name." : ""} `;
const CODE_HELP = `A code step {kind: code, language: typescript or shell, file: ./step.ts, timeoutMs?} runs the program on the automation's machine: this command stages the file into the content store and sends its ref as source, so the code never rides the command line; only the operator and overseers write code. `;

export const AUTOMATION_WRITE_DESCRIPTIONS: { readonly [Op in AutomationWriteOp]: string } = {
  "automation.create":
    `Create an automation on an Automations node: a schedule, poll or change trigger, conditions in when, and actions in then. It is created off unless enabled is true, and runs on the machine named by machine, its short name, or else on the machine that rules the create. Targets are @name, #<task number> or a junto:// link, at or below the node and in your reach. A prompt action {kind: prompt, to: @seat, text} asks the seat to act, as junto msg send --prompt does; mail only tells it. An artifact watch {kind: artifact, artifact: <ref> or {node}, event: edited, commented or labelled, label?} fires on labelled when an artifact gains label (or a level under it), created with it included. Artifact actions: create-artifact {node, title, body?, labels?} makes a document from markdown; append-artifact {to, text} adds markdown at a document's end; label-artifact {to, add?, remove?} changes its labels, never one label in both. Their to is an artifact, or {fired: true}, the one that fired an artifact trigger. Labels fold to lowercase. ${SIGNALS ? SIGNAL_HELP : ""}${CODE ? CODE_HELP : ""}${VALUES_HELP}`,
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
// Keyed by K1's languages, so one it adds fails tsc here, not a write at run time.
export const CODE_MEDIA_TYPES: Readonly<Record<CodeLanguage, string>> = { typescript: "text/typescript", shell: "text/x-shellscript" };

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
      if (!isRecord(step) || step.kind !== "code") continue;
      const at = stepsPath(operation, index);
      // Refused before its file is staged, worded as the save would word it.
      if (!CODE) return yield* Effect.fail(new InputError({ message: `${ACTION_KIND_OFF.code!.message}: ${ACTION_KIND_OFF.code!.next_step}`, path: `${at}.kind` }));
      if (step.file === undefined) continue;
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

/** One list of labels as typed, folded (trimmed, lowered, unique, sorted), or the first that cannot be one refused at its index. */
const foldLabelList = (raw: unknown, at: string): Effect.Effect<{ readonly folded: ReadonlyArray<string>; readonly raw: ReadonlyArray<string> } | undefined, InputError> =>
  Effect.gen(function* () {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) return yield* Effect.fail(new InputError({ message: "labels are a list", path: at }));
    const folded = foldArtifactLabels(raw);
    if (!folded.ok) return yield* Effect.fail(new InputError({ message: folded.message, path: folded.index === undefined ? at : `${at}[${folded.index}]` }));
    return { folded: folded.labels, raw: raw as ReadonlyArray<string> };
  });

/**
 * Every label a write names, folded as the store holds it (0.11, 05, B1): a
 * watch's label, a create-artifact's labels, and a label-artifact's add and
 * remove. One label in both add and remove is refused at its place in
 * remove, as the ruler refuses it at save.
 */
export const foldedLabels = (operation: AutomationWriteOp, input: unknown): Effect.Effect<unknown, InputError> =>
  Effect.gen(function* () {
    if (!isRecord(input)) return input;
    const edit = operation === "automation.edit";
    const holder = edit ? input.change : input;
    if (!isRecord(holder)) return input;
    const prefix = edit ? "change." : "";
    let next: Record<string, unknown> = { ...holder };
    const on = isRecord(holder.trigger) && holder.trigger.kind === "change" && isRecord(holder.trigger.on) ? holder.trigger.on : undefined;
    if (on !== undefined && on.kind === "artifact" && on.label !== undefined) {
      const label = typeof on.label === "string" ? artifactLabelOf(on.label) : undefined;
      if (label === undefined) {
        return yield* Effect.fail(new InputError({ message: notALabel(on.label), path: `${prefix}trigger.on.label` }));
      }
      next = { ...next, trigger: { ...(holder.trigger as Record<string, unknown>), on: { ...on, label } } };
    }
    if (Array.isArray(holder.then)) {
      const then: unknown[] = [];
      for (const [index, step] of holder.then.entries()) {
        const at = `${prefix}then[${index}]`;
        if (isRecord(step) && step.kind === "create-artifact") {
          const labels = yield* foldLabelList(step.labels, `${at}.labels`);
          then.push(labels === undefined ? step : { ...step, labels: labels.folded });
        } else if (isRecord(step) && step.kind === "label-artifact") {
          const add = yield* foldLabelList(step.add, `${at}.add`);
          const remove = yield* foldLabelList(step.remove, `${at}.remove`);
          const both = remove?.raw.findIndex((one) => add?.folded.includes(artifactLabelOf(one)!)) ?? -1;
          if (both >= 0) {
            return yield* Effect.fail(new InputError({
              message: `label ${artifactLabelOf(remove!.raw[both]!)} is both added and removed; name each label once`,
              path: `${at}.remove[${both}]`,
            }));
          }
          then.push({ ...step, ...(add === undefined ? {} : { add: add.folded }), ...(remove === undefined ? {} : { remove: remove.folded }) });
        } else {
          then.push(step);
        }
      }
      next = { ...next, then };
    }
    return edit ? { ...input, change: next } : next;
  });

/** Where an input came from, as an error names it: inline, stdin, or the file. */
const sourceOf = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed === "-" || trimmed === "@-") return "stdin";
  return trimmed.startsWith("@") ? trimmed.slice(1) : "inline";
};

/**
 * The input as given, its labels folded, each code file staged and named by
 * its ref; the rest untouched. The CLI schema takes a code step by file, so
 * the whole write is checked before anything is staged: one that would be
 * refused sends no bytes.
 */
export const stagedInput = (operation: AutomationWriteOp, raw: string) =>
  Effect.gen(function* () {
    // Each schema here decodes without services; Schema.Top does not say so.
    const parsed = yield* foldedLabels(operation, yield* loadJsonInput(Schema.Unknown, raw));
    const input: unknown = yield* (decodeJsonText(AUTOMATION_WRITE_CLI_SCHEMAS[operation], JSON.stringify(parsed), sourceOf(raw)) as Effect.Effect<unknown, InputError>);
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
  ...(CODE ? [example(
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
  )] : []),
  ...(SIGNALS ? [
    example(
      "create",
      "ask the operator for today's writing every morning",
      "An escalate waits in the needs-you feed until the operator answers it; the artifact form takes the answer as a document of at least minWords. show takes the brief's junto:// link, from junto artifact show; id names the step for an answered watch.",
      {
        target: "Automations",
        name: "daily writing",
        trigger: { kind: "schedule", cron: "0 8 * * *", timezone: "America/Sao_Paulo" },
        then: [
          {
            kind: "signal",
            id: "writing",
            signal: "escalate",
            title: "Write 500 words",
            detail: "Today's writing, raised at {{fired.at}}. The brief opens from the signal.",
            show: ["junto://canvas/factory?node=artifacts-01M5G0BJD8MBEJG2QVX5VM6DJ0&item=01M5ESMQ2ZT55QZ073EWPH10SG"],
            form: { kind: "artifact", node: "Writing", title: "Writing {{fired.at|date:YYYY-MM-DD}}", minWords: 500 },
          },
        ],
      },
    ),
    example(
      "create",
      "ask the operator to review a task in review, and send the answer to a seat",
      "Each firing raises its own feedback signal; feedback takes no form. When the operator answers, the seat is prompted with the signal's title and the answer, as it would hear the answer to its own.",
      {
        target: "Automations",
        name: "operator review",
        trigger: { kind: "change", on: { kind: "task", task: { node: "Release" }, becomes: "in-review" } },
        then: [
          {
            kind: "signal",
            signal: "feedback",
            title: "Review {{task.title}}",
            detail: "{{task.assignee}} asks for a review: {{task.link}}",
            answerTo: { kind: "seat", to: "@cli-lead" },
          },
        ],
      },
    ),
    example(
      "create",
      "when the morning writing is answered, file a review and prompt a seat",
      "An answered watch names the raising automation by its node and id (junto automation list), and step its signal step by id. The title is formatted at firing time; {{raised.fired.at}} is when the raising firing ran.",
      {
        target: "Automations",
        name: "review the writing",
        enabled: true,
        trigger: {
          kind: "change",
          on: { kind: "answered", automation: { node: "Automations", automationId: "01M5ESM1XHCJ7JYJDBC37MREBZ" }, step: "writing" },
        },
        then: [
          { kind: "create-artifact", node: "Reviews", title: "Review {{fired.at|date:YYYY-MM-DD}}", body: "{{answer.text}}\n\n{{answer.link}}" },
          { kind: "prompt", to: "@product-verify", text: "{{signal.title}}, raised {{raised.fired.at}}, was answered: {{answer.link}}" },
        ],
      },
    ),
  ] : []),
  example(
    "create",
    "when a document is labelled review, log it and move it on",
    "{fired: true} is the artifact that gained the label; labels fold to lowercase.",
    {
      target: "Automations",
      name: "review intake",
      trigger: { kind: "change", on: { kind: "artifact", artifact: { node: "Shelf" }, event: "labelled", label: "review" } },
      then: [
        { kind: "append-artifact", to: { fired: true }, text: "\n\nQueued for review at {{fired.at}}." },
        { kind: "label-artifact", to: { fired: true }, add: ["in-review"], remove: ["review"] },
        { kind: "prompt", to: "@product-verify", text: "{{artifact.title}} ({{artifact.link}}) is ready for review." },
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
